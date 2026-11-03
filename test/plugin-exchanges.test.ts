import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { getLocal, type Mockttp } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { validateAnnotation } from '../src/backend/plugin-host';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ExchangeSummary } from '../src/shared/api';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** A plugin that records what it's told, and keeps its host for the test to use. */
function watcher(): BackendPlugin & { host?: BackendPluginHost; completed: ExchangeSummary[] } {
  const plugin: BackendPlugin & { host?: BackendPluginHost; completed: ExchangeSummary[] } = {
    name: 'watcher',
    apiVersion: PLUGIN_API_VERSION,
    completed: [],
    start(host) {
      plugin.host = host;
    },
    async handle() {
      return undefined;
    },
    exchangeCompleted(exchange) {
      plugin.completed.push(exchange);
    },
  };
  return plugin;
}

describe('validateAnnotation', () => {
  it('keeps a valid badge, without extra fields', () => {
    expect(validateAnnotation({ label: 'Spec', tone: 'ok', title: 'Matches', extra: 1 })).toEqual({
      label: 'Spec',
      tone: 'ok',
      title: 'Matches',
    });
    expect(validateAnnotation({ label: 'x'.repeat(16), tone: 'info' })).toEqual({
      label: 'x'.repeat(16),
      tone: 'info',
    });
  });

  it.each([
    [null, 'must be an object'],
    ['Spec', 'must be an object'],
    [{ label: '', tone: 'ok' }, '1 to 16'],
    [{ label: '   ', tone: 'ok' }, '1 to 16'],
    [{ label: 'x'.repeat(17), tone: 'ok' }, '1 to 16'],
    [{ label: 'a\nb', tone: 'ok' }, '1 to 16'],
    [{ label: 3, tone: 'ok' }, '1 to 16'],
    [{ label: 'Spec', tone: 'error' }, 'ok, warn or info'],
    [{ label: 'Spec' }, 'ok, warn or info'],
    [{ label: 'Spec', tone: 'ok', title: 'x'.repeat(201) }, 'at most 200'],
    [{ label: 'Spec', tone: 'ok', title: 'a\u0007b' }, 'at most 200'],
    [{ label: 'Spec', tone: 'ok', title: 5 }, 'at most 200'],
  ])('refuses %j', (annotation, message) => {
    expect(() => validateAnnotation(annotation)).toThrow(message);
  });
});

describe('plugins and finished exchanges', () => {
  let upstream: Mockttp;
  let dataDir: string;
  let backend: RunningBackend | undefined;

  beforeAll(async () => {
    upstream = getLocal();
    await upstream.start();
    await upstream.forGet('/json').thenReply(200, gzipSync('{"a":1}'), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    await upstream.forGet('/empty').thenReply(204);
    await upstream
      .forPost('/echo')
      .thenCallback(async (req) => ({ status: 201, body: await req.body.getText() }));
    await upstream.forAnyWebSocket().thenEcho();
  });
  afterAll(async () => {
    await upstream?.stop();
  });

  const start = async (plugins: BackendPlugin[], pluginsEnabled = true) => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-plugin-exchanges-'));
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins,
      pluginsEnabled,
    });
    return backend;
  };
  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('tells a plugin once that an exchange finished, with its response and body recorded', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length).toBe(1);
    expect(plugin.completed[0]).toMatchObject({
      path: '/json',
      status: 200,
      responseSize: expect.any(Number),
    });
    // Later updates to the same exchange don't tell it again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plugin.completed).toHaveLength(1);
  });

  it('tells it about a response with no body, and a request that failed', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/empty`);
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await httpViaProxy(b.proxyPort, `http://127.0.0.1:${port}/gone`).catch(() => undefined);
    await expect
      .poll(() => plugin.completed.map((e) => e.path).sort(), { timeout: 5000 })
      .toEqual(['/empty', '/gone']);
    expect(plugin.completed.find((e) => e.path === '/empty')?.status).toBe(204);
    expect(plugin.completed.find((e) => e.path === '/gone')?.failure).toBeDefined();
  });

  it('tells it about exchanges imported from a HAR file', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    const file = path.join(dataDir, 'one.har');
    await writeFile(
      file,
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              startedDateTime: new Date().toISOString(),
              time: 5,
              request: { method: 'GET', url: 'https://api.example/x', httpVersion: 'HTTP/1.1', headers: [] },
              response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], content: {} },
              timings: { send: 1, wait: 3, receive: 1 },
            },
          ],
        },
      }),
    );
    await b.importHar(file);
    await expect.poll(() => plugin.completed.map((e) => e.url)).toEqual(['https://api.example/x']);
    expect(plugin.completed[0]?.imported).toBe(true);
  });

  it('never tells it about WebSockets', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    const api = await apiClient(b.apiPort);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    const target = `localhost:${upstream.port}`;
    const socket = await tunnel(b.proxyPort, target);
    const ws = new WebSocket(`ws://${target}/socket`, { createConnection: () => socket });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send('hi');
        ws.once('message', () => {
          ws.close();
          resolve();
        });
      });
      ws.once('error', reject);
    });
    // It was captured...
    await expect.poll(() => exchangesIn(api.messages).some((e) => e.websocket)).toBe(true);
    // ...and the plugin wasn't told about it, even after the 2 s wait for a body.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(plugin.completed.map((e) => e.path)).toEqual(['/json']);
    api.close();
  });

  it('doesn’t tell a plugin that isn’t running', async () => {
    const plugin = watcher();
    const b = await start([plugin], false);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(plugin.completed).toEqual([]);
  });

  it('keeps working when a plugin throws or rejects', async () => {
    const throwing = watcher();
    throwing.name = 'throws';
    throwing.exchangeCompleted = () => {
      throw new Error('boom');
    };
    const rejecting = watcher();
    rejecting.name = 'rejects';
    rejecting.exchangeCompleted = async () => {
      throw new Error('later boom');
    };
    const fine = watcher();
    const b = await start([throwing, rejecting, fine]);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => fine.completed.length).toBe(1);
    expect((await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`)).status).toBe(200);
  });

  it('lets a plugin read the exchange and its decoded body, as copies', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length).toBe(1);
    const id = plugin.completed[0]!.id;
    const detail = plugin.host!.getExchange(id)!;
    expect(detail.summary.path).toBe('/json');
    detail.summary.path = '/changed';
    detail.requestHeaders.length = 0;
    expect(plugin.host!.getExchange(id)!.summary.path).toBe('/json');
    expect(plugin.host!.getExchange(id)!.requestHeaders.length).toBeGreaterThan(0);
    const body = await plugin.host!.getBody(id, 'response');
    expect(Buffer.from(body!.base64, 'base64').toString()).toBe('{"a":1}');
    expect(await plugin.host!.getBody(id, 'request')).toBeNull();
    expect(plugin.host!.getExchange('no-such-id')).toBeUndefined();
    expect(await plugin.host!.getBody('no-such-id', 'response')).toBeNull();
    await expect(plugin.host!.getBody(id, 'sideways' as 'request')).rejects.toThrow('request or response');
  });

  it('shows a plugin’s badge on the exchange, replaces it, keeps it through updates, and removes it', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    const api = await apiClient(b.apiPort);
    // Badged as soon as it finishes, while the proxy may still be updating it.
    plugin.exchangeCompleted = (exchange) => {
      plugin.completed.push(exchange);
      plugin.host!.annotate(exchange.id, { label: 'Spec', tone: 'ok', title: 'Matches getThing' });
    };
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length).toBe(1);
    const id = plugin.completed[0]!.id;
    const latest = () =>
      exchangesIn(api.messages)
        .filter((e) => e.id === id)
        .at(-1);
    await expect
      .poll(() => latest()?.annotations)
      .toEqual([{ plugin: 'watcher', label: 'Spec', tone: 'ok', title: 'Matches getThing' }]);
    // Still there after the body's sizes and everything else are recorded.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plugin.host!.getExchange(id)!.summary.annotations).toHaveLength(1);

    plugin.host!.annotate(id, { label: 'Spec', tone: 'warn' });
    await expect
      .poll(() => latest()?.annotations)
      .toEqual([{ plugin: 'watcher', label: 'Spec', tone: 'warn' }]);
    plugin.host!.annotate(id, undefined);
    await expect.poll(() => latest()?.annotations).toBeUndefined();
    // Unknown exchanges are ignored; bad badges are refused.
    expect(() => plugin.host!.annotate('no-such-id', { label: 'Spec', tone: 'ok' })).not.toThrow();
    expect(() => plugin.host!.annotate(id, { label: 'Way too long a label', tone: 'ok' })).toThrow('1 to 16');
    api.close();
  });

  it('keeps each plugin’s badge separate', async () => {
    const one = watcher();
    const two = watcher();
    two.name = 'second';
    const b = await start([one, two]);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => one.completed.length).toBe(1);
    const id = one.completed[0]!.id;
    one.host!.annotate(id, { label: 'One', tone: 'ok' });
    two.host!.annotate(id, { label: 'Two', tone: 'info' });
    one.host!.annotate(id, { label: 'One again', tone: 'warn' });
    expect(b && one.host!.getExchange(id)!.summary.annotations).toEqual([
      { plugin: 'second', label: 'Two', tone: 'info' },
      { plugin: 'watcher', label: 'One again', tone: 'warn' },
    ]);
    two.host!.annotate(id, undefined);
    expect(one.host!.getExchange(id)!.summary.annotations).toEqual([
      { plugin: 'watcher', label: 'One again', tone: 'warn' },
    ]);
  });

  it('tells it again about an exchange cleared and captured anew', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    const api = await apiClient(b.apiPort);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length).toBe(1);
    await api.send({ command: 'clear' });
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length).toBe(2);
    expect(plugin.completed[0]!.id).not.toBe(plugin.completed[1]!.id);
    api.close();
  });
});

/** Opens a CONNECT tunnel through the proxy, as the WebSocket tests do. */
function tunnel(proxyPort: number, target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.once('connect', (_res, socket) => resolve(socket));
    req.once('error', reject);
    req.end();
  });
}
