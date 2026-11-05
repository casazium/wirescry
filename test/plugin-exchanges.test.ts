import { PassThrough } from 'node:stream';
import * as mockttpModule from 'mockttp';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { getLocal, type Mockttp } from 'mockttp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { PluginHost, validateAnnotation } from '../src/backend/plugin-host';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ExchangeSummary } from '../src/shared/api';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** Room for slow CI runners (GitHub's Windows ones especially): the default is 1 s. */
const SLOW_CI = { timeout: 10_000 };

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
    [{ label: 'Spec', tone: 'ok', title: 5 }, 'must be text'],
    [{ label: 'Spec\u200e', tone: 'ok' }, '1 to 16'],
    [{ label: 'Sp\ufeffec', tone: 'ok' }, '1 to 16'],
    [{ label: '\u2060', tone: 'ok' }, '1 to 16'],
    [{ label: '😀'.repeat(17), tone: 'ok' }, '1 to 16'],
    // Characters that could disguise the path beside the badge.
    [{ label: '\u202eSpec', tone: 'ok' }, '1 to 16'],
    [{ label: '\u200b', tone: 'ok' }, '1 to 16'],
    [{ label: 'Spec\u2028', tone: 'ok' }, '1 to 16'],
    [{ label: 'Spec\u0085', tone: 'ok' }, '1 to 16'],
  ])('refuses %j', (annotation, message) => {
    expect(() => validateAnnotation(annotation)).toThrow(message);
  });
});

describe('validateAnnotation and real-world text', () => {
  it('allows emoji, joiners and scripts that need them, counting characters not UTF-16 units', () => {
    for (const label of ['👩‍💻 Dev', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🇫🇷 OK', 'می‌خواهم', 'क्‍ष', '😀'.repeat(16)]) {
      expect(validateAnnotation({ label, tone: 'ok' }).label).toBe(label);
    }
  });

  it('tidies a title instead of refusing it: unsafe characters and runs of space become one space, cut to 200', () => {
    expect(
      validateAnnotation({ label: 'Spec', tone: 'ok', title: 'Pet\nstore\t API \u202e2.0\u0007 ' }).title,
    ).toBe('Pet store API 2.0');
    expect(validateAnnotation({ label: 'Spec', tone: 'ok', title: 'x'.repeat(250) }).title).toHaveLength(200);
    expect(validateAnnotation({ label: 'Spec', tone: 'ok', title: '😀'.repeat(250) }).title).toBe(
      '😀'.repeat(200),
    );
    // Nothing left: no title.
    expect(validateAnnotation({ label: 'Spec', tone: 'ok', title: '\u2066\n ' })).toEqual({
      label: 'Spec',
      tone: 'ok',
    });
  });
});

describe('validateAnnotation and getters', () => {
  it('reads each field once, so a getter can’t change its answer after the check', () => {
    let reads = 0;
    const sneaky = {
      get label() {
        reads += 1;
        return reads === 1 ? 'Spec' : '\u202eevil';
      },
      tone: 'ok',
    };
    expect(validateAnnotation(sneaky)).toEqual({ label: 'Spec', tone: 'ok' });
    expect(reads).toBe(1);
  });
});

describe('PluginHost and a plugin’s lifetime', () => {
  const host = (plugin: BackendPlugin) =>
    new PluginHost({
      plugins: [plugin],
      enabled: true,
      disabledReason: 'off',
      dataDir: os.tmpdir(),
      app: { version: '1', releaseDate: new Date().toISOString() },
      refreshRules: async () => undefined,
      passThroughStep: () => ({}) as never,
      emit: () => undefined,
      onStatusChange: () => undefined,
      getExchange: () => ({ summary: summary, requestHeaders: [], timing: {} }) as never,
      getBody: async () => ({ base64: '', size: 0, truncated: false }),
      annotate: (...args) => annotated.push(args),
      clearAnnotations: () => undefined,
    });
  const summary = {
    id: 'x',
    method: 'GET',
    protocol: 'http',
    httpVersion: '1.1',
    host: 'a',
    path: '/',
    url: 'http://a/',
    startedAt: 0,
  };
  let annotated: unknown[][] = [];
  beforeEach(() => {
    annotated = [];
  });

  it('isn’t told about exchanges until it has started, nor after it has stopped', async () => {
    const plugin = watcher();
    let finishStart: () => void = () => undefined;
    plugin.start = (h) => {
      plugin.host = h;
      return new Promise<void>((resolve) => (finishStart = resolve));
    };
    const pluginHost = host(plugin);
    const starting = pluginHost.startAll();
    // Until its start() is under way; a fixed wait was too short on a slow machine.
    await vi.waitFor(() => expect(plugin.host).toBeDefined());
    pluginHost.exchangeCompleted(summary);
    expect(plugin.completed).toEqual([]);
    // Nor can it read or badge anything yet.
    expect(plugin.host!.getExchange('x')).toBeUndefined();
    expect(await plugin.host!.getBody('x', 'response')).toBeNull();
    plugin.host!.annotate('x', { label: 'Early', tone: 'ok' });
    expect(annotated).toEqual([]);
    finishStart();
    await starting;
    pluginHost.exchangeCompleted(summary);
    expect(plugin.completed).toHaveLength(1);

    // Once started, it can.
    expect(plugin.host!.getExchange('x')).toBeDefined();
    plugin.host!.annotate('x', { label: 'Now', tone: 'ok' });
    expect(annotated).toEqual([['watcher', 'x', { label: 'Now', tone: 'ok' }]]);
    annotated = [];

    await pluginHost.stopAll();
    pluginHost.exchangeCompleted(summary);
    expect(plugin.completed).toHaveLength(1);
    // Nor can it read or badge anything once stopped.
    expect(plugin.host!.getExchange('x')).toBeUndefined();
    expect(await plugin.host!.getBody('x', 'response')).toBeNull();
    plugin.host!.annotate('x', { label: 'Late', tone: 'ok' });
    expect(annotated).toEqual([]);
    expect(pluginHost.statuses()[0]).toMatchObject({ active: false, reason: 'Stopped.' });
  });

  it('logs only the first few of a plugin’s repeated errors', async () => {
    const plugin = watcher();
    plugin.exchangeCompleted = () => {
      throw new Error('again');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pluginHost = host(plugin);
    await pluginHost.startAll();
    for (let i = 0; i < 50; i++) pluginHost.exchangeCompleted(summary);
    expect(errors.mock.calls.filter(([m]) => String(m).includes('exchangeCompleted'))).toHaveLength(5);
    // ...then every thousandth.
    for (let i = 50; i < 2000; i++) pluginHost.exchangeCompleted(summary);
    const logged = errors.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('exchangeCompleted'));
    expect(logged).toHaveLength(7);
    expect(logged.at(-2)).toContain('(error 1000)');
    expect(logged.at(-1)).toContain('(error 2000)');
    errors.mockRestore();
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
    await expect.poll(() => plugin.completed.length, SLOW_CI).toBe(1);
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

  it('tells it at once about a response with no body', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    const sent = Date.now();
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/empty`);
    await expect.poll(() => plugin.completed.length, SLOW_CI).toBe(1);
    // Not after the 10 s wait for a body that never comes.
    expect(Date.now() - sent).toBeLessThan(3000);
  });

  it('tells it once about a mocked response and a composed request, and not while paused', async () => {
    const plugin = watcher();
    plugin.start = async (host) => {
      plugin.host = host;
      await host.setProxyRules([
        {
          id: 'mock',
          label: 'Mock',
          matchers: [new mockttpModule.matchers.HostnameMatcher('mocked.test')],
          steps: [new mockttpModule.requestSteps.FixedResponseStep(418, undefined, 'tea')],
        },
      ]);
    };
    const b = await start([plugin]);
    const api = await apiClient(b.apiPort);
    await httpViaProxy(b.proxyPort, 'http://mocked.test/brew');
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: { method: 'POST', url: `http://localhost:${upstream.port}/echo`, headers: [], body: 'hi' },
    });
    await expect.poll(() => plugin.completed.map((e) => e.path).sort(), SLOW_CI).toEqual(['/brew', '/echo']);
    expect(plugin.completed.find((e) => e.id === exchangeId)?.composed).toBe(true);
    expect(plugin.completed.find((e) => e.path === '/brew')?.status).toBe(418);

    await api.send({ command: 'setPaused', paused: true });
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json?paused=1`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(plugin.completed.some((e) => e.path.includes('paused'))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plugin.completed).toHaveLength(2);
    api.close();
  });

  it('tells it once about a response the client cut off, with what arrived', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    const stalling = new PassThrough();
    stalling.write('first part ');
    await upstream.forGet('/stalls').thenStream(200, stalling, { 'content-type': 'text/plain' });
    const req = http.request({
      host: '127.0.0.1',
      port: b.proxyPort,
      path: `http://localhost:${upstream.port}/stalls`,
    });
    req.on('error', () => undefined);
    req.on('response', (res) => res.once('data', () => req.destroy()));
    req.end();
    try {
      await expect.poll(() => plugin.completed.length, { timeout: 12_000 }).toBe(1);
      expect(plugin.completed[0]).toMatchObject({
        status: 200,
        failure: { kind: 'client-closed', partial: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(plugin.completed).toHaveLength(1);
    } finally {
      stalling.destroy();
    }
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
    await expect.poll(() => plugin.completed.map((e) => e.url), SLOW_CI).toEqual(['https://api.example/x']);
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
    await expect.poll(() => exchangesIn(api.messages).some((e) => e.websocket), SLOW_CI).toBe(true);
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
    await expect.poll(() => fine.completed.length, SLOW_CI).toBe(1);
    expect((await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`)).status).toBe(200);
  });

  it('lets a plugin read the exchange and its decoded body, as copies', async () => {
    const plugin = watcher();
    const b = await start([plugin]);
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length, SLOW_CI).toBe(1);
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
    await expect.poll(() => plugin.completed.length, SLOW_CI).toBe(1);
    const id = plugin.completed[0]!.id;
    const latest = () =>
      exchangesIn(api.messages)
        .filter((e) => e.id === id)
        .at(-1);
    await expect
      .poll(() => latest()?.annotations, SLOW_CI)
      .toEqual([{ plugin: 'watcher', label: 'Spec', tone: 'ok', title: 'Matches getThing' }]);
    // Still there after the body's sizes and everything else are recorded.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plugin.host!.getExchange(id)!.summary.annotations).toHaveLength(1);

    plugin.host!.annotate(id, { label: 'Spec', tone: 'warn' });
    await expect
      .poll(() => latest()?.annotations, SLOW_CI)
      .toEqual([{ plugin: 'watcher', label: 'Spec', tone: 'warn' }]);
    plugin.host!.annotate(id, undefined);
    await expect.poll(() => latest()?.annotations, SLOW_CI).toBeUndefined();
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
    await expect.poll(() => one.completed.length, SLOW_CI).toBe(1);
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
    await expect.poll(() => plugin.completed.length, SLOW_CI).toBe(1);
    await api.send({ command: 'clear' });
    await httpViaProxy(b.proxyPort, `http://localhost:${upstream.port}/json`);
    await expect.poll(() => plugin.completed.length, SLOW_CI).toBe(2);
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
