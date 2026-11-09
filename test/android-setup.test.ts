/** Android setup's status as the ADB server and its devices come and go. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdbEndpoint } from '../src/backend/android/adb-client';
import type { DeviceInfo } from '../src/backend/android/devices';
import { CaptureRecords } from '../src/backend/android/capture';
import { AndroidSetup, type AndroidSetupOptions } from '../src/backend/android/setup';
import { loadRecording, startFakeAdb, type FakeAdb } from './fake-adb';
import { NOTHING_LISTENS } from './helpers';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function setupWith(options: AndroidSetupOptions): { setup: AndroidSetup; changes: () => number } {
  let changes = 0;
  const setup = new AndroidSetup({
    findAdb: () => undefined,
    retryDelaysMs: [20],
    timeoutMs: 1000,
    ...options,
    onStatusChange: () => (changes += 1),
  });
  cleanup.push(() => setup.stop());
  return { setup, changes: () => changes };
}

/** Device listeners that do nothing: enough for setup that never captures. */
const noListeners = () => ({
  open: async () => ({ port: 0 }),
  close: async () => undefined,
  list: () => [],
  setLocalAccess() {},
  onPortChange: () => () => undefined,
});

/** A record an earlier run left behind. */
const leftoverRecord = () => ({
  version: 1 as const,
  id: 'a'.repeat(32),
  label: 'Pixel 8',
  previousProxy: null,
  devicePort: 40000,
  hostPort: 40001,
  startedAt: new Date(0).toISOString(),
});

/** A fake server whose device list a test sets; it sends each new list to every tracker. */
async function listServer(): Promise<{ fake: FakeAdb; setList: (text: string) => void }> {
  const trackers = new Set<net.Socket>();
  let list = '';
  const frame = (text: string) => `${Buffer.byteLength(text).toString(16).padStart(4, '0')}${text}`;
  const fake = await startFakeAdb({
    script: (requests, socket) => {
      const last = requests.at(-1);
      if (last === 'host:version') socket.end('OKAY00040029');
      else if (last === 'host:track-devices-l') {
        trackers.add(socket);
        socket.on('close', () => trackers.delete(socket));
        socket.write(`OKAY${frame(list)}`);
      } else return false;
      return true;
    },
  });
  cleanup.push(() => fake.close());
  return {
    fake,
    setList(text) {
      list = text;
      for (const socket of trackers) socket.write(frame(text));
    },
  };
}

const PIXEL: DeviceInfo = {
  label: 'Pixel 8',
  emulator: false,
  apiLevel: 34,
  identityParts: ['SER', 'aid', ''],
};

describe('Android setup', () => {
  it('finds the real emulator, end to end from a recording', async () => {
    const fake = await startFakeAdb({ recordings: [loadRecording('android-setup')] });
    cleanup.push(() => fake.close());
    const { setup } = setupWith({ endpoint: () => fake.endpoint });
    await setup.start();
    await expect.poll(() => setup.status().devices[0]?.id).toBeTruthy();
    expect(setup.status()).toEqual({
      state: 'ready',
      serverVersion: 41,
      devices: [
        {
          serial: 'emulator-5554',
          state: 'ready',
          label: 'Medium Phone API 37.0',
          emulator: true,
          apiLevel: 37,
          id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      ],
    });
  });

  it('follows devices arriving, waiting for approval, and leaving', async () => {
    const { fake, setList } = await listServer();
    const reads: string[] = [];
    const { setup } = setupWith({
      endpoint: () => fake.endpoint,
      readInfo: async (_e, serial) => {
        reads.push(serial);
        return PIXEL;
      },
    });
    await setup.start();
    expect(setup.status()).toMatchObject({ state: 'ready', devices: [] });
    setList('R58\tunauthorized usb:1-1 transport_id:4\n');
    await expect.poll(() => setup.status().devices.map((d) => d.state)).toEqual(['unauthorized']);
    // Not read until the user allows USB debugging.
    expect(reads).toEqual([]);
    setList('R58\tdevice usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:4\n');
    await expect.poll(() => setup.status().devices[0]?.apiLevel).toBe(34);
    expect(reads).toEqual(['R58']);
    // The same transport isn't read twice.
    setList('R58\tdevice usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:4\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toEqual(['R58']);
    setList('');
    await expect.poll(() => setup.status().devices).toEqual([]);
    // Back, on a new transport: read again.
    setList('R58\tdevice model:Pixel_8 transport_id:5\n');
    await expect.poll(() => reads).toEqual(['R58', 'R58']);
  });

  it("shows why a device couldn't be read, and drops a read for a device that has gone", async () => {
    const { fake, setList } = await listServer();
    let finish!: (info: DeviceInfo) => void;
    const { setup } = setupWith({
      endpoint: () => fake.endpoint,
      readInfo: (_e, serial) =>
        serial === 'bad'
          ? Promise.reject(new Error('closed'))
          : new Promise<DeviceInfo>((resolve) => (finish = resolve)),
    });
    await setup.start();
    setList('bad\tdevice transport_id:1\nslow\tdevice transport_id:2\n');
    await expect.poll(() => setup.status().devices[0]?.error).toMatch(/closed/);
    setList('bad\tdevice transport_id:1\n');
    await expect.poll(() => setup.status().devices.length).toBe(1);
    finish(PIXEL);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setup.status().devices.map((d) => d.serial)).toEqual(['bad']);
    // What arrived late wasn't kept: if the same transport shows up again, it's read again.
    setList('bad\tdevice transport_id:1\nslow\tdevice transport_id:2\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setup.status().devices[1]?.apiLevel).toBeUndefined();
  });

  it('reads a device again after "Check again" during a read', async () => {
    const { fake, setList } = await listServer();
    const pending: Array<(info: DeviceInfo) => void> = [];
    const { setup } = setupWith({
      endpoint: () => fake.endpoint,
      readInfo: () => new Promise<DeviceInfo>((resolve) => pending.push(resolve)),
    });
    await setup.start();
    setList('R58\tdevice transport_id:4\n');
    await expect.poll(() => pending.length).toBe(1);
    await setup.refresh();
    // The new connection starts its own read; the old one's answer is thrown away.
    await expect.poll(() => pending.length).toBe(2);
    pending[0]!({ ...PIXEL, apiLevel: 21 });
    pending[1]!(PIXEL);
    await expect.poll(() => setup.status().devices[0]?.apiLevel).toBe(34);
  });

  it('never starts two servers at once when "Check again" comes during startup', async () => {
    const port = NOTHING_LISTENS;
    let running = 0;
    let most = 0;
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 50));
        running -= 1;
      },
    });
    await Promise.all([setup.start(), setup.refresh(), setup.refresh()]);
    expect(most).toBe(1);
  });

  it('says to install platform tools, then notices a server that starts later', async () => {
    // Nothing listens until Android Studio starts a server, on its own port.
    let port = NOTHING_LISTENS;
    const { setup } = setupWith({ endpoint: () => ({ host: '127.0.0.1', port }) });
    await setup.start();
    expect(setup.status()).toMatchObject({ state: 'no-adb', error: expect.stringMatching(/platform tools/) });
    const { fake } = await listServer();
    port = fake.endpoint.port;
    await expect.poll(() => setup.status().state).toBe('ready');
  });

  it('only starts a server itself at first and on "Check again", never while retrying', async () => {
    const port = NOTHING_LISTENS;
    const runs: string[] = [];
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async (file) => void runs.push(file),
    });
    await setup.start();
    expect(runs).toEqual(['/sdk/adb']);
    // adb "started" nothing that answers: it keeps looking without starting it again.
    expect(setup.status().state).toBe('failed');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs).toEqual(['/sdk/adb']);
    await setup.refresh();
    expect(runs).toEqual(['/sdk/adb', '/sdk/adb']);
  });

  it('in the app, uses a running server but starts none at launch, until asked', async () => {
    const port = NOTHING_LISTENS;
    const runs: string[] = [];
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async (file) => void runs.push(file),
      startServerAtLaunch: false,
    });
    await setup.start();
    expect(setup.status()).toEqual({ state: 'no-server', devices: [] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs).toEqual([]);
    // "Start the ADB server" (refresh) does start one.
    await setup.refresh();
    expect(runs).toEqual(['/sdk/adb']);
  });

  it('keeps saying why starting a server failed while it keeps looking', async () => {
    // Nothing listens until Android Studio starts a server, on its own port.
    let port = NOTHING_LISTENS;
    const adb: { path?: string } = {};
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => adb.path,
      run: async () => {
        throw new Error('adb exited with 1');
      },
      startServerAtLaunch: false,
    });
    await setup.start();
    expect(setup.status().state).toBe('no-server');
    // No adb: the reason stays through the retries, which only look.
    await setup.refresh();
    expect(setup.status()).toMatchObject({ state: 'no-adb', error: expect.stringMatching(/platform tools/) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(setup.status()).toMatchObject({ state: 'no-adb' });
    // adb that fails: the same.
    adb.path = '/sdk/adb';
    await setup.refresh();
    expect(setup.status()).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/adb exited with 1/),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(setup.status()).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/adb exited with 1/),
    });
    // Once a server runs (Android Studio's), the old reason is gone, and so it stays.
    const { fake } = await listServer();
    port = fake.endpoint.port;
    await expect.poll(() => setup.status().state).toBe('ready');
    expect(setup.status().error).toBeUndefined();
    // When that server goes away later, the old reason doesn't come back.
    port = NOTHING_LISTENS;
    fake.dropAll();
    await expect.poll(() => setup.status().state, { timeout: 5000 }).toBe('no-server');
  });

  it('in the app, notices a server Android Studio starts later, starting nothing itself', async () => {
    // Nothing listens until Android Studio starts a server, on its own port.
    let port = NOTHING_LISTENS;
    const runs: string[] = [];
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async (file) => void runs.push(file),
      startServerAtLaunch: false,
    });
    await setup.start();
    expect(setup.status().state).toBe('no-server');
    const { fake } = await listServer();
    port = fake.endpoint.port;
    await expect.poll(() => setup.status().state).toBe('ready');
    expect(runs).toEqual([]);
  });

  it('in the app, starts one at launch when an earlier run left a device set up', async () => {
    const port = NOTHING_LISTENS;
    const runs: string[] = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-leftover-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await new CaptureRecords(dir).write(leftoverRecord());
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async (file) => void runs.push(file),
      startServerAtLaunch: false,
      capture: {
        listeners: noListeners(),
        recordsDir: dir,
        pollMs: 60_000,
      },
    });
    await setup.start();
    expect(runs).toEqual(['/sdk/adb']);
  });

  it('doesn’t keep a server that didn’t answer as a start failure', async () => {
    // A server that accepts and never answers: a timeout, not a failed start.
    const held = new Set<net.Socket>();
    const hung = net.createServer((socket) => void held.add(socket));
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const port = (hung.address() as net.AddressInfo).port;
    const runs: string[] = [];
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async (file) => void runs.push(file),
      startServerAtLaunch: false,
      timeoutMs: 200,
    });
    await setup.refresh();
    expect(setup.status().state).toBe('failed');
    expect(runs).toEqual([]);
    await new Promise<void>((resolve) => {
      hung.close(() => resolve());
      for (const socket of held) socket.destroy();
    });
    await expect.poll(() => setup.status().state, { timeout: 5000 }).toBe('no-server');
  });

  it('sends nothing new, and never shows “starting”, while it only looks', async () => {
    const port = NOTHING_LISTENS;
    const states: string[] = [];
    const setup = new AndroidSetup({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => undefined,
      retryDelaysMs: [20],
      timeoutMs: 1000,
      startServerAtLaunch: false,
      onStatusChange: () => states.push(setup.status().state),
    });
    cleanup.push(() => setup.stop());
    await setup.start();
    await setup.refresh();
    const after = states.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Several retries ran, and none changed what's shown.
    expect(states.length).toBe(after);
    expect(states.at(-1)).toBe('no-adb');
  });

  it('in the app, with capture set up but nothing left, starts no server at launch', async () => {
    const port = NOTHING_LISTENS;
    const runs: string[] = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-empty-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    // Not records: ignored.
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await writeFile(path.join(dir, `${'a'.repeat(32)}.json`), '{ broken');
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      findAdb: () => '/sdk/adb',
      run: async (file) => void runs.push(file),
      startServerAtLaunch: false,
      capture: { listeners: noListeners(), recordsDir: dir, pollMs: 60_000 },
    });
    await setup.start();
    expect(runs).toEqual([]);
    expect(setup.status().state).toBe('no-server');
  });

  it('in the app, with a device left set up and no adb, says so and keeps saying it', async () => {
    const port = NOTHING_LISTENS;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-leftover-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await new CaptureRecords(dir).write(leftoverRecord());
    const { setup } = setupWith({
      endpoint: () => ({ host: '127.0.0.1', port }),
      startServerAtLaunch: false,
      capture: { listeners: noListeners(), recordsDir: dir, pollMs: 60_000 },
    });
    await setup.start();
    expect(setup.status().state).toBe('no-adb');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(setup.status().state).toBe('no-adb');
  });

  it('says when it loses the server, and comes back with its devices', async () => {
    const { fake, setList } = await listServer();
    const { setup } = setupWith({
      endpoint: () => fake.endpoint,
      readInfo: async () => PIXEL,
      retryDelaysMs: [300],
    });
    await setup.start();
    setList('R58\tdevice transport_id:4\n');
    await expect.poll(() => setup.status().devices[0]?.apiLevel).toBe(34);
    fake.dropAll();
    await expect.poll(() => setup.status().error ?? '').toMatch(/Lost touch with the ADB server/);
    await expect.poll(() => setup.status().devices[0]?.apiLevel).toBe(34);
    expect(setup.status().state).toBe('ready');
  });

  it("reports an ADB address it won't use", async () => {
    const { setup } = setupWith({
      endpoint: () => {
        throw new Error('ADB_SERVER_SOCKET points at 10.0.0.5.');
      },
    });
    await setup.start();
    expect(setup.status()).toEqual({
      state: 'failed',
      error: 'ADB_SERVER_SOCKET points at 10.0.0.5.',
      devices: [],
    });
  });

  it('goes quiet once stopped', async () => {
    const { fake, setList } = await listServer();
    const { setup, changes } = setupWith({ endpoint: () => fake.endpoint, readInfo: async () => PIXEL });
    await setup.start();
    setup.stop();
    const before = changes();
    setList('R58\tdevice transport_id:4\n');
    fake.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes()).toBe(before);
    await setup.refresh();
    expect(changes()).toBe(before);
  });

  it('hands out copies of its status', async () => {
    const { fake, setList } = await listServer();
    const { setup } = setupWith({ endpoint: () => fake.endpoint as AdbEndpoint });
    await setup.start();
    setList('R58\tunauthorized transport_id:4\n');
    await expect.poll(() => setup.status().devices.length).toBe(1);
    setup.status().devices[0]!.label = 'changed';
    expect(setup.status().devices[0]!.label).not.toBe('changed');
  });
});
