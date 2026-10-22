import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectedBrowser } from './browsers';
import { SETUP_HOST } from './setup-page';

/**
 * Firefox has no command-line flag to trust a certificate, so Leverframe keeps one
 * Firefox profile in its data folder. The user trusts the CA in it once, and later
 * launches reuse it.
 */
export const FIREFOX_PROFILE_DIR = 'firefox-profile';
/** Holds the SPKI fingerprint of the CA this profile is known to trust. */
const TRUST_MARKER = 'leverframe-trusted-ca';

/** Prefs written to the profile's user.js on every launch. */
export function firefoxPrefs(proxyPort: number): string {
  const prefs: Record<string, string | number | boolean> = {
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': proxyPort,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': proxyPort,
    'network.proxy.no_proxies_on': '',
    // Send localhost through the proxy too.
    'network.proxy.allow_hijacking_localhost': true,
    // Keep traffic off HTTP/3 (QUIC), which the proxy can't see.
    'network.http.http3.enable': false,
    // Trust only certificates in this profile, not the operating system's store.
    'security.enterprise_roots.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
  };
  return (
    '// Written by Leverframe on every launch. Changes here are overwritten.\n' +
    Object.entries(prefs)
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
      .join('\n') +
    '\n'
  );
}

export async function isProfileTrusted(profileDir: string, spkiFingerprint: string): Promise<boolean> {
  try {
    return (await readFile(path.join(profileDir, TRUST_MARKER), 'utf8')).trim() === spkiFingerprint;
  } catch {
    return false;
  }
}

export async function markProfileTrusted(profileDir: string, spkiFingerprint: string): Promise<void> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(profileDir, TRUST_MARKER), spkiFingerprint + '\n');
}

/** Removes the profile, including any trust in an old CA. Used when the CA is reset. */
export async function deleteFirefoxProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true, maxRetries: 3 });
}

export interface FirefoxLaunchOptions {
  profileDir: string;
  proxyPort: number;
  spkiFingerprint: string;
}

/** Launches Firefox with the Leverframe profile, opening setup if it doesn't trust the CA yet. */
export async function launchFirefox(browser: DetectedBrowser, options: FirefoxLaunchOptions): Promise<void> {
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(options.profileDir, 'user.js'), firefoxPrefs(options.proxyPort));
  const trusted = await isProfileTrusted(options.profileDir, options.spkiFingerprint);
  const startUrl = trusted ? 'https://example.com/' : `http://${SETUP_HOST}/`;

  // If Firefox is already running with this profile, this opens the URL there instead.
  const child = spawn(browser.executable, ['--profile', options.profileDir, startUrl], {
    stdio: 'ignore',
    detached: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}
