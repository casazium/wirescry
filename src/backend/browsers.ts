import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserInfo } from '../shared/api';

/** A browser found on this machine. */
export interface DetectedBrowser extends BrowserInfo {
  executable: string;
}

interface Candidate {
  id: string;
  name: string;
  kind: BrowserInfo['kind'];
  mac: string[];
  windows: string[];
  linux: string[];
}

const CHROMIUM_BROWSERS: Candidate[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    kind: 'chromium',
    mac: ['Google Chrome.app/Contents/MacOS/Google Chrome'],
    windows: ['Google/Chrome/Application/chrome.exe'],
    linux: ['google-chrome', 'google-chrome-stable'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    kind: 'chromium',
    mac: ['Chromium.app/Contents/MacOS/Chromium'],
    windows: ['Chromium/Application/chrome.exe'],
    linux: ['chromium', 'chromium-browser'],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    kind: 'chromium',
    mac: ['Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    windows: ['Microsoft/Edge/Application/msedge.exe'],
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
  },
  {
    id: 'brave',
    name: 'Brave',
    kind: 'chromium',
    mac: ['Brave Browser.app/Contents/MacOS/Brave Browser'],
    windows: ['BraveSoftware/Brave-Browser/Application/brave.exe'],
    linux: ['brave-browser', 'brave'],
  },
  {
    id: 'firefox',
    name: 'Firefox',
    kind: 'firefox',
    mac: [
      'Firefox.app/Contents/MacOS/firefox',
      'Firefox Developer Edition.app/Contents/MacOS/firefox',
      'Firefox Nightly.app/Contents/MacOS/firefox',
    ],
    windows: ['Mozilla Firefox/firefox.exe', 'Firefox Developer Edition/firefox.exe'],
    linux: ['firefox', 'firefox-esr', 'firefox-developer-edition'],
  },
];

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs(platform: NodeJS.Platform): string[] {
  const env = process.env;
  if (platform === 'darwin') {
    return ['/Applications', path.join(os.homedir(), 'Applications')];
  }
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((dir): dir is string =>
      Boolean(dir),
    );
  }
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/** Finds installed Chrome-family browsers and Firefox. */
export async function detectBrowsers(platform = process.platform): Promise<DetectedBrowser[]> {
  const dirs = searchDirs(platform);
  const found: DetectedBrowser[] = [];
  for (const candidate of CHROMIUM_BROWSERS) {
    const relativePaths =
      platform === 'darwin' ? candidate.mac : platform === 'win32' ? candidate.windows : candidate.linux;
    search: for (const dir of dirs) {
      for (const relative of relativePaths) {
        const executable = path.join(dir, relative);
        if (await isExecutable(executable)) {
          found.push({ id: candidate.id, name: candidate.name, kind: candidate.kind, executable });
          break search;
        }
      }
    }
  }
  return found;
}

export interface ChromiumLaunchOptions {
  proxyPort: number;
  spkiFingerprint: string;
  profileDir: string;
  startUrl?: string;
}

/** Command-line flags that send a fresh Chromium profile through the proxy. */
export function chromiumArgs(options: ChromiumLaunchOptions): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    `--proxy-server=127.0.0.1:${options.proxyPort}`,
    // By default Chromium skips the proxy for localhost. '<-loopback>' removes that rule.
    '--proxy-bypass-list=<-loopback>',
    // Trust our CA for this profile only. Chromium honours this only with a custom --user-data-dir.
    `--ignore-certificate-errors-spki-list=${options.spkiFingerprint}`,
    // Keep traffic on TCP (HTTP/1.1 or HTTP/2) so the proxy can see it.
    '--disable-quic',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    options.startUrl ?? 'https://example.com/',
  ];
}

/** Launches the browser with a temporary profile, removed when the browser exits. */
export async function launchChromium(
  browser: DetectedBrowser,
  options: Omit<ChromiumLaunchOptions, 'profileDir'>,
): Promise<void> {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-profile-'));
  const child = spawn(browser.executable, chromiumArgs({ ...options, profileDir }), {
    stdio: 'ignore',
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    // It never started, so nothing will remove the profile on exit.
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  child.once('exit', () => {
    // Chromium may still be releasing files for a moment after exit.
    setTimeout(() => {
      rm(profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }, 1000);
  });
}
