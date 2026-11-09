import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Settings {
  /** Fixed proxy port. Unset means pick a free one automatically. */
  proxyPort?: number;
  /** false: don't set up Docker containers. Unset means on. */
  dockerSetup?: boolean;
  /** false: no Android setup (Setup's Android section and ADB). Unset means on. Set by hand. */
  androidSetup?: boolean;
  /**
   * true: set up Docker on Windows, which releases leave off until it's been tested hands-on with
   * Docker Desktop. Set by hand in settings.json, for that test.
   */
  experimentalWindowsDocker?: boolean;
  /** The adb to start the ADB server with, if not found the usual way. An absolute path. */
  adbPath?: string;
}

const FILE = 'settings.json';

export function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535;
}

/** Reads settings, ignoring a missing or damaged file and any invalid values. */
export async function loadSettings(dir: string): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, FILE), 'utf8')) as Record<string, unknown>;
    return {
      ...(isValidPort(raw.proxyPort) ? { proxyPort: raw.proxyPort } : {}),
      ...(raw.dockerSetup === false ? { dockerSetup: false } : {}),
      ...(raw.androidSetup === false ? { androidSetup: false } : {}),
      ...(raw.experimentalWindowsDocker === true ? { experimentalWindowsDocker: true } : {}),
      ...(typeof raw.adbPath === 'string' && path.isAbsolute(raw.adbPath) && raw.adbPath.length < 1000
        ? { adbPath: raw.adbPath }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Writes settings atomically, so a crash mid-write can't leave a broken file. */
export async function saveSettings(dir: string, settings: Settings): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
