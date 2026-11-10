/**
 * What the Setup page's Open buttons run (src/backend/terminals.ts, browsers.ts, firefox.ts),
 * with spawn replaced so nothing actually opens. test/terminal.test.ts opens real shells on
 * Windows; this checks the commands, files and settings on every platform.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Spawned {
  command: string;
  args: string[];
  options: Record<string, unknown> & { env?: NodeJS.ProcessEnv };
  child: EventEmitter & { unref: () => void; unrefCalled: boolean };
}
const spawned: Spawned[] = [];
/** How the next spawn goes: it starts, or fails as a missing program does. */
let spawnFails = false;

vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((command: string, args: string[], options: Spawned['options']) => {
      const child = Object.assign(new EventEmitter(), {
        unrefCalled: false,
        unref() {
          child.unrefCalled = true;
        },
      });
      spawned.push({ command, args, options, child });
      const fails = spawnFails;
      setImmediate(() =>
        fails
          ? child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }))
          : child.emit('spawn'),
      );
      return child;
    }),
  };
});

const { childEnv, launchTerminal, posixStartScript, detectTerminals } =
  await import('../src/backend/terminals');
const { detectBrowsers, launchChromium, chromiumArgs } = await import('../src/backend/browsers');
const { firefoxPrefs, isProfileTrusted, launchFirefox, markProfileTrusted } =
  await import('../src/backend/firefox');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-launch-test-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(() => {
  spawned.length = 0;
  spawnFails = false;
});

const realPlatform = process.platform;
/** Runs as if on another platform, for code that reads process.platform when called. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.unstubAllEnvs();
});

const env = { HTTP_PROXY: 'http://127.0.0.1:8000', WIRESCRY: '1' };
const banner = 'This terminal sends HTTP and HTTPS traffic through Wirescry (127.0.0.1:8000).';

describe('launchTerminal', () => {
  it('on macOS, opens the terminal app with a private script that sets the environment', async () => {
    onPlatform('darwin');
    const scriptDir = path.join(dir, 'mac-scripts');
    await launchTerminal({ id: 'iterm', name: 'iTerm', command: 'iTerm' }, env, {
      scriptDir,
      proxyAddress: '127.0.0.1:8000',
    });
    expect(spawned).toHaveLength(1);
    const [{ command, args, child }] = spawned as [Spawned];
    expect(command).toBe('open');
    expect(args.slice(0, 2)).toEqual(['-a', 'iTerm']);
    const script = args[2]!;
    expect(path.dirname(script)).toBe(scriptDir);
    expect(path.basename(script)).toMatch(/^wirescry-[0-9a-f]{12}\.command$/);
    expect(await readFile(script, 'utf8')).toBe(posixStartScript(env, '127.0.0.1:8000'));
    if (realPlatform !== 'win32') {
      // Only this user can read it or the folder: it holds the proxy settings.
      expect((await stat(script)).mode & 0o777).toBe(0o700);
      expect((await stat(scriptDir)).mode & 0o077).toBe(0);
    }
    expect(child.unrefCalled).toBe(true);
  });

  it('on macOS, names each script differently', async () => {
    onPlatform('darwin');
    const scriptDir = path.join(dir, 'mac-twice');
    const terminal = { id: 'terminal', name: 'Terminal', command: 'Terminal' };
    await launchTerminal(terminal, env, { scriptDir, proxyAddress: '127.0.0.1:8000' });
    await launchTerminal(terminal, env, { scriptDir, proxyAddress: '127.0.0.1:8000' });
    expect(await readdir(scriptDir)).toHaveLength(2);
  });

  it('on Windows, opens it with start from a hidden cmd.exe, passing the environment', async () => {
    onPlatform('win32');
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    await launchTerminal({ id: 'cmd', name: 'Command Prompt', command: 'cmd.exe' }, env, {
      scriptDir: dir,
      proxyAddress: '127.0.0.1:8000',
    });
    const [{ command, args, options }] = spawned as [Spawned];
    expect(command).toBe('cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', `"start "Wirescry" "cmd.exe" /K echo ${banner}"`]);
    expect(options).toMatchObject({ windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
    expect(options.detached).toBeUndefined();
    expect(options.env).toMatchObject(env);
    expect(options.env!.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('on Linux, runs a shell in the terminal that prints the banner, quoting it safely', async () => {
    onPlatform('linux');
    await launchTerminal(
      { id: 'gnome-terminal', name: 'GNOME Terminal', command: '/usr/bin/gnome-terminal', execFlag: ['--'] },
      env,
      { scriptDir: dir, proxyAddress: "it's:8000" },
    );
    const [{ command, args, options }] = spawned as [Spawned];
    expect(command).toBe('/usr/bin/gnome-terminal');
    expect(args).toEqual([
      '--',
      'sh',
      '-c',
      `echo 'This terminal sends HTTP and HTTPS traffic through Wirescry (it'\\''s:8000).'; exec "\${SHELL:-/bin/sh}" -l`,
    ]);
    expect(options).toMatchObject({ detached: true });
    expect(options.env).toMatchObject(env);
  });

  it('on Linux, uses -e for a terminal with no flag of its own', async () => {
    onPlatform('linux');
    await launchTerminal({ id: 'x', name: 'X', command: '/usr/bin/x' }, env, {
      scriptDir: dir,
      proxyAddress: '127.0.0.1:8000',
    });
    expect(spawned[0]!.args.slice(0, 3)).toEqual(['-e', 'sh', '-c']);
    // kitty and foot take the command as it is.
    spawned.length = 0;
    await launchTerminal({ id: 'kitty', name: 'kitty', command: '/usr/bin/kitty', execFlag: [] }, env, {
      scriptDir: dir,
      proxyAddress: '127.0.0.1:8000',
    });
    expect(spawned[0]!.args.slice(0, 2)).toEqual(['sh', '-c']);
  });

  it('says why when the terminal can’t be started', async () => {
    onPlatform('linux');
    spawnFails = true;
    await expect(
      launchTerminal({ id: 'xterm', name: 'XTerm', command: '/gone/xterm', execFlag: ['-e'] }, env, {
        scriptDir: dir,
        proxyAddress: '127.0.0.1:8000',
      }),
    ).rejects.toThrow('spawn /gone/xterm ENOENT');
  });

  it('keeps the inherited environment, with the terminal’s own values winning', () => {
    expect(
      childEnv({ PATH: '/bin', HTTP_PROXY: 'old', NODE_CHANNEL_FD: '3' }, { HTTP_PROXY: 'new' }),
    ).toEqual({
      PATH: '/bin',
      HTTP_PROXY: 'new',
    });
  });
});

describe('detectTerminals', () => {
  it('finds PowerShell 7 on Windows, and calls the built-in one Windows PowerShell beside it', async () => {
    const bin = path.join(dir, 'pwsh-bin');
    await mkdir(bin, { recursive: true });
    // On Windows the file is pwsh.exe; elsewhere, as here, a bare name with execute permission.
    const name = realPlatform === 'win32' ? 'pwsh.exe' : 'pwsh';
    await writeFile(path.join(bin, name), '', { mode: 0o755 });
    const found = await detectTerminals('win32', { PATH: bin });
    expect(found.map((t) => [t.id, t.name])).toEqual([
      ['pwsh', 'PowerShell'],
      ['powershell', 'Windows PowerShell'],
      ['cmd', 'Command Prompt'],
    ]);
    expect(found[0]!.command).toBe(path.join(bin, name));
  });

  // Only where iTerm isn't installed for everyone, so the user's own folder is what's found.
  it.skipIf(existsSync('/Applications/iTerm.app'))(
    'finds iTerm in the user’s own Applications folder, and not when it isn’t there',
    async () => {
      const home = path.join(dir, 'home');
      expect((await detectTerminals('darwin', { HOME: home })).map((t) => t.id)).toEqual(['terminal']);
      await mkdir(path.join(home, 'Applications', 'iTerm.app'), { recursive: true });
      expect((await detectTerminals('darwin', { HOME: home })).map((t) => t.id)).toEqual([
        'terminal',
        'iterm',
      ]);
    },
  );

  it.skipIf(realPlatform === 'win32')('skips a Linux terminal that isn’t executable', async () => {
    const bin = path.join(dir, 'linux-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'konsole'), '', { mode: 0o644 });
    await writeFile(path.join(bin, 'foot'), '', { mode: 0o755 });
    expect((await detectTerminals('linux', { PATH: bin })).map((t) => t.id)).toEqual(['foot']);
  });
});

describe('detectBrowsers', () => {
  /** A folder with these executables in it. */
  async function folderWith(name: string, files: string[]): Promise<string> {
    const root = path.join(dir, name);
    await mkdir(root, { recursive: true });
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '', { mode: 0o755 });
    }
    return root;
  }

  it('on Windows, looks in Program Files, Program Files (x86) and the user’s AppData', async () => {
    const programFiles = await folderWith('pf', ['Google/Chrome/Application/chrome.exe']);
    const programFilesX86 = await folderWith('pf86', ['Microsoft/Edge/Application/msedge.exe']);
    const localAppData = await folderWith('lad', ['BraveSoftware/Brave-Browser/Application/brave.exe']);
    vi.stubEnv('PROGRAMFILES', programFiles);
    vi.stubEnv('PROGRAMFILES(X86)', programFilesX86);
    vi.stubEnv('LOCALAPPDATA', localAppData);
    const found = await detectBrowsers('win32');
    expect(found.map((b) => [b.id, b.executable])).toEqual([
      ['chrome', path.join(programFiles, 'Google/Chrome/Application/chrome.exe')],
      ['edge', path.join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe')],
      ['brave', path.join(localAppData, 'BraveSoftware/Brave-Browser/Application/brave.exe')],
    ]);
  });

  it('on Windows, finds nothing when those folders aren’t set', async () => {
    vi.stubEnv('PROGRAMFILES', '');
    vi.stubEnv('PROGRAMFILES(X86)', '');
    vi.stubEnv('LOCALAPPDATA', '');
    expect(await detectBrowsers('win32')).toEqual([]);
  });

  it('on Linux, finds each browser once on the PATH, under any of its names', async () => {
    const first = await folderWith('path1', ['chromium-browser', 'firefox-esr']);
    const second = await folderWith('path2', ['chromium', 'google-chrome-stable']);
    vi.stubEnv('PATH', [first, second].join(path.delimiter));
    const found = await detectBrowsers('linux');
    expect(found.map((b) => [b.id, b.kind, b.executable])).toEqual([
      ['chrome', 'chromium', path.join(second, 'google-chrome-stable')],
      // The first folder on the PATH wins.
      ['chromium', 'chromium', path.join(first, 'chromium-browser')],
      ['firefox', 'firefox', path.join(first, 'firefox-esr')],
    ]);
  });

  it.skipIf(realPlatform === 'win32')('skips a file it can’t run', async () => {
    const bin = await folderWith('path3', []);
    await writeFile(path.join(bin, 'brave'), '', { mode: 0o644 });
    vi.stubEnv('PATH', bin);
    expect(await detectBrowsers('linux')).toEqual([]);
  });
});

describe('launchChromium', () => {
  const browser = { id: 'chrome', name: 'Google Chrome', kind: 'chromium' as const, executable: '/x/chrome' };

  it('starts it with a new profile and the proxy, and removes the profile after it closes', async () => {
    await launchChromium(browser, { proxyPort: 8000, spkiFingerprint: 'abc=' });
    const [{ command, args, child }] = spawned as [Spawned];
    expect(command).toBe('/x/chrome');
    const profileDir = args[0]!.replace('--user-data-dir=', '');
    expect(path.basename(profileDir)).toMatch(/^wirescry-profile-/);
    expect(args).toEqual(chromiumArgs({ proxyPort: 8000, spkiFingerprint: 'abc=', profileDir }));
    expect((await stat(profileDir)).isDirectory()).toBe(true);
    const there = () =>
      stat(profileDir).then(
        () => true,
        () => false,
      );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      child.emit('exit', 0);
      // Not straight away: Chromium may still hold files for a moment.
      await vi.advanceTimersByTimeAsync(999);
      // Real time for anything started to finish (setImmediate and Date aren't faked).
      const until = Date.now() + 100;
      while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
      expect(await there()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
    await expect
      .poll(() =>
        stat(profileDir).then(
          () => 'there',
          () => 'gone',
        ),
      )
      .toBe('gone');
  });

  it('opens the page it’s given, and example.com otherwise', () => {
    expect(chromiumArgs({ proxyPort: 1, spkiFingerprint: 'x', profileDir: '/p' }).at(-1)).toBe(
      'https://example.com/',
    );
    expect(
      chromiumArgs({ proxyPort: 1, spkiFingerprint: 'x', profileDir: '/p', startUrl: 'http://a.test/' }).at(
        -1,
      ),
    ).toBe('http://a.test/');
  });

  it('says why when the browser can’t be started', async () => {
    spawnFails = true;
    await expect(launchChromium(browser, { proxyPort: 8000, spkiFingerprint: 'abc=' })).rejects.toThrow(
      'spawn /x/chrome ENOENT',
    );
  });
});

describe('launchFirefox', () => {
  const firefox = { id: 'firefox', name: 'Firefox', kind: 'firefox' as const, executable: '/x/firefox' };

  it('opens the setup page in a profile that doesn’t trust the CA yet, writing its settings', async () => {
    const profileDir = path.join(dir, 'ff-new');
    await launchFirefox(firefox, { profileDir, proxyPort: 8123, spkiFingerprint: 'fp1' });
    expect(await readFile(path.join(profileDir, 'user.js'), 'utf8')).toBe(firefoxPrefs(8123));
    expect(spawned.map((s) => [s.command, s.args])).toEqual([
      ['/x/firefox', ['--profile', profileDir, 'http://wirescry.internal/']],
    ]);
    if (realPlatform !== 'win32') expect((await stat(profileDir)).mode & 0o077).toBe(0);
  });

  it('opens example.com once the profile trusts this CA, and setup again for a new CA', async () => {
    const profileDir = path.join(dir, 'ff-trusted');
    await markProfileTrusted(profileDir, 'fp1');
    expect(await isProfileTrusted(profileDir, 'fp1')).toBe(true);
    await launchFirefox(firefox, { profileDir, proxyPort: 8000, spkiFingerprint: 'fp1' });
    expect(spawned.at(-1)!.args.at(-1)).toBe('https://example.com/');
    // After the CA is reset, the profile trusts the old one, not this.
    expect(await isProfileTrusted(profileDir, 'fp2')).toBe(false);
    await launchFirefox(firefox, { profileDir, proxyPort: 8000, spkiFingerprint: 'fp2' });
    expect(spawned.at(-1)!.args.at(-1)).toBe('http://wirescry.internal/');
  });

  it('rewrites its settings each time, for the current port', async () => {
    const profileDir = path.join(dir, 'ff-port');
    await launchFirefox(firefox, { profileDir, proxyPort: 8000, spkiFingerprint: 'fp' });
    await launchFirefox(firefox, { profileDir, proxyPort: 9000, spkiFingerprint: 'fp' });
    const prefs = await readFile(path.join(profileDir, 'user.js'), 'utf8');
    expect(prefs).toContain('user_pref("network.proxy.http_port", 9000);');
    expect(prefs).toContain('user_pref("network.proxy.ssl_port", 9000);');
    expect(prefs).not.toContain('8000');
  });

  it('says why when Firefox can’t be started', async () => {
    spawnFails = true;
    await expect(
      launchFirefox(firefox, {
        profileDir: path.join(dir, 'ff-fail'),
        proxyPort: 8000,
        spkiFingerprint: 'fp',
      }),
    ).rejects.toThrow('spawn /x/firefox ENOENT');
  });
});
