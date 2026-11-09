/**
 * The updater (src/main/updater.ts), with Electron and electron-updater stood in for: when it
 * checks, what it tells the user, and how it installs. Its decisions are in update-policy.ts,
 * tested in update-policy.test.ts.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  isPackaged: true,
  version: '0.1.19',
  /** The answers the user gives to message boxes, in turn (the button's index). */
  answers: [] as number[],
  shown: [] as Array<{ type: string; message: string; detail: string; buttons: string[] }>,
  home: '',
  calls: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return fake.isPackaged;
    },
    getVersion: () => fake.version,
  },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      const options = args.at(-1) as { type: string; message: string; detail: string; buttons: string[] };
      fake.shown.push(options);
      return { response: fake.answers.shift() ?? options.buttons.length - 1 };
    },
  },
}));

vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeAutoUpdater extends Emitter {
    logger: unknown;
    requestHeaders: Record<string, string> | undefined;
    isUserWithinRollout: (() => boolean) | undefined;
    autoDownload = false;
    autoInstallOnAppQuit = false;
    checks = 0;
    async checkForUpdates() {
      this.checks++;
      fake.calls.push('check');
      return null;
    }
    quitAndInstall() {
      fake.calls.push('quitAndInstall');
    }
  }
  return { autoUpdater: new FakeAutoUpdater() };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fake.home, default: { ...actual, homedir: () => fake.home } };
});

const { autoUpdater } = (await import('electron-updater')) as unknown as {
  autoUpdater: EventEmitter & {
    requestHeaders?: Record<string, string>;
    isUserWithinRollout?: () => boolean;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    checks: number;
    stagingUserIdPromise?: { value: Promise<string> };
  };
};
const { Updater } = await import('../src/main/updater');
const { FIRST_CHECK_DELAY_MS, NO_STAGING_ID, UPDATE_INTERVAL_MS } = await import('../src/main/update-policy');

const logged: string[] = [];
const logger = {
  write: (_source: string, level: string, message: string) => void logged.push(`${level}: ${message}`),
};

beforeEach(async () => {
  fake.isPackaged = true;
  fake.version = '0.1.19';
  fake.answers = [];
  fake.shown = [];
  fake.calls = [];
  fake.home = await mkdtemp(path.join(os.tmpdir(), 'wirescry-updater-home-'));
  logged.length = 0;
  autoUpdater.removeAllListeners();
  autoUpdater.checks = 0;
  vi.stubEnv('WIRESCRY_DISABLE_UPDATES', undefined);
  // Linux only updates an AppImage; the update cache goes under the fake home everywhere.
  vi.stubEnv('APPIMAGE', '/tmp/Wirescry.AppImage');
  vi.stubEnv('XDG_CACHE_HOME', path.join(fake.home, '.cache'));
  vi.stubEnv('LOCALAPPDATA', path.join(fake.home, 'AppData', 'Local'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(fake.home, { recursive: true, force: true });
});

const updater = (beforeInstall?: () => Promise<void>) =>
  new Updater(logger as never, () => undefined, beforeInstall);
/** Lets queued promises (message boxes, installs) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('The updater, turned off', () => {
  it('doesn’t check in a build that isn’t packaged, and says why when asked', async () => {
    vi.useFakeTimers();
    fake.isPackaged = false;
    const u = updater();
    expect(u.enabled).toBe(false);
    u.start();
    await vi.advanceTimersByTimeAsync(2 * UPDATE_INTERVAL_MS);
    expect(autoUpdater.checks).toBe(0);
    expect(logged).toContain('info: Update checks off: not a packaged build');
    u.checkNow();
    await vi.runAllTimersAsync();
    expect(fake.shown).toEqual([
      expect.objectContaining({
        type: 'info',
        message: "This copy of Wirescry doesn't update itself.",
        detail: 'Reason: not a packaged build.',
      }),
    ]);
    expect(autoUpdater.checks).toBe(0);
  });

  it('doesn’t check when WIRESCRY_DISABLE_UPDATES is set', async () => {
    vi.useFakeTimers();
    vi.stubEnv('WIRESCRY_DISABLE_UPDATES', '1');
    const u = updater();
    u.start();
    await vi.advanceTimersByTimeAsync(2 * UPDATE_INTERVAL_MS);
    expect(autoUpdater.checks).toBe(0);
    expect(logged).toContain('info: Update checks off: WIRESCRY_DISABLE_UPDATES is set');
  });
});

describe('The updater', () => {
  it('sends no per-install id, downloads by itself, and installs on quit', async () => {
    updater();
    expect(autoUpdater.requestHeaders).toEqual({ 'x-user-staging-id': NO_STAGING_ID });
    expect(autoUpdater.isUserWithinRollout?.()).toBe(true);
    expect(await autoUpdater.stagingUserIdPromise?.value).toBe(NO_STAGING_ID);
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('checks shortly after starting, then every few hours, not before', async () => {
    vi.useFakeTimers();
    updater().start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(autoUpdater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(autoUpdater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checks).toBe(2);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(autoUpdater.checks).toBe(3);
  });

  it('says nothing about a background check, whatever it finds', async () => {
    updater();
    autoUpdater.emit('update-not-available');
    autoUpdater.emit('update-available', { version: '0.1.20' });
    autoUpdater.emit(
      'error',
      Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }),
    );
    await settle();
    expect(fake.shown).toEqual([]);
  });

  it('answers Check for Updates: up to date, available, or why it couldn’t check', async () => {
    const u = updater();
    // After each answer, a background check's result: only the check that was asked for is answered.
    const background = () => autoUpdater.emit('update-not-available');
    u.checkNow();
    expect(autoUpdater.checks).toBe(1);
    autoUpdater.emit('update-not-available');
    background();
    u.checkNow();
    autoUpdater.emit('update-available', { version: '0.1.20' });
    background();
    u.checkNow();
    autoUpdater.emit('error', new Error('No published versions on GitHub'));
    background();
    u.checkNow();
    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    background();
    await settle();
    expect(fake.shown.map(({ type, message }) => [type, message])).toEqual([
      ['info', 'Wirescry is up to date.'],
      ['info', 'Wirescry 0.1.20 is available.'],
      // Nothing published yet is the same as up to date.
      ['info', 'Wirescry is up to date.'],
      ['error', "Couldn't check for updates."],
    ]);
    expect(fake.shown[0]!.detail).toBe('You have version 0.1.19.');
    expect(fake.shown[3]!.detail).toMatch(/couldn't reach the update server/);
  });

  it('installs when asked to restart, after its own clean-up (putting devices back)', async () => {
    const beforeInstall = vi.fn(async () => void fake.calls.push('beforeInstall'));
    const u = updater(beforeInstall);
    fake.answers = [0];
    autoUpdater.emit('update-downloaded', { version: '0.1.20' });
    await vi.waitFor(() => expect(fake.calls).toContain('quitAndInstall'), { timeout: 5000 });
    expect(fake.shown[0]).toMatchObject({
      message: 'Wirescry 0.1.20 is ready to install.',
      buttons: ['Restart Now', 'Later'],
    });
    expect(fake.calls).toEqual(['beforeInstall', 'quitAndInstall']);
    expect(u.installing).toBe(true);
  });

  it('still installs if its clean-up fails', async () => {
    const u = updater(async () => {
      throw new Error('a device is gone');
    });
    fake.answers = [0];
    autoUpdater.emit('update-downloaded', { version: '0.1.20' });
    await vi.waitFor(() => expect(fake.calls).toContain('quitAndInstall'), { timeout: 5000 });
    expect(u.installing).toBe(true);
  });

  it('leaves it for the next quit when told Later, and asks once however often it downloads', async () => {
    const beforeInstall = vi.fn(async () => undefined);
    const u = updater(beforeInstall);
    fake.answers = [1];
    autoUpdater.emit('update-downloaded', { version: '0.1.20' });
    autoUpdater.emit('update-downloaded', { version: '0.1.20' });
    await settle();
    expect(fake.shown).toHaveLength(1);
    expect(fake.calls).not.toContain('quitAndInstall');
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(u.installing).toBe(false);
    // Asked again for the next download, once the first prompt was answered.
    fake.answers = [1];
    autoUpdater.emit('update-downloaded', { version: '0.1.21' });
    await settle();
    expect(fake.shown).toHaveLength(2);
  });

  it('stops counting as installing when the install fails, or 15 seconds later', async () => {
    vi.useFakeTimers();
    const u = updater();
    fake.answers = [0, 0];
    autoUpdater.emit('update-downloaded', { version: '0.1.20' });
    await vi.advanceTimersByTimeAsync(0);
    expect(u.installing).toBe(true);
    autoUpdater.emit('error', new Error('install failed'));
    expect(u.installing).toBe(false);

    // A second try, 10 seconds on: the first try's 15 seconds don't cut it short.
    await vi.advanceTimersByTimeAsync(10_000);
    autoUpdater.emit('update-downloaded', { version: '0.1.20' });
    await vi.advanceTimersByTimeAsync(0);
    expect(u.installing).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(u.installing).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.installing).toBe(false);
  });
});

describe('The updater’s download cache', () => {
  const pendingDir = () =>
    path.join(
      process.platform === 'darwin'
        ? path.join(fake.home, 'Library', 'Caches')
        : process.platform === 'win32'
          ? process.env.LOCALAPPDATA!
          : process.env.XDG_CACHE_HOME!,
      'wirescry-updater',
      'pending',
    );
  const pending = async (fileName: string) => {
    await mkdir(pendingDir(), { recursive: true });
    await writeFile(path.join(pendingDir(), 'update-info.json'), JSON.stringify({ fileName }));
    await writeFile(path.join(pendingDir(), fileName), 'installer');
  };

  /** Starts an updater, with its check timers faked so none outlive the test, and waits for its clean-up. */
  const startAndPrune = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    const u = updater();
    u.start();
    await u.pruned;
  };

  it('deletes the download of the version now running', async () => {
    await pending('Wirescry-0.1.19-arm64-mac.zip');
    await startAndPrune();
    expect(existsSync(pendingDir())).toBe(false);
    expect(logged).toContain("info: Removed the installed update's download (Wirescry-0.1.19-arm64-mac.zip)");
  });

  it('keeps a download of a newer version', async () => {
    await pending('Wirescry-0.1.20-arm64-mac.zip');
    await startAndPrune();
    expect(existsSync(path.join(pendingDir(), 'Wirescry-0.1.20-arm64-mac.zip'))).toBe(true);
    expect(existsSync(path.join(pendingDir(), 'update-info.json'))).toBe(true);
  });

  it('leaves alone a download it can’t make sense of, and copes with none', async () => {
    await pending('Wirescry-0.1.19-arm64-mac.zip');
    await writeFile(path.join(pendingDir(), 'update-info.json'), '{ not json');
    await startAndPrune();
    expect(existsSync(path.join(pendingDir(), 'Wirescry-0.1.19-arm64-mac.zip'))).toBe(true);

    await rm(pendingDir(), { recursive: true, force: true });
    await expect(startAndPrune()).resolves.toBeUndefined();
    expect(logged.filter((line) => line.includes('Removed'))).toEqual([]);
  });
});
