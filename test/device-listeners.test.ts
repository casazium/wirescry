import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as mockttp from 'mockttp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import { WebSocketServer } from 'ws';
import type { BodyContent, ExchangeSource, ExchangeSummary } from '../src/shared/api';
import {
  apiClient,
  exchangesIn,
  httpViaProxy,
  moveProxyToPickedPort,
  onPickedPort,
  PORT_TAKEN,
  portTaken,
  requestViaProxy,
  startBackendOnPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

const PIXEL: ExchangeSource = { kind: 'android', id: 'serial-123', label: 'Pixel 8' };
const TABLET: ExchangeSource = { kind: 'android', id: 'serial-456', label: 'Galaxy Tab' };

/** A plugin with one rule that answers for mocked.test, and a handle to change its rules. */
function rulePlugin(): BackendPlugin & { host?: BackendPluginHost; completed: ExchangeSummary[] } {
  const plugin: BackendPlugin & { host?: BackendPluginHost; completed: ExchangeSummary[] } = {
    completed: [],
    exchangeCompleted(exchange) {
      plugin.completed.push(exchange);
    },
    name: 'rules',
    apiVersion: PLUGIN_API_VERSION,
    async start(host) {
      plugin.host = host;
      await host.setProxyRules([
        {
          id: 'teapot',
          label: 'Teapot',
          matchers: [new mockttp.matchers.HostnameMatcher('mocked.test')],
          steps: [new mockttp.requestSteps.FixedResponseStep(418, undefined, 'from the plugin')],
        },
      ]);
    },
    async handle() {
      return undefined;
    },
  };
  return plugin;
}

/** This machine's address on the local network, if it has one. */
function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

/** Resolves true if the server closed the connection without answering. */
function isRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let answered = false;
    socket.on('connect', () =>
      socket.write('GET http://wirescry.internal/ HTTP/1.1\r\nHost: wirescry.internal\r\n\r\n'),
    );
    socket.on('data', () => {
      answered = true;
      socket.destroy();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(!answered));
    setTimeout(() => socket.destroy(), 3000);
  });
}

/** Whether anything accepts connections on this loopback port. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('Device listeners', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let plugin: ReturnType<typeof rulePlugin>;
  let upstream: http.Server;
  let upstreamUrl: string;
  let stopped: boolean;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      // Echoes a request body; otherwise says which path it got.
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () =>
        res.end(chunks.length ? `echo ${Buffer.concat(chunks).toString()}` : `upstream ${req.url}`),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => upstream.close(resolve));
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-device-listeners-'));
    plugin = rulePlugin();
    stopped = false;
    // Kept across certificate resets: see startBackendOnPickedPort.
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [plugin],
      pluginsEnabled: true,
    });
    // These tests use servers on this computer; the destination policy has tests of its own.
    for (const source of [PIXEL, TABLET]) backend.listeners.setLocalAccess(source.id, true);
  });
  afterEach(async () => {
    if (!stopped) await backend.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("records a device's traffic with its source, and the computer's own without one", async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    expect(port).not.toBe(backend.proxyPort);
    expect((await httpViaProxy(port, `${upstreamUrl}/from-phone`)).body).toBe('upstream /from-phone');
    expect((await httpViaProxy(backend.proxyPort, `${upstreamUrl}/from-mac`)).body).toBe(
      'upstream /from-mac',
    );
    // Each exchange is sent again as it changes, and more often under load: count requests, not updates.
    await expect
      .poll(
        () =>
          new Set(
            exchangesIn(api.messages)
              .filter((e) => e.path.startsWith('/from-'))
              .map((e) => e.id),
          ).size,
      )
      .toBe(2);
    const byPath = new Map(exchangesIn(api.messages).map((e) => [e.path, e]));
    expect(byPath.get('/from-phone')?.source).toEqual(PIXEL);
    expect(byPath.get('/from-mac')?.source).toBeUndefined();
    expect(backend.listeners.list()).toEqual([{ source: PIXEL, port, localAccess: true }]);
    api.close();
  });

  it('keeps several devices apart', async () => {
    const api = await apiClient(backend.apiPort);
    const pixel = await backend.listeners.open(PIXEL);
    const tablet = await backend.listeners.open(TABLET);
    expect(pixel.port).not.toBe(tablet.port);
    await httpViaProxy(pixel.port, `${upstreamUrl}/pixel`);
    await httpViaProxy(tablet.port, `${upstreamUrl}/tablet`);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.source).length).toBe(2);
    const sources = Object.fromEntries(exchangesIn(api.messages).map((e) => [e.path, e.source?.id]));
    expect(sources).toMatchObject({ '/pixel': PIXEL.id, '/tablet': TABLET.id });
    api.close();
  });

  it('applies plugin rules, and follows changes to them', async () => {
    const { port } = await backend.listeners.open(PIXEL);
    expect(await httpViaProxy(port, 'http://mocked.test/')).toMatchObject({
      status: 418,
      body: 'from the plugin',
    });
    await plugin.host!.setProxyRules([]);
    // No rule now: pass-through tries the real (nonexistent) host.
    expect((await httpViaProxy(port, 'http://mocked.test/')).status).toBe(502);
  });

  it('records nothing while paused, like the main proxy', async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    await api.send({ command: 'setPaused', paused: true });
    expect((await httpViaProxy(port, `${upstreamUrl}/while-paused`)).status).toBe(200);
    await api.send({ command: 'setPaused', paused: false });
    await httpViaProxy(port, `${upstreamUrl}/after`);
    await expect.poll(() => exchangesIn(api.messages).some((e) => e.path === '/after')).toBe(true);
    expect(exchangesIn(api.messages).some((e) => e.path === '/while-paused')).toBe(false);
    api.close();
  });

  it("doesn't send host.docker.internal to this computer: that's for Docker containers only", async () => {
    const { port } = await backend.listeners.open(PIXEL);
    const upstreamPort = new URL(upstreamUrl).port;
    // The main proxy sends it to localhost, where the upstream answers.
    expect(
      (await httpViaProxy(backend.proxyPort, `http://host.docker.internal:${upstreamPort}/`)).status,
    ).toBe(200);
    // A device's listener resolves it like any other name; on this machine it doesn't resolve.
    expect((await httpViaProxy(port, `http://host.docker.internal:${upstreamPort}/`)).status).toBe(502);
  });

  // Needs a network address besides loopback to try from; CI machines may have none.
  it.skipIf(!lanAddress())('takes connections from this computer only', async () => {
    const { port } = await backend.listeners.open(PIXEL);
    expect(await isRefused('127.0.0.1', port)).toBe(false);
    expect(await isRefused(lanAddress()!, port)).toBe(true);
    // The same address does reach the main proxy's machine: it's the listener refusing.
    const sockets = new Set<net.Socket>();
    const control = net.createServer((socket) => {
      sockets.add(socket);
      socket.end('HTTP/1.1 200 OK\r\n\r\n');
    });
    await new Promise<void>((resolve) => control.listen(0, '0.0.0.0', resolve));
    try {
      expect(await isRefused(lanAddress()!, (control.address() as net.AddressInfo).port)).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => control.close(resolve));
    }
  });

  it('keeps its port across a certificate reset, serving HTTPS with the new certificate', async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    const oldCa = await readFile(backend.caCertPath, 'utf8');
    expect((await requestViaProxy(port, 'https://mocked.test/', oldCa)).status).toBe(418);
    await api.send({ command: 'resetCertificate' });
    const newCa = await readFile(backend.caCertPath, 'utf8');
    expect(newCa).not.toBe(oldCa);
    expect(backend.listeners.list()).toEqual([{ source: PIXEL, port, localAccess: true }]);
    expect((await requestViaProxy(port, 'https://mocked.test/', newCa)).status).toBe(418);
    await expect(requestViaProxy(port, 'https://mocked.test/', oldCa)).rejects.toThrow();
    api.close();
  });

  it('opens once per device, reuses a free port it is given, and moves off a taken one', async () => {
    const first = await backend.listeners.open(PIXEL);
    expect(await backend.listeners.open(PIXEL)).toEqual(first);
    // Two opens at once still make one listener.
    await backend.listeners.close(PIXEL.id);
    const [a, b] = await Promise.all([backend.listeners.open(PIXEL), backend.listeners.open(PIXEL)]);
    expect(a).toEqual(b);
    expect(backend.listeners.list()).toHaveLength(1);
    await backend.listeners.close(PIXEL.id);

    // A free port given back (e.g. after a restart, so a device's tunnel still fits) is reused.
    await onPickedPort(async (free) => {
      const opened = await backend.listeners.open(PIXEL, free);
      await backend.listeners.close(PIXEL.id);
      if (opened.port === free) return;
      // Rightly not reused if another test file took it since it was picked; a bug if not.
      if (await portTaken(free)) return PORT_TAKEN;
      throw new Error(`Port ${free} was free, but the listener opened on ${opened.port}`);
    });

    // A taken one isn't: it gets another.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      const moved = await backend.listeners.open(PIXEL, taken);
      expect(moved.port).not.toBe(taken);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("doesn't bring back a listener closed during a certificate reset", async () => {
    const api = await apiClient(backend.apiPort);
    // Enough listeners that restarting them all takes a while, and the last one is closed
    // while the reset is still restarting the ones before it.
    const devices = Array.from({ length: 15 }, (_, i): ExchangeSource => ({
      kind: 'android',
      id: `device-${i}`,
      label: `Phone ${i}`,
    }));
    for (const device of devices) await backend.listeners.open(device);
    const last = devices.at(-1)!;
    const lastPort = backend.listeners.list().find((l) => l.source.id === last.id)!.port;
    const watched: Array<[string, number | undefined]> = [];
    backend.listeners.onPortChange((source, moved) => watched.push([source.id, moved]));
    const oldCa = await readFile(backend.caCertPath, 'utf8');
    const reset = api.send({ command: 'resetCertificate' });
    // Wait until the first device's listener serves the new certificate: the restarts are then
    // under way, and the last device's hasn't been restarted yet.
    const firstPort = backend.listeners.list().find((l) => l.source.id === devices[0]!.id)!.port;
    await expect
      .poll(
        async () => {
          const ca = await readFile(backend.caCertPath, 'utf8');
          if (ca === oldCa) return false;
          return requestViaProxy(firstPort, 'https://mocked.test/', ca).then(
            () => true,
            () => false,
          );
        },
        { interval: 1, timeout: 10_000 },
      )
      .toBe(true);
    await backend.listeners.close(last.id);
    await reset;
    expect(backend.listeners.list().map((l) => l.source.id)).not.toContain(last.id);
    expect(backend.listeners.list()).toHaveLength(devices.length - 1);
    expect(await isListening(lastPort)).toBe(false);
    // Nothing tells a device's tunnel to follow the closed listener. (Under load, another
    // process can take a port during the reset; that listener moves, and says so.)
    expect(watched.filter(([id, port]) => id === last.id || port === undefined)).toEqual([]);
    api.close();
  });

  it("doesn't leave a listener running that was opened while the backend stopped", async () => {
    const opening = backend.listeners.open(PIXEL).then(
      (result) => result.port,
      () => undefined,
    );
    await backend.stop();
    stopped = true;
    const port = await opening;
    if (port !== undefined) expect(await isListening(port)).toBe(false);
    await expect(backend.listeners.open(TABLET)).rejects.toThrow(/stopping/);
  });

  it('stops listening when closed, and when the backend stops', async () => {
    const pixel = await backend.listeners.open(PIXEL);
    const tablet = await backend.listeners.open(TABLET);
    await backend.listeners.close(PIXEL.id);
    expect(await isListening(pixel.port)).toBe(false);
    expect(backend.listeners.list().map((l) => l.source.id)).toEqual([TABLET.id]);
    // Closing what isn't open is fine.
    await backend.listeners.close('no-such-device');
    await backend.stop();
    stopped = true;
    expect(await isListening(tablet.port)).toBe(false);
  });
});

/** Sends a WebSocket upgrade through a proxy listener; resolves with the status it answered. */
function upgradeVia(proxyPort: number, target: string): Promise<number> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: target.replace(/^ws/, 'http'),
      headers: {
        host: url.host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** POSTs a body through a proxy listener. */
function postVia(proxyPort: number, url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'POST' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('Device listeners, beside the rest of Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let plugin: ReturnType<typeof rulePlugin>;
  let upstream: http.Server;
  let upstreamUrl: string;
  let wss: WebSocketServer;
  let wsPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () =>
        res.end(chunks.length ? `echo ${Buffer.concat(chunks).toString()}` : `upstream ${req.url}`),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.once('listening', resolve));
    wsPort = (wss.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => wss.close(resolve));
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-device-beside-'));
    plugin = rulePlugin();
    // Kept across certificate resets: see startBackendOnPickedPort.
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [plugin],
      pluginsEnabled: true,
    });
    // These tests use servers on this computer; the destination policy has tests of its own.
    for (const source of [PIXEL, TABLET]) backend.listeners.setLocalAccess(source.id, true);
  });
  afterEach(async () => {
    await backend.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("records a device's WebSockets with its source", async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    expect(await upgradeVia(port, `ws://127.0.0.1:${wsPort}/socket`)).toBe(101);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.path === '/socket')?.websocket)
      .toBe(true);
    expect(exchangesIn(api.messages).find((e) => e.path === '/socket')?.source).toEqual(PIXEL);
    api.close();
  });

  it("doesn't send a device's WebSockets for host.docker.internal to this computer", async () => {
    const { port } = await backend.listeners.open(PIXEL);
    // The main proxy does (for Docker containers)...
    expect(await upgradeVia(backend.proxyPort, `ws://host.docker.internal:${wsPort}/`)).toBe(101);
    // ...a device's listener resolves the name like any other, and here it doesn't resolve.
    // (The proxy refuses with an error status or by hanging up: either way, no upgrade.)
    expect(await upgradeVia(port, `ws://host.docker.internal:${wsPort}/`).catch(() => 0)).not.toBe(101);
  });

  it("stores a device's request and response bodies", async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    expect(await postVia(port, `${upstreamUrl}/upload`, 'hello from the phone')).toBe(
      'echo hello from the phone',
    );
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.path === '/upload' && e.responseSize !== undefined))
      .toBeTruthy();
    const id = exchangesIn(api.messages).find((e) => e.path === '/upload')!.id;
    const text = async (side: 'request' | 'response') =>
      Buffer.from(
        (await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side })).base64,
        'base64',
      ).toString();
    await expect.poll(() => text('request')).toBe('hello from the phone');
    await expect.poll(() => text('response')).toBe('echo hello from the phone');
    api.close();
  });

  it('tells plugins which device a completed request came from', async () => {
    const { port } = await backend.listeners.open(PIXEL);
    await httpViaProxy(port, `${upstreamUrl}/for-plugin`);
    await httpViaProxy(backend.proxyPort, `${upstreamUrl}/for-plugin-mac`);
    await expect
      .poll(() => plugin.completed.filter((e) => e.path.startsWith('/for-plugin')).length, {
        timeout: 15_000,
      })
      .toBe(2);
    expect(plugin.completed.find((e) => e.path === '/for-plugin')?.source).toEqual(PIXEL);
    expect(plugin.completed.find((e) => e.path === '/for-plugin-mac')?.source).toBeUndefined();
  });

  it("keeps a device's listener where it is when the main proxy's port changes", async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    const before = backend.proxyPort;
    await api.send({ command: 'setProxyPort', port: null });
    const free = await moveProxyToPickedPort(api);
    expect(backend.proxyPort).toBe(free);
    expect(backend.proxyPort).not.toBe(before);
    expect(backend.listeners.list()).toEqual([{ source: PIXEL, port, localAccess: true }]);
    expect((await httpViaProxy(port, `${upstreamUrl}/still-here`)).body).toBe('upstream /still-here');
    api.close();
  });

  it("never marks a device's request as sent from the Compose tab, nor a composed one as a device's", async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    const [composed] = await Promise.all([
      api.send<{ exchangeId: string }>({
        command: 'composeSend',
        request: { method: 'GET', url: `${upstreamUrl}/composed`, headers: [], body: '' },
      }),
      httpViaProxy(port, `${upstreamUrl}/from-phone`),
    ]);
    await expect
      .poll(
        () => exchangesIn(api.messages).filter((e) => ['/composed', '/from-phone'].includes(e.path)).length,
      )
      .toBeGreaterThanOrEqual(2);
    const byPath = new Map(exchangesIn(api.messages).map((e) => [e.path, e]));
    expect(byPath.get('/from-phone')).toMatchObject({ source: PIXEL });
    expect(byPath.get('/from-phone')?.composed).toBeUndefined();
    expect(byPath.get('/composed')).toMatchObject({ id: composed.exchangeId, composed: true });
    expect(byPath.get('/composed')?.source).toBeUndefined();
    api.close();
  });
});
