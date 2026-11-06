import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as mockttp from 'mockttp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ExchangeSource } from '../src/shared/api';
import { apiClient, exchangesIn, httpViaProxy, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

const PIXEL: ExchangeSource = { kind: 'android', id: 'serial-123', label: 'Pixel 8' };
const TABLET: ExchangeSource = { kind: 'android', id: 'serial-456', label: 'Galaxy Tab' };

/** A plugin with one rule that answers for mocked.test, and a handle to change its rules. */
function rulePlugin(): BackendPlugin & { host?: BackendPluginHost } {
  const plugin: BackendPlugin & { host?: BackendPluginHost } = {
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
    upstream = http.createServer((req, res) => res.end(`upstream ${req.url}`));
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
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [plugin],
      pluginsEnabled: true,
    });
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
    await expect
      .poll(() => exchangesIn(api.messages).filter((e) => e.path.startsWith('/from-')).length)
      .toBe(2);
    const byPath = new Map(exchangesIn(api.messages).map((e) => [e.path, e]));
    expect(byPath.get('/from-phone')?.source).toEqual(PIXEL);
    expect(byPath.get('/from-mac')?.source).toBeUndefined();
    expect(backend.listeners.list()).toEqual([{ source: PIXEL, port }]);
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

  it('takes connections from this computer only', async () => {
    const { port } = await backend.listeners.open(PIXEL);
    expect(await isRefused('127.0.0.1', port)).toBe(false);
    const lan = lanAddress();
    if (lan) expect(await isRefused(lan, port)).toBe(true);
  });

  it('keeps its port across a certificate reset, serving HTTPS with the new certificate', async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    const oldCa = await readFile(backend.caCertPath, 'utf8');
    expect((await requestViaProxy(port, 'https://mocked.test/', oldCa)).status).toBe(418);
    await api.send({ command: 'resetCertificate' });
    const newCa = await readFile(backend.caCertPath, 'utf8');
    expect(newCa).not.toBe(oldCa);
    expect(backend.listeners.list()).toEqual([{ source: PIXEL, port }]);
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
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    expect(await backend.listeners.open(PIXEL, free)).toEqual({ port: free });
    await backend.listeners.close(PIXEL.id);

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
