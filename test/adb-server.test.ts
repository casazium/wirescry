/** Finding the user's adb, and starting the ADB server only when none answers. */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adbCandidates,
  ensureAdbServer,
  findAdb,
  NO_ADB,
  startAdbServer,
} from '../src/backend/android/adb-server';
import { loadRecording, startFakeAdb, type FakeAdb } from './fake-adb';

let fake: FakeAdb | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('Finding adb', () => {
  it('looks in the setting, the SDK variables, the default SDK, Homebrew, then PATH (macOS)', () => {
    expect(
      adbCandidates({
        platform: 'darwin',
        home: '/Users/me',
        setting: '/opt/tools/adb',
        env: { ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/old-sdk', PATH: '/usr/bin:relative/bin:/bin' },
      }),
    ).toEqual([
      '/opt/tools/adb',
      '/sdk/platform-tools/adb',
      '/old-sdk/platform-tools/adb',
      '/Users/me/Library/Android/sdk/platform-tools/adb',
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
      '/usr/bin/adb',
      '/bin/adb',
    ]);
  });

  it('uses adb.exe and the Windows SDK folder on Windows', () => {
    expect(
      adbCandidates({
        platform: 'win32',
        home: 'C:\\Users\\me',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: 'C:\\Windows\\System32;C:\\tools' },
      }),
    ).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
      'C:\\Windows\\System32\\adb.exe',
      'C:\\tools\\adb.exe',
    ]);
  });

  it('uses ~/Android/Sdk and Linuxbrew on Linux, and drops duplicates', () => {
    expect(
      adbCandidates({
        platform: 'linux',
        home: '/home/me',
        env: { ANDROID_HOME: '/home/me/Android/Sdk', PATH: '/usr/bin' },
      }),
    ).toEqual([
      '/home/me/Android/Sdk/platform-tools/adb',
      '/home/linuxbrew/.linuxbrew/bin/adb',
      '/usr/bin/adb',
    ]);
  });

  it('ignores a relative setting and blank variables', () => {
    expect(
      adbCandidates({
        platform: 'linux',
        home: '/home/me',
        setting: 'adb',
        env: { ANDROID_HOME: '  ', PATH: '' },
      }),
    ).toEqual(['/home/me/Android/Sdk/platform-tools/adb', '/home/linuxbrew/.linuxbrew/bin/adb']);
  });

  it('takes the first that is an executable file, or none', () => {
    const options = { platform: 'darwin' as const, home: '/Users/me', env: { PATH: '/usr/bin' } };
    expect(
      findAdb({ ...options, isExecutable: (f) => f === '/opt/homebrew/bin/adb' || f === '/usr/bin/adb' }),
    ).toBe('/opt/homebrew/bin/adb');
    expect(findAdb({ ...options, isExecutable: () => false })).toBeUndefined();
  });
});

describe('Starting the ADB server', () => {
  it('runs "adb start-server" with no shell, for the port Wirescry uses, never with -a', async () => {
    const runs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = async (file: string, args: string[], env: NodeJS.ProcessEnv) =>
      void runs.push({ file, args, env });
    await startAdbServer('/sdk/platform-tools/adb', { host: '127.0.0.1', port: 5037 }, run);
    await startAdbServer('/sdk/platform-tools/adb', { host: '127.0.0.1', port: 5099 }, run);
    expect(runs.map((r) => r.args)).toEqual([['start-server'], ['start-server']]);
    expect(runs[0]!.env.ANDROID_ADB_SERVER_PORT).toBeUndefined();
    expect(runs[1]!.env.ANDROID_ADB_SERVER_PORT).toBe('5099');
    expect(runs.every((r) => r.env.ADB_SERVER_SOCKET === undefined)).toBe(true);
  });

  it('leaves a running server alone', async () => {
    fake = await startFakeAdb({ recordings: [loadRecording('wirescry-client')] });
    let ran = false;
    const state = await ensureAdbServer({
      endpoint: fake.endpoint,
      start: true,
      findAdb: () => '/sdk/adb',
      run: async () => void (ran = true),
    });
    expect(state).toEqual({ state: 'running', version: 41, started: false });
    expect(ran).toBe(false);
  });

  it('starts one with the adb it finds when nothing listens, then talks to it', async () => {
    const port = await freePort();
    let started: string | undefined;
    const state = await ensureAdbServer({
      endpoint: { host: '127.0.0.1', port },
      start: true,
      findAdb: () => '/sdk/platform-tools/adb',
      run: async (file) => {
        started = file;
        fake = await startFakeAdb({ recordings: [loadRecording('wirescry-client')] });
        // The fake took another port: point a forwarder at it from the expected one.
        const forward = net.createServer((s) =>
          s.pipe(net.connect(fake!.endpoint.port, '127.0.0.1')).pipe(s),
        );
        await new Promise<void>((resolve) => forward.listen(port, '127.0.0.1', resolve));
        const close = fake.close.bind(fake);
        fake.close = async () => {
          await close();
          forward.close();
        };
      },
    });
    expect(started).toBe('/sdk/platform-tools/adb');
    expect(state).toEqual({
      state: 'running',
      version: 41,
      started: true,
      adbPath: '/sdk/platform-tools/adb',
    });
  });

  it('says to install platform tools when there is no server and no adb', async () => {
    const state = await ensureAdbServer({
      endpoint: { host: '127.0.0.1', port: await freePort() },
      start: true,
      findAdb: () => undefined,
    });
    expect(state).toEqual({ state: 'no-adb' });
    expect(NO_ADB).toMatch(/Android Studio/);
  });

  it("doesn't start anything when asked only to look", async () => {
    let ran = false;
    const state = await ensureAdbServer({
      endpoint: { host: '127.0.0.1', port: await freePort() },
      start: false,
      findAdb: () => '/sdk/adb',
      run: async () => void (ran = true),
    });
    expect(state.state).toBe('failed');
    expect(ran).toBe(false);
  });

  it('reports adb failing to start the server', async () => {
    const state = await ensureAdbServer({
      endpoint: { host: '127.0.0.1', port: await freePort() },
      start: true,
      findAdb: () => '/sdk/adb',
      run: async () => {
        throw new Error('spawn EACCES');
      },
    });
    expect(state).toMatchObject({ state: 'failed', adbPath: '/sdk/adb' });
    expect((state as { error: string }).error).toContain('spawn EACCES');
  });

  it("doesn't start a server over something else listening on the port", async () => {
    const other = net.createServer((s) => s.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    let ran = false;
    try {
      const state = await ensureAdbServer({
        endpoint: { host: '127.0.0.1', port: (other.address() as net.AddressInfo).port },
        start: true,
        findAdb: () => '/sdk/adb',
        run: async () => void (ran = true),
      });
      expect(state.state).toBe('failed');
      expect(ran).toBe(false);
    } finally {
      other.close();
    }
  });
});
