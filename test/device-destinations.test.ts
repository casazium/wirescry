/**
 * What a device may reach through its listener, end to end through a real backend. Fake DNS
 * gives names their addresses; a fake network sends the "public" documentation addresses to
 * servers on this computer, so the internet is never touched.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as mockttp from 'mockttp';
import { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ExchangeSource, ExchangeSummary } from '../src/shared/api';
import { LOCAL_ACCESS_SWITCH } from '../src/shared/failure';
import {
  apiClient,
  exchangesIn,
  requestViaProxy,
  startBackendOnPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

const PIXEL: ExchangeSource = { kind: 'android', id: 'serial-123', label: 'Pixel 8' };
const TABLET: ExchangeSource = { kind: 'android', id: 'serial-456', label: 'Galaxy Tab' };
const PUBLIC = '203.0.113.5';

/** HTTP GET through a proxy, with this agent, returning the status and headers. */
function getVia(
  proxyPort: number,
  url: string,
  agent?: http.Agent,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { host: new URL(url).host };
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, agent, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

/** Asks for a WebSocket through a proxy; resolves with the status (101 if upgraded). */
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

/** A plugin whose rules a test sets. */
function rulesPlugin(): BackendPlugin & { host?: BackendPluginHost } {
  const plugin: BackendPlugin & { host?: BackendPluginHost } = {
    name: 'rules',
    apiVersion: PLUGIN_API_VERSION,
    async start(host) {
      plugin.host = host;
    },
    async handle() {
      return undefined;
    },
  };
  return plugin;
}

describe('What a device may reach', () => {
  let upstreamCA: { key: string; cert: string };
  let httpsUpstream: mockttp.Mockttp;
  let plain: http.Server;
  let plainPort: number;
  /** Paths the plain server got, and the headers of each. */
  let seen: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  let plainSockets: Set<net.Socket>;
  let wss: WebSocketServer;
  let wsPort: number;
  let wsConnections: number;

  let dataDir: string;
  let backend: RunningBackend;
  let plugin: ReturnType<typeof rulesPlugin>;
  let lookups: string[];
  let connects: string[];
  let rebinds: number;

  beforeAll(async () => {
    upstreamCA = await mockttp.generateCACertificate();
    httpsUpstream = mockttp.getLocal({ https: upstreamCA });
    await httpsUpstream.start();
    await httpsUpstream.forGet('/hello').thenReply(200, 'hello from upstream');

    plainSockets = new Set();
    plain = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      if (req.url === '/pretend-guard') {
        // A real server sending what looks like the guard's refusal.
        res.writeHead(403, { 'x-wirescry-guard': String(req.headers['x-replay'] ?? 'made-up') });
        res.end('pretending');
        return;
      }
      res.end(`plain ${req.url}`);
    });
    plain.on('connection', (socket) => {
      plainSockets.add(socket);
      socket.once('close', () => plainSockets.delete(socket));
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    plainPort = (plain.address() as net.AddressInfo).port;

    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', () => (wsConnections += 1));
    await new Promise((resolve) => wss.once('listening', resolve));
    wsPort = (wss.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await httpsUpstream.stop();
    await new Promise((resolve) => plain.close(resolve));
    await new Promise((resolve) => wss.close(resolve));
  });

  beforeEach(async () => {
    seen = [];
    wsConnections = 0;
    lookups = [];
    connects = [];
    rebinds = 0;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-device-destinations-'));
    plugin = rulesPlugin();
    const names: Record<string, () => string[]> = {
      localhost: () => ['127.0.0.1', '::1'],
      'api.example': () => [PUBLIC],
      'dev.lan': () => ['192.168.1.20'],
      'metadata.example': () => ['169.254.169.254'],
      'mixed.example': () => [PUBLIC, '10.0.0.7'],
      'rebind.example': () => (rebinds++ === 0 ? [PUBLIC] : ['127.0.0.1']),
    };
    // Kept across certificate resets: see startBackendOnPickedPort.
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [plugin],
      pluginsEnabled: true,
      upstreamCAs: [upstreamCA.cert],
      deviceEgress: {
        lookup: async (host) => {
          lookups.push(host);
          const answer = names[host];
          if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
          return answer();
        },
        connect: (address, port) => {
          connects.push(address);
          // The documentation address stands in for the internet: it leads to this computer.
          return net.connect({ host: address === PUBLIC ? '127.0.0.1' : address, port });
        },
      },
    });
  });
  afterEach(async () => {
    await backend.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const caCert = () => readFile(backend.caCertPath, 'utf8');
  const exchange = (api: Awaited<ReturnType<typeof apiClient>>, path: string) =>
    exchangesIn(api.messages)
      .filter((e) => e.path === path)
      .at(-1);
  /** The finished exchange at `path`, once it has a status. */
  const finished = async (
    api: Awaited<ReturnType<typeof apiClient>>,
    path: string,
  ): Promise<ExchangeSummary> => {
    await expect.poll(() => exchange(api, path)?.status).toBeDefined();
    return exchange(api, path)!;
  };

  describe('lets a device reach', () => {
    it('public sites over HTTP, through the guard', async () => {
      const api = await apiClient(backend.apiPort);
      const { port } = await backend.listeners.open(PIXEL);
      const reply = await getVia(port, `http://api.example:${plainPort}/public`);
      expect(reply).toMatchObject({ status: 200, body: 'plain /public' });
      expect(seen.at(-1)?.headers.host).toBe(`api.example:${plainPort}`);
      expect(connects).toEqual([PUBLIC]);
      const recorded = await finished(api, '/public');
      expect(recorded.failure).toBeUndefined();
      expect(recorded.source).toEqual(PIXEL);
      api.close();
    });

    it('public sites over HTTPS, with the server name intact', async () => {
      const { port } = await backend.listeners.open(PIXEL);
      // The upstream picks its certificate by server name: the wrong one would fail TLS.
      const reply = await requestViaProxy(
        port,
        `https://api.example:${httpsUpstream.port}/hello`,
        await caCert(),
      );
      expect(reply).toEqual({ status: 200, body: 'hello from upstream' });
      expect(connects).toEqual([PUBLIC]);
    });

    it('public WebSockets', async () => {
      const { port } = await backend.listeners.open(PIXEL);
      expect(await upgradeVia(port, `ws://api.example:${wsPort}/socket`)).toBe(101);
      expect(connects).toEqual([PUBLIC]);
    });
  });

  describe("keeps a device from this computer and its local networks, and doesn't send the request", () => {
    it.each([
      ['127.0.0.1', '127.0.0.1', 'this computer'],
      ['localhost', '127.0.0.1', 'this computer'],
      ['[::1]', '::1', 'this computer'],
    ])('%s', async (host, address, description) => {
      const api = await apiClient(backend.apiPort);
      const { port } = await backend.listeners.open(PIXEL);
      const reply = await getVia(port, `http://${host}:${plainPort}/secret`);
      expect(reply.status).toBe(403);
      expect(seen).toEqual([]);
      const recorded = await finished(api, '/secret');
      expect(recorded.failure).toMatchObject({ kind: 'blocked', code: 'BLOCKED' });
      expect(recorded.failure?.message).toContain(`is ${address}, ${description}`);
      expect(recorded.failure?.message).toContain(LOCAL_ACCESS_SWITCH);
      expect(recorded.source).toEqual(PIXEL);
      api.close();
    });

    it('names that resolve to a local network, over HTTPS too', async () => {
      const api = await apiClient(backend.apiPort);
      const { port } = await backend.listeners.open(PIXEL);
      const reply = await requestViaProxy(
        port,
        `https://dev.lan:${httpsUpstream.port}/hello`,
        await caCert(),
      );
      expect(reply.status).toBe(403);
      const recorded = await finished(api, '/hello');
      expect(recorded.failure?.message).toContain(
        `dev.lan:${httpsUpstream.port} is 192.168.1.20, a private network address`,
      );
      expect(connects).toEqual([]);
      api.close();
    });

    it('cloud metadata, and names with any local address among their addresses', async () => {
      const { port } = await backend.listeners.open(PIXEL);
      expect((await getVia(port, 'http://metadata.example/latest/meta-data/')).status).toBe(403);
      expect((await getVia(port, 'http://169.254.169.254/latest/meta-data/')).status).toBe(403);
      expect((await getVia(port, `http://mixed.example:${plainPort}/`)).status).toBe(403);
      expect(connects).toEqual([]);
    });

    it('WebSockets', async () => {
      const { port } = await backend.listeners.open(PIXEL);
      expect(await upgradeVia(port, `ws://127.0.0.1:${wsPort}/socket`).catch(() => 0)).not.toBe(101);
      expect(wsConnections).toBe(0);
    });

    it("plugin rules' pass-through steps, however they were made", async () => {
      const { port } = await backend.listeners.open(PIXEL);
      await plugin.host!.setProxyRules([
        {
          id: 'redirect',
          label: 'Send to my dev server',
          matchers: [new mockttp.matchers.HostnameMatcher('redirect.example')],
          steps: [
            plugin.host!.passThroughStep({
              transformRequest: { replaceHost: { targetHost: `127.0.0.1:${plainPort}` } },
            }),
          ],
        },
        {
          id: 'direct',
          label: 'Made directly',
          matchers: [new mockttp.matchers.HostnameMatcher('direct.example')],
          steps: [
            new mockttp.requestSteps.PassThroughStep({
              transformRequest: { replaceHost: { targetHost: `127.0.0.1:${plainPort}` } },
            }),
          ],
        },
        {
          id: 'match-replace',
          label: 'Rewrite the host',
          matchers: [new mockttp.matchers.HostnameMatcher('match.example')],
          steps: [
            plugin.host!.passThroughStep({
              transformRequest: {
                matchReplaceHost: { replacements: [[/^match\.example/, `127.0.0.1:${plainPort}`]] },
              },
            }),
          ],
        },
        {
          id: 'callback',
          label: 'Rewrite the URL',
          matchers: [new mockttp.matchers.HostnameMatcher('callback.example')],
          steps: [
            plugin.host!.passThroughStep({
              beforeRequest: () => ({ url: `http://127.0.0.1:${plainPort}/from-callback` }),
            }),
          ],
        },
        {
          id: 'tag',
          label: 'Tag requests',
          matchers: [new mockttp.matchers.HostnameMatcher('api.example')],
          steps: [
            plugin.host!.passThroughStep({ transformRequest: { updateHeaders: { 'x-tagged': 'yes' } } }),
          ],
        },
      ]);
      expect((await getVia(port, 'http://redirect.example/')).status).toBe(403);
      expect((await getVia(port, 'http://direct.example/')).status).toBe(403);
      expect((await getVia(port, 'http://match.example/')).status).toBe(403);
      expect((await getVia(port, 'http://callback.example/')).status).toBe(403);
      expect(seen).toEqual([]);
      // A pass-through to a public site still goes, changed as the rule says.
      expect((await getVia(port, `http://api.example:${plainPort}/tagged`)).status).toBe(200);
      expect(seen.at(-1)?.headers['x-tagged']).toBe('yes');
      expect(connects).toEqual([PUBLIC]);
      // The computer's own traffic isn't affected.
      expect((await getVia(backend.proxyPort, 'http://redirect.example/')).status).toBe(200);
    });
  });

  it('lets a device reach this computer once allowed, and only that device', async () => {
    const pixel = await backend.listeners.open(PIXEL);
    const tablet = await backend.listeners.open(TABLET);
    backend.listeners.setLocalAccess(PIXEL.id, true);
    expect(backend.listeners.list().map((l) => [l.source.id, l.localAccess])).toEqual([
      [PIXEL.id, true],
      [TABLET.id, false],
    ]);
    expect((await getVia(pixel.port, `http://127.0.0.1:${plainPort}/pixel`)).status).toBe(200);
    expect((await getVia(tablet.port, `http://127.0.0.1:${plainPort}/tablet`)).status).toBe(403);
    expect(await upgradeVia(pixel.port, `ws://127.0.0.1:${wsPort}/`)).toBe(101);
    // The computer's own traffic is never checked.
    expect((await getVia(backend.proxyPort, `http://127.0.0.1:${plainPort}/mac`)).status).toBe(200);
    expect(seen.map((s) => s.path)).toEqual(['/pixel', '/mac']);
    // The choice stays with the device when its listener closes and opens again.
    await backend.listeners.close(PIXEL.id);
    const reopened = await backend.listeners.open(PIXEL);
    expect((await getVia(reopened.port, `http://127.0.0.1:${plainPort}/again`)).status).toBe(200);
  });

  it("closes a device's open connections to this computer when it may no longer reach it", async () => {
    const { port } = await backend.listeners.open(PIXEL);
    backend.listeners.setLocalAccess(PIXEL.id, true);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect((await getVia(port, `http://127.0.0.1:${plainPort}/first`, agent)).status).toBe(200);
      expect(plainSockets.size).toBe(1);
      backend.listeners.setLocalAccess(PIXEL.id, false);
      await expect.poll(() => plainSockets.size).toBe(0);
      // The same device connection can't go back to it either.
      expect((await getVia(port, `http://127.0.0.1:${plainPort}/second`, agent)).status).toBe(403);
      expect(seen.map((s) => s.path)).toEqual(['/first']);
    } finally {
      agent.destroy();
    }
  });

  it('looks each name up once, and connects to the address it checked', async () => {
    const { port } = await backend.listeners.open(PIXEL);
    expect((await getVia(port, `http://rebind.example:${plainPort}/rebind`)).status).toBe(200);
    expect(lookups.filter((h) => h === 'rebind.example')).toHaveLength(1);
    expect(connects).toEqual([PUBLIC]);
  });

  describe("reports the guard's failures the way the main proxy does", () => {
    it('a name that does not resolve', async () => {
      const api = await apiClient(backend.apiPort);
      const { port } = await backend.listeners.open(PIXEL);
      expect((await getVia(port, 'http://nowhere.example/missing')).status).toBe(502);
      const recorded = await finished(api, '/missing');
      expect(recorded.failure).toMatchObject({ kind: 'dns', code: 'ENOTFOUND' });
      api.close();
    });

    it('a refused connection', async () => {
      const api = await apiClient(backend.apiPort);
      const { port } = await backend.listeners.open(PIXEL);
      backend.listeners.setLocalAccess(PIXEL.id, true);
      expect((await getVia(port, 'http://127.0.0.1:1/closed')).status).toBe(502);
      const recorded = await finished(api, '/closed');
      expect(recorded.failure).toMatchObject({ kind: 'refused', code: 'ECONNREFUSED' });
      api.close();
    });
  });

  it("can't be fooled by a server sending the guard's header, even one it has seen", async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    const refused = await getVia(port, `http://127.0.0.1:${plainPort}/secret`);
    const id = refused.headers['x-wirescry-guard'];
    expect(id).toBeTruthy();
    await finished(api, '/secret');
    // A public server answers with that id, and with one it made up.
    for (const replay of [String(id), 'made-up']) {
      const reply = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: `http://api.example:${plainPort}/pretend-guard`,
            headers: { host: `api.example:${plainPort}`, 'x-replay': replay },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.once('error', reject);
        req.end();
      });
      expect(reply).toBe(403);
      const recorded = await finished(api, '/pretend-guard');
      expect(recorded.failure).toBeUndefined();
    }
    api.close();
  });

  it('keeps the policy across a certificate reset', async () => {
    const api = await apiClient(backend.apiPort);
    const { port } = await backend.listeners.open(PIXEL);
    await api.send({ command: 'resetCertificate' });
    await expect.poll(() => backend.listeners.list()[0]?.port).toBe(port);
    expect((await getVia(port, `http://127.0.0.1:${plainPort}/after-reset`)).status).toBe(403);
    expect(seen).toEqual([]);
    api.close();
  });
});
