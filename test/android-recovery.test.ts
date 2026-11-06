/**
 * Keeping capture working while devices and the ADB server come and go: the periodic check,
 * reconnects, the disconnect notification, Resume and the Wi-Fi confirmation, against a fake
 * ADB server playing whole devices.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AndroidSetup } from '../src/backend/android/setup';
import type { DeviceListeners } from '../src/backend/device-listeners';
import type { ExchangeSource } from '../src/shared/api';
import { fakeDeviceState, startDeviceServer, type FakeDeviceState } from './fake-adb';

const GRACE_MS = 400;

/** Listeners that hand out ports, as the real ones do, without proxying anything. */
function fakeListeners(): DeviceListeners & { opened: Map<string, number> } {
  const opened = new Map<string, number>();
  const sources = new Map<string, ExchangeSource>();
  const local = new Set<string>();
  let next = 9001;
  return {
    opened,
    async open(source, port) {
      if (!opened.has(source.id)) opened.set(source.id, port ?? next++);
      sources.set(source.id, source);
      return { port: opened.get(source.id)! };
    },
    async close(id) {
      opened.delete(id);
    },
    list: () =>
      [...opened].map(([id, port]) => ({ source: sources.get(id)!, port, localAccess: local.has(id) })),
    setLocalAccess(id, allowed) {
      if (allowed) local.add(id);
      else local.delete(id);
    },
    onPortChange: () => () => undefined,
  };
}

let dir: string;
let devices: FakeDeviceState[];
let phone: FakeDeviceState;
let fake: Awaited<ReturnType<typeof startDeviceServer>>;
const stops: Array<() => unknown> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-recovery-'));
  phone = fakeDeviceState();
  devices = [phone];
  fake = await startDeviceServer(devices);
});
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await fake.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

function start(options: { pollMs?: number } = {}) {
  const notes: Array<[string, string]> = [];
  const listeners = fakeListeners();
  const endpoint = fake.endpoint;
  const setup = new AndroidSetup({
    endpoint: () => endpoint,
    findAdb: () => undefined,
    retryDelaysMs: [30],
    timeoutMs: 1000,
    notify: (title, body) => notes.push([title, body]),
    capture: {
      listeners,
      recordsDir: dir,
      readBackMs: 200,
      // Off by default: tests that want the timer say so.
      pollMs: options.pollMs ?? 60_000,
      graceMs: GRACE_MS,
    },
  });
  stops.push(() => setup.stop());
  const device = () => setup.status().devices.find((d) => d.serial === phone.serial);
  return { setup, listeners, notes, device };
}

async function capturing(options: { pollMs?: number } = {}) {
  const started = start(options);
  await started.setup.start();
  await expect.poll(() => started.device()?.id).toBeTruthy();
  const id = started.device()!.id!;
  expect(await started.setup.captureDevice(id)).toEqual({});
  const { devicePort, hostPort } = started.device()!.capture!;
  return { ...started, id, devicePort, hostPort };
}

const unplug = () => {
  devices.splice(devices.indexOf(phone), 1);
  fake.update();
};
/** As measured with `adb reconnect`: a new transport, and adbd's reverse rules gone. */
const plugBackIn = () => {
  phone.rules = [];
  phone.transportId = (phone.transportId ?? 1) + 10;
  devices.push(phone);
  fake.update();
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('The periodic check', () => {
  it('adds back a reverse rule that went while the device stayed connected', async () => {
    const { devicePort, hostPort } = await capturing({ pollMs: 50 });
    phone.rules = [];
    await expect.poll(() => phone.rules).toEqual([{ device: `tcp:${devicePort}`, host: `tcp:${hostPort}` }]);
    expect(phone.loopbackRules.get(`tcp:${devicePort}`)).toBe(true);
  });

  it('stops capturing, and says why, when something else changed the proxy', async () => {
    const { device, listeners } = await capturing({ pollMs: 50 });
    phone.settings.set('http_proxy', 'proxy.corp:3128');
    await expect.poll(() => device()?.note).toMatch(/changed by something else/);
    expect(device()?.capture).toBeUndefined();
    expect(phone.rules).toEqual([]);
    expect(phone.settings.get('http_proxy')).toBe('proxy.corp:3128');
    expect(listeners.opened.size).toBe(0);
  });

  it('only reads http_proxy and the rules while all is well', async () => {
    await capturing({ pollMs: 50 });
    // The device's details are read once more after Capture: let that finish.
    await sleep(200);
    phone.commands.length = 0;
    await sleep(300);
    expect(new Set(phone.commands)).toEqual(new Set(['settings get global http_proxy']));
  });
});

describe('Devices coming and going', () => {
  it('tells the user once when a capturing device is unplugged, after a grace period', async () => {
    const { setup, notes } = await capturing();
    unplug();
    await sleep(GRACE_MS / 3);
    expect(notes).toEqual([]);
    expect(setup.status().notConnected).toBeUndefined();
    await expect.poll(() => notes.length).toBe(1);
    expect(notes[0]![0]).toBe('Android device disconnected while capturing');
    expect(notes[0]![1]).toMatch(/Pixel 8 has no internet until you connect it again/);
    expect(notes[0]![1]).toMatch(/http_proxy :0/);
    expect(setup.status().notConnected).toEqual([{ label: 'Pixel 8', capturing: true }]);
    await sleep(GRACE_MS * 2);
    expect(notes).toHaveLength(1);
  });

  it('carries on capturing when it comes back, re-adding its tunnel', async () => {
    const { setup, device, notes, devicePort, hostPort } = await capturing();
    unplug();
    await expect.poll(() => notes.length).toBe(1);
    plugBackIn();
    await expect.poll(() => phone.rules).toEqual([{ device: `tcp:${devicePort}`, host: `tcp:${hostPort}` }]);
    await expect.poll(() => device()?.capture?.devicePort).toBe(devicePort);
    expect(setup.status().notConnected).toBeUndefined();
    // Gone again: told again.
    unplug();
    await expect.poll(() => notes.length).toBe(2);
  });

  it('says nothing about a quick reconnect, and still re-adds the tunnel', async () => {
    const { setup, notes, devicePort, hostPort } = await capturing();
    let flashed = false;
    const watching = setInterval(() => (flashed ||= !!setup.status().notConnected), 5);
    stops.push(() => clearInterval(watching));
    unplug();
    await sleep(20);
    plugBackIn();
    await expect.poll(() => phone.rules).toEqual([{ device: `tcp:${devicePort}`, host: `tcp:${hostPort}` }]);
    await sleep(GRACE_MS * 1.5);
    expect(notes).toEqual([]);
    expect(flashed).toBe(false);
  });

  it('re-adds the tunnel after the ADB server restarts', async () => {
    const { device, notes, devicePort, hostPort } = await capturing();
    // A restarted server's devices reconnect, which drops adbd's reverse rules.
    phone.rules = [];
    fake.dropAll();
    await expect.poll(() => phone.rules).toEqual([{ device: `tcp:${devicePort}`, host: `tcp:${hostPort}` }]);
    expect(device()?.capture).toBeDefined();
    await sleep(GRACE_MS * 1.5);
    expect(notes).toEqual([]);
  });

  it('says when the ADB server itself is gone while capturing', async () => {
    const { notes } = await capturing();
    await fake.close();
    await expect.poll(() => notes.length).toBe(1);
    expect(notes[0]![0]).toBe('Lost the ADB server while capturing');
    expect(notes[0]![1]).toMatch(/adb start-server/);
  });

  it('words it for an emulator, which comes back from its saved state', async () => {
    phone.props['ro.boot.qemu'] = '1';
    phone.props['ro.boot.qemu.avd_name'] = 'Pixel_8_API_35';
    const { setup, notes } = await capturing();
    unplug();
    await expect.poll(() => notes.length).toBe(1);
    expect(notes[0]![0]).toBe('Emulator closed while capturing');
    expect(notes[0]![1]).toMatch(/Pixel 8 API 35 still points at Wirescry/);
    expect(setup.status().notConnected).toEqual([
      { label: 'Pixel 8 API 35', capturing: true, emulator: true },
    ]);
  });

  it('shows a device as busy until every overlapping action on it has ended', async () => {
    const { setup, device, id } = await capturing();
    // Stop queues behind a second (no-op) capture; the first to end mustn't clear "busy".
    const again = setup.captureDevice(id);
    const stopping = setup.stopDevice(id);
    await again;
    expect(device()?.busy).toBe('stopping');
    await stopping;
    expect(device()?.busy).toBeUndefined();
  });
});

describe('Resume', () => {
  it('captures again a device an earlier run left set up, on the same ports', async () => {
    const first = await capturing();
    // Wirescry dies: nothing is put back.
    first.setup.stop();
    const { setup, device, listeners } = start();
    await setup.start();
    await expect.poll(() => device()?.leftover).toBe(true);
    await setup.resumeDevice(device()!.id!);
    expect(device()?.leftover).toBeUndefined();
    expect(device()?.capture).toMatchObject({ devicePort: first.devicePort, hostPort: first.hostPort });
    expect(listeners.opened.get(first.id)).toBe(first.hostPort);
    expect(phone.rules).toEqual([{ device: `tcp:${first.devicePort}`, host: `tcp:${first.hostPort}` }]);
  });

  it('lists a leftover device that isn’t connected at once, without a notification', async () => {
    const first = await capturing();
    first.setup.stop();
    unplug();
    const { setup, notes } = start();
    await setup.start();
    await expect.poll(() => setup.status().notConnected).toEqual([{ label: 'Pixel 8', capturing: false }]);
    await sleep(GRACE_MS * 1.5);
    expect(notes).toEqual([]);
  });
});

describe('Wi-Fi debugging', () => {
  it('asks before capturing a device connected over the network', async () => {
    phone.serial = '192.168.1.20:5555';
    const { setup, device } = start();
    await setup.start();
    await expect.poll(() => device()?.id).toBeTruthy();
    expect(device()?.wireless).toBe(true);
    const id = device()!.id!;
    expect(await setup.captureDevice(id)).toEqual({ needsWirelessConfirmation: true });
    expect(phone.rules).toEqual([]);
    expect(phone.settings.get('http_proxy')).toBe(':0');
    expect(await setup.captureDevice(id, undefined, true)).toEqual({});
    expect(device()?.capture).toBeDefined();
  });

  it('still asks about an existing proxy afterwards', async () => {
    phone.serial = 'adb-35121FDJH000R8-xyMD0H._adb-tls-connect._tcp';
    phone.settings.set('http_proxy', 'proxy.corp:3128');
    phone.settings.set('global_http_proxy_host', 'proxy.corp');
    const { setup, device } = start();
    await setup.start();
    await expect.poll(() => device()?.id).toBeTruthy();
    const id = device()!.id!;
    expect(await setup.captureDevice(id, undefined, true)).toEqual({ needsConfirmation: 'proxy.corp:3128' });
    expect(await setup.captureDevice(id, 'proxy.corp:3128', true)).toEqual({});
  });

  it('doesn’t ask for USB devices or emulators', async () => {
    const { setup, device } = start();
    await setup.start();
    await expect.poll(() => device()?.id).toBeTruthy();
    expect(device()?.wireless).toBeUndefined();
  });
});
