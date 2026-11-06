/** Capture through the backend's commands, against a fake ADB server playing a whole device. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { AndroidDevice, ProxyStatus, ServerMessage } from '../src/shared/api';
import { fakeDeviceState, startDeviceServer, type FakeAdb, type FakeDeviceState } from './fake-adb';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

let dataDir: string;
let fake: FakeAdb;
let phone: FakeDeviceState;
let devices: FakeDeviceState[];
let backend: RunningBackend | undefined;
let api: Awaited<ReturnType<typeof apiClient>>;
let local: http.Server;
let localPort: number;

const last = (messages: ServerMessage[]): ProxyStatus | undefined =>
  messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);
const device = (): AndroidDevice | undefined => last(api.messages)?.android?.devices[0];

async function start(): Promise<void> {
  const endpoint = fake.endpoint;
  backend = await startBackend({
    dataDir,
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    docker: false,
    android: { endpoint: () => endpoint, findAdb: () => undefined },
  });
  api = await apiClient(backend.apiPort);
  await expect.poll(() => device()?.id).toBeTruthy();
}

async function stopBackend(): Promise<void> {
  api.close();
  await backend?.stop();
  backend = undefined;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-capture-backend-'));
  phone = fakeDeviceState();
  devices = [phone];
  fake = await startDeviceServer(devices);
  local = http.createServer((_req, res) => res.end('local server'));
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  localPort = (local.address() as net.AddressInfo).port;
});
afterEach(async () => {
  if (backend) await stopBackend();
  await fake.close();
  await new Promise((resolve) => local.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

describe('Capturing a device through the backend', () => {
  it('routes the device to its own listener, tags its traffic, and puts it back on Stop', async () => {
    await start();
    const id = device()!.id!;
    expect(await api.send({ command: 'androidCapture', deviceId: id })).toEqual({});
    await expect.poll(() => device()?.capture).toBeTruthy();
    const { devicePort, hostPort, localAccess } = device()!.capture!;
    expect(localAccess).toBe(false);
    expect(phone.settings.get('http_proxy')).toBe(`127.0.0.1:${devicePort}`);
    expect(phone.rules).toEqual([{ device: `tcp:${devicePort}`, host: `tcp:${hostPort}` }]);
    expect(backend!.listeners.list().map((l) => [l.source.id, l.port])).toEqual([[id, hostPort]]);

    // What the device sends arrives on that listener, tagged with the device.
    expect((await httpViaProxy(hostPort, 'http://wirescry.internal/')).status).toBe(200);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.host === 'wirescry.internal')?.source?.label)
      .toBe('Pixel 8');

    await api.send({ command: 'androidStop', deviceId: id });
    await expect.poll(() => device()?.capture).toBeUndefined();
    expect(phone.settings.get('http_proxy')).toBe(':0');
    expect(phone.rules).toEqual([]);
    expect(backend!.listeners.list()).toEqual([]);
    expect(await readdir(path.join(dataDir, 'android-capture'))).toEqual([]);
  });

  it("keeps the device away from this computer until it's allowed, and again after", async () => {
    await start();
    const id = device()!.id!;
    await api.send({ command: 'androidCapture', deviceId: id });
    await expect.poll(() => device()?.capture).toBeTruthy();
    const { hostPort } = device()!.capture!;
    expect((await httpViaProxy(hostPort, `http://127.0.0.1:${localPort}/`)).status).toBe(403);
    await api.send({ command: 'androidSetLocalAccess', deviceId: id, allowed: true });
    await expect.poll(() => device()?.capture?.localAccess).toBe(true);
    expect(await httpViaProxy(hostPort, `http://127.0.0.1:${localPort}/`)).toMatchObject({
      status: 200,
      body: 'local server',
    });
    await api.send({ command: 'androidSetLocalAccess', deviceId: id, allowed: false });
    expect((await httpViaProxy(hostPort, `http://127.0.0.1:${localPort}/`)).status).toBe(403);
  });

  it('asks before replacing the proxy a device already has', async () => {
    phone.settings.set('http_proxy', 'proxy.corp:3128');
    phone.settings.set('global_http_proxy_host', 'proxy.corp');
    await start();
    const id = device()!.id!;
    expect(await api.send({ command: 'androidCapture', deviceId: id })).toEqual({
      needsConfirmation: 'proxy.corp:3128',
    });
    expect(phone.rules).toEqual([]);
    await api.send({ command: 'androidCapture', deviceId: id, replaceProxy: 'proxy.corp:3128' });
    await expect.poll(() => device()?.capture).toBeTruthy();
    await api.send({ command: 'androidStop', deviceId: id });
    expect(phone.settings.get('http_proxy')).toBe('proxy.corp:3128');
  });

  it('puts the device back when Wirescry quits', async () => {
    await start();
    await api.send({ command: 'androidCapture', deviceId: device()!.id! });
    await expect.poll(() => device()?.capture).toBeTruthy();
    await stopBackend();
    expect(phone.settings.get('http_proxy')).toBe(':0');
    expect(phone.rules).toEqual([]);
  });

  it('offers Restore for a device an earlier run left set up, and restores it', async () => {
    await start();
    const id = device()!.id!;
    await api.send({ command: 'androidCapture', deviceId: id });
    await expect.poll(() => device()?.capture).toBeTruthy();
    // The device goes away before Wirescry quits, so it can't be put back.
    const saved = phone.serial;
    phone.serial = 'gone';
    await stopBackend();
    phone.serial = saved;
    expect(phone.settings.get('http_proxy')).toMatch(/^127\.0\.0\.1:/);

    await start();
    await expect.poll(() => device()?.leftover).toBe(true);
    expect(device()?.strayProxy).toBeUndefined();
    await expect(api.send({ command: 'androidCapture', deviceId: id })).rejects.toThrow(/Restore it first/);
    await api.send({ command: 'androidStop', deviceId: id });
    await expect.poll(() => device()?.leftover).toBeUndefined();
    expect(phone.settings.get('http_proxy')).toBe(':0');
    expect(phone.rules).toEqual([]);
  });

  it('lists a capturing device that disconnects, and only lets the switch change while capturing', async () => {
    await start();
    const id = device()!.id!;
    await expect(api.send({ command: 'androidSetLocalAccess', deviceId: id, allowed: true })).rejects.toThrow(
      /Capture the device first/,
    );
    await api.send({ command: 'androidCapture', deviceId: id });
    await expect.poll(() => device()?.capture).toBeTruthy();
    // Unplugged: the server lists it no more.
    devices.splice(0);
    await api.send({ command: 'androidRefresh' });
    await expect
      .poll(() => last(api.messages)?.android?.notConnected, { timeout: 10_000 })
      .toEqual([{ label: 'Pixel 8', capturing: true }]);
  });

  it("offers to clear a 127.0.0.1 proxy that isn't Wirescry's", async () => {
    phone.settings.set('http_proxy', '127.0.0.1:41111');
    phone.settings.set('global_http_proxy_host', '127.0.0.1');
    await start();
    const id = device()!.id!;
    await expect.poll(() => device()?.strayProxy).toBe('127.0.0.1:41111');
    await expect(api.send({ command: 'androidCapture', deviceId: id })).rejects.toThrow(/Clear it first/);
    await api.send({ command: 'androidClearProxy', deviceId: id });
    expect(phone.settings.get('http_proxy')).toBe(':0');
    await expect.poll(() => device()?.strayProxy).toBeUndefined();
  });

  it('refuses unknown devices, and says how to fix one that has gone', async () => {
    await start();
    await expect(api.send({ command: 'androidCapture', deviceId: 'f'.repeat(32) })).rejects.toThrow(
      /isn’t connected/,
    );
    await expect(api.send({ command: 'androidStop', deviceId: 'f'.repeat(32) })).rejects.toThrow(
      /settings put global http_proxy :0/,
    );
  });

  it('shows the failure on the device, and leaves it as it was', async () => {
    // The device takes the setting but reports something else back (as some phones do).
    await start();
    const id = device()!.id!;
    const settings = phone.settings;
    phone.settings = new Proxy(settings, {
      get(target, key) {
        if (key === 'set')
          return (k: string, v: string) => (k === 'http_proxy' && v !== ':0' ? target : target.set(k, v));
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(api.send({ command: 'androidCapture', deviceId: id })).rejects.toThrow(/Xiaomi/);
    await expect.poll(() => device()?.note).toMatch(/Xiaomi/);
    expect(device()?.capture).toBeUndefined();
    expect(settings.get('http_proxy')).toBe(':0');
    expect(phone.rules).toEqual([]);
  }, 15_000);
});
