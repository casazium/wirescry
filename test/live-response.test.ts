/**
 * A response that's still arriving (src/backend/proxy.ts): its status and headers show as soon as
 * they come, with `responding` and the size so far, and the summary is as before once it ends.
 * Failures, Mockttp's own replies and cut-off calls never look like a response arriving.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { harEntry, parseHar } from '../src/backend/har';
import { isLive } from '../src/backend/store';
import type { BackendPlugin } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ExchangeDetail, ExchangeSummary } from '../src/shared/api';
import { isError } from '../src/shared/filter';
import {
  apiClient,
  exchangesIn,
  httpViaProxy,
  localhostCertificate,
  NOTHING_LISTENS,
  TOKEN,
  tunnelThroughProxy,
  UI_ORIGIN,
} from './helpers';

/** Room for slow CI runners. */
const WAIT = { timeout: 10_000 };

/** A gRPC message of `n` bytes, framed. */
const frame = (n: number): Buffer => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(n, 1);
  return Buffer.concat([head, Buffer.alloc(n, 7)]);
};

/** Lets a test tell the server when to go on. */
const gates = new Map<string, () => void>();
const gate = (name: string): Promise<void> => new Promise((resolve) => gates.set(name, resolve));
const open = (name: string): void => {
  gates.get(name)?.();
  gates.delete(name);
};

type Api = Awaited<ReturnType<typeof apiClient>>;

describe('a response that is still arriving', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let h2server: http2.Http2SecureServer;
  let h1server: http.Server;
  let h2port: number;
  let h1port: number;
  let ca: string;
  let api: Api;
  const completed: ExchangeSummary[] = [];
  /** When the server wrote the message after a pause. */
  let pausedWriteAt = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-live-'));
    const upstreamCA = await generateCACertificate();
    const leaf = await localhostCertificate(upstreamCA);
    h2server = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    h2server.on('stream', (stream, headers) => {
      const route = headers[':path'];
      const grpc = { ':status': 200, 'content-type': 'application/grpc' };
      stream.on('error', () => undefined);
      if (route === '/live.Feed/Watch') {
        stream.respond({ ...grpc, 'x-live': 'yes' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.write(frame(10));
        void gate('more').then(() => {
          stream.write(frame(20));
          return gate('end').then(() => stream.end());
        });
      } else if (route === '/live.Feed/Pause') {
        stream.respond(grpc);
        void new Promise((r) => setTimeout(r, 600)).then(() => {
          pausedWriteAt = Date.now();
          stream.write(frame(3));
        });
      } else if (route === '/live.Feed/Lazy') {
        // Headers only with the first message, as many gRPC servers send them.
        void gate('lazy').then(() => {
          stream.respond(grpc);
          stream.write(frame(1));
          return gate('lazyEnd').then(() => stream.end());
        });
      } else if (route === '/live.Feed/Missing') {
        stream.respond({ ...grpc, 'grpc-status': '5' }, { endStream: true });
      } else if (route === '/live.Feed/Big') {
        stream.respond(grpc, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '9', 'grpc-message': 'late' }));
        stream.write(frame(100_000));
        setTimeout(() => stream.end(frame(10)), 800);
      } else if (route === '/live.Feed/NoHead') {
        // Gives up before any headers.
        setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 50);
      } else if (route === '/live.Feed/Reset') {
        stream.respond(grpc);
        stream.write(frame(4));
        void gate('reset').then(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
      } else if (route?.startsWith('/live.Feed/Forever')) {
        stream.respond(grpc);
        stream.write(frame(4));
      } else if (route?.startsWith('/live.Many/')) {
        stream.respond(grpc);
        const timer = setInterval(() => stream.write(frame(8)), 10);
        stream.on('close', () => clearInterval(timer));
      }
    });
    await new Promise<void>((resolve) => h2server.listen(0, '127.0.0.1', resolve));
    h2port = (h2server.address() as net.AddressInfo).port;

    h1server = http.createServer((req, res) => {
      res.on('error', () => undefined);
      if (req.url === '/chunked') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first part');
        void gate('h1end').then(() => res.end(' and the rest'));
      } else if (req.url === '/broken') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.write('going wrong');
        void gate('h1-500').then(() => res.end());
      } else if (req.url === '/cut') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('part');
        void gate('h1cut').then(() => res.socket?.destroy());
      } else if (req.url === '/forever') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('part');
      }
    });
    await new Promise<void>((resolve) => h1server.listen(0, '127.0.0.1', resolve));
    h1port = (h1server.address() as net.AddressInfo).port;

    const watcher: BackendPlugin = {
      name: 'watcher',
      apiVersion: PLUGIN_API_VERSION,
      start: () => undefined,
      stop: () => undefined,
      handle: async () => undefined,
      exchangeCompleted: (summary) => void completed.push(summary),
    };
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      plugins: [watcher],
      pluginsEnabled: true,
    });
    ca = await readFile(backend.caCertPath, 'utf8');
    api = await apiClient(backend.apiPort);
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    h2server?.close();
    h1server?.closeAllConnections();
    h1server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Every copy of the exchange with this path the UI was sent, oldest first. */
  const copies = (urlPath: string): ExchangeSummary[] =>
    exchangesIn(api.messages).filter((e) => e.path === urlPath);
  const latest = (urlPath: string): ExchangeSummary | undefined => copies(urlPath).at(-1);
  const detailOf = async (id: string): Promise<ExchangeDetail> =>
    (await api.send({ command: 'getExchange', exchangeId: id })) as ExchangeDetail;

  /** Starts a gRPC call through Wirescry; the caller decides when it ends. */
  const startCall = async (urlPath: string, port = h2port) => {
    const socket = await tunnelThroughProxy(backend.proxyPort, `localhost:${port}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${port}`, { createConnection: () => secure });
    session.on('error', () => undefined);
    const req = session.request(
      { ':method': 'POST', ':path': urlPath, 'content-type': 'application/grpc', te: 'trailers' },
      { endStream: true },
    );
    req.on('error', () => undefined);
    req.resume();
    const closed = new Promise<void>((resolve) => req.on('close', resolve));
    return {
      req,
      closed,
      end: async () => {
        req.close();
        await closed;
        session.close();
      },
    };
  };

  /** Starts an HTTP/1.1 request through Wirescry's proxy; resolves once the head has arrived. */
  const startH1 = (urlPath: string) =>
    new Promise<{ res: http.IncomingMessage; req: http.ClientRequest }>((resolve, reject) => {
      const url = `http://127.0.0.1:${h1port}${urlPath}`;
      const req = http.request(
        { host: '127.0.0.1', port: backend.proxyPort, path: url, headers: { host: `127.0.0.1:${h1port}` } },
        (res) => {
          res.on('error', () => undefined);
          res.resume();
          resolve({ res, req });
        },
      );
      req.on('error', reject);
      req.end();
    });

  /** Waits until the newest copy of the exchange matches. */
  const until = async (urlPath: string, check: (e: ExchangeSummary) => boolean): Promise<ExchangeSummary> => {
    let found: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        const e = latest(urlPath);
        found = e && check(e) ? e : undefined;
        return found;
      }, WAIT)
      .toBeDefined();
    return found!;
  };

  it("shows a stream's status and headers before it ends, and its size as it grows", async () => {
    const call = await startCall('/live.Feed/Watch');
    const first = await until('/live.Feed/Watch', (e) => e.responseReceived === 15);
    expect(first).toMatchObject({
      status: 200,
      responding: true,
      contentType: 'application/grpc',
      grpc: true,
    });
    expect(first.durationMs).toBeUndefined();
    expect(first.responseSize).toBeUndefined();
    expect(isLive(first)).toBe(true);
    const head = await detailOf(first.id);
    expect(head.responseHeaders).toContainEqual(['x-live', 'yes']);
    // Not finished, so plugins haven't been told.
    expect(completed.filter((e) => e.id === first.id)).toEqual([]);

    open('more');
    await until('/live.Feed/Watch', (e) => e.responseReceived === 40);
    open('end');
    const done = await until('/live.Feed/Watch', (e) => e.durationMs !== undefined);
    expect(done).toMatchObject({ status: 200, responseSize: 40, grpcStatus: 0 });
    expect(done.responding).toBeUndefined();
    expect(done.responseReceived).toBeUndefined();
    expect(isLive(done)).toBe(false);
    await expect.poll(() => completed.filter((e) => e.id === done.id).length, WAIT).toBe(1);
    // Plugins are told once it has really finished: with its duration and gRPC status.
    const told = completed.find((e) => e.id === done.id)!;
    expect(told).toMatchObject({ grpcStatus: 0, responseSize: 40 });
    expect(told.durationMs).toBeDefined();
    expect(told.responding).toBeUndefined();
    await call.closed;

    // Nothing more is said about it afterwards: no late size update.
    const count = copies('/live.Feed/Watch').length;
    await new Promise((r) => setTimeout(r, 600));
    expect(
      copies('/live.Feed/Watch')
        .slice(count)
        .filter((e) => e.responding || e.responseReceived),
    ).toEqual([]);
  });

  it('reports a message that comes after a pause, without waiting for more', async () => {
    const call = await startCall('/live.Feed/Pause');
    await until('/live.Feed/Pause', (e) => e.responding === true);
    const seen = await until('/live.Feed/Pause', (e) => e.responseReceived === 8);
    // Reported by the timer that was waiting, a quarter of a second after the write (plus CI's slack).
    expect(Date.now() - pausedWriteAt).toBeLessThan(1500);
    expect(seen.responding).toBe(true);
    await call.end();
  });

  it('shows the headers when a server sends them with its first message', async () => {
    const call = await startCall('/live.Feed/Lazy');
    await until('/live.Feed/Lazy', () => true);
    await new Promise((r) => setTimeout(r, 300));
    expect(latest('/live.Feed/Lazy')?.status).toBeUndefined();
    open('lazy');
    const live = await until('/live.Feed/Lazy', (e) => e.responseReceived === 6);
    expect(live).toMatchObject({ status: 200, responding: true });
    open('lazyEnd');
    const done = await until('/live.Feed/Lazy', (e) => e.durationMs !== undefined);
    expect(done).toMatchObject({ status: 200, responseSize: 6 });
    expect(done.responding).toBeUndefined();
    await call.closed;
  });

  it('keeps an error sent with the headers alone as before', async () => {
    const call = await startCall('/live.Feed/Missing');
    await call.closed;
    const done = await until('/live.Feed/Missing', (e) => e.durationMs !== undefined);
    expect(done).toMatchObject({ status: 200, grpcStatus: 5 });
    expect(done.responding).toBeUndefined();
    expect(done.responseReceived).toBeUndefined();
  });

  it('keeps the status of a stream that sent over 64 KB before pausing', async () => {
    const call = await startCall('/live.Feed/Big');
    const live = await until('/live.Feed/Big', (e) => (e.responseReceived ?? 0) >= 100_005);
    expect(live.durationMs).toBeUndefined();
    await call.closed;
    const done = await until('/live.Feed/Big', (e) => e.durationMs !== undefined);
    expect(done).toMatchObject({ grpcStatus: 9, grpcMessage: 'late', responseSize: 100_020 });
    expect(done.responding).toBeUndefined();
    const detail = await detailOf(done.id);
    expect(detail.responseTrailers).toContainEqual(['grpc-status', '9']);
  });

  it('shows an HTTP/1.1 response arriving in chunks', async () => {
    const { res } = await startH1('/chunked');
    const live = await until('/chunked', (e) => e.responseReceived === 10);
    expect(live).toMatchObject({ status: 200, responding: true, contentType: 'text/plain' });
    open('h1end');
    await new Promise((r) => res.on('end', r));
    const done = await until('/chunked', (e) => e.durationMs !== undefined);
    expect(done).toMatchObject({ status: 200, responseSize: 23 });
    expect(done.responding).toBeUndefined();
  });

  it('counts a server error under Errors while it is still arriving', async () => {
    const { res } = await startH1('/broken');
    const live = await until('/broken', (e) => e.responding === true);
    expect(live.status).toBe(500);
    expect(isError(live)).toBe(true);
    open('h1-500');
    await new Promise((r) => res.on('end', r));
    expect(isError(await until('/broken', (e) => e.durationMs !== undefined))).toBe(true);
  });

  describe('never looks like a response arriving when', () => {
    it('the server gives up before sending headers', async () => {
      const call = await startCall('/live.Feed/NoHead');
      await call.closed;
      const done = await until('/live.Feed/NoHead', (e) => e.failure !== undefined);
      expect(copies('/live.Feed/NoHead').filter((e) => e.responding)).toEqual([]);
      expect(done.responding).toBeUndefined();
    });

    it('nothing listens, over HTTP/2', async () => {
      const call = await startCall('/nobody.h2/Call', NOTHING_LISTENS);
      await call.closed;
      const done = await until('/nobody.h2/Call', (e) => e.failure !== undefined);
      expect(done.failure?.kind).toBe('refused');
      expect(
        copies('/nobody.h2/Call').filter((e) => e.responding || e.responseReceived !== undefined),
      ).toEqual([]);
    });

    it('nothing listens, and Wirescry replies with its own error', async () => {
      const result = await httpViaProxy(backend.proxyPort, `http://127.0.0.1:${NOTHING_LISTENS}/nobody`);
      expect(result.status).toBe(502);
      const done = await until('/nobody', (e) => e.failure !== undefined);
      expect(done.failure?.kind).toBe('refused');
      expect(copies('/nobody').filter((e) => e.responding || e.responseReceived !== undefined)).toEqual([]);
    });
  });

  it("isn't recorded at all while recording is paused", async () => {
    await api.send({ command: 'setPaused', paused: true });
    try {
      const call = await startCall('/live.Feed/Forever?paused');
      await new Promise((r) => setTimeout(r, 600));
      await call.end();
    } finally {
      await api.send({ command: 'setPaused', paused: false });
    }
    expect(copies('/live.Feed/Forever?paused')).toEqual([]);
  });

  it('says nothing more about a call cleared from the list while it arrives', async () => {
    const call = await startCall('/live.Feed/Forever?cleared');
    const live = await until('/live.Feed/Forever?cleared', (e) => e.responseReceived === 9);
    await api.send({ command: 'clear', ids: [live.id] });
    const count = copies('/live.Feed/Forever?cleared').length;
    await new Promise((r) => setTimeout(r, 600));
    await call.end();
    await new Promise((r) => setTimeout(r, 300));
    expect(copies('/live.Feed/Forever?cleared').slice(count)).toEqual([]);
  });

  describe('stops responding when the call is cut off', () => {
    it('by the client, over HTTP/2', async () => {
      const call = await startCall('/live.Feed/Forever');
      await until('/live.Feed/Forever', (e) => e.responseReceived === 9);
      await call.end();
      const done = await until('/live.Feed/Forever', (e) => e.failure !== undefined);
      expect(done.failure?.kind).toBe('client-closed');
      expect(done.responding).toBeUndefined();
      expect(done.responseReceived).toBeUndefined();
      expect(isLive(done)).toBe(false);
    });

    it('by the server, over HTTP/2', async () => {
      const call = await startCall('/live.Feed/Reset');
      await until('/live.Feed/Reset', (e) => e.responseReceived === 9);
      open('reset');
      await call.closed;
      // A known Mockttp issue over HTTP/2 (grpc-design.md, item 2): a server that breaks off
      // looks like one that finished. Either way it's no longer shown as arriving.
      const done = await until(
        '/live.Feed/Reset',
        (e) => e.durationMs !== undefined || e.failure !== undefined,
      );
      expect(done.status).toBe(200);
      expect(done.responding).toBeUndefined();
      expect(done.responseReceived).toBeUndefined();
      expect(isLive(done)).toBe(false);
    });

    it('by the client, over HTTP/1.1', async () => {
      const { req } = await startH1('/forever');
      await until('/forever', (e) => e.responseReceived === 4);
      req.destroy();
      const done = await until('/forever', (e) => e.failure !== undefined);
      expect(done.responding).toBeUndefined();
      expect(done.responseReceived).toBeUndefined();
    });

    it('by the server, over HTTP/1.1', async () => {
      const { res } = await startH1('/cut');
      await until('/cut', (e) => e.responseReceived === 4);
      open('h1cut');
      await new Promise((r) => res.on('close', r));
      const done = await until('/cut', (e) => e.failure !== undefined);
      expect(done.failure).toMatchObject({ partial: true });
      expect(done.status).toBe(200);
      expect(done.responding).toBeUndefined();
      expect(done.responseReceived).toBeUndefined();
    });
  });

  it('sends a busy stream to the UI a few times a second, not on every chunk', async () => {
    const calls = await Promise.all(Array.from({ length: 50 }, (_, i) => startCall(`/live.Many/${i}`)));
    await until('/live.Many/49', (e) => e.responding === true);
    const before = new Map(Array.from({ length: 50 }, (_, i) => [i, copies(`/live.Many/${i}`).length]));
    await new Promise((r) => setTimeout(r, 1000));
    for (let i = 0; i < 50; i++) {
      const sent = copies(`/live.Many/${i}`).length - before.get(i)!;
      // Every 10 ms a chunk arrives; at most 4 updates a second go out (one more for timing).
      expect(sent).toBeGreaterThan(0);
      expect(sent).toBeLessThanOrEqual(5);
    }
    await Promise.all(calls.map((c) => c.end()));
  });

  // Last: it moves the proxy to another port.
  it('ends a response that was arriving when the proxy restarted', async () => {
    const call = await startCall('/live.Feed/Forever?restart');
    await until('/live.Feed/Forever?restart', (e) => e.responseReceived === 9);
    await api.send({ command: 'setProxyPort', port: null });
    const done = await until('/live.Feed/Forever?restart', (e) => e.responding === undefined);
    expect(done.failure).toBeDefined();
    expect(done.responseReceived).toBeUndefined();
    expect(isLive(done)).toBe(false);
    await call.end();
  });
});

describe('a still-arriving response in a HAR file', () => {
  const detail = (summary: Partial<ExchangeSummary>): ExchangeDetail => ({
    summary: {
      id: 'h',
      method: 'POST',
      protocol: 'https',
      httpVersion: '2.0',
      host: 'api.test',
      path: '/x.Y/Z',
      url: 'https://api.test/x.Y/Z',
      startedAt: 0,
      status: 200,
      ...summary,
    },
    requestHeaders: [],
    responseHeaders: [['content-type', 'application/grpc']],
    timing: { startTimestamp: 0 },
  });

  it('exports it as cut off, so it comes back as unfinished, not as an empty reply', async () => {
    const entry = harEntry({
      detail: detail({ responding: true, responseReceived: 30 }),
      requestBody: null,
      responseBody: null,
    });
    expect(entry._error).toBe('The response was still arriving when this was exported.');
    expect((entry.response as { bodySize: number }).bodySize).toBe(-1);
    const [back] = (await parseHar(JSON.stringify({ log: { version: '1.2', entries: [entry] } }), 10))
      .exchanges;
    expect(back!.summary.failure).toMatchObject({
      kind: 'other',
      code: 'INCOMPLETE',
      partial: true,
      message: 'The response was still arriving when this was exported.',
    });
    // Shown as cut off part way, not as a finished reply.
    expect(isError(back!.summary as ExchangeSummary)).toBe(true);
  });

  it("doesn't for a finished one", () => {
    const entry = harEntry({
      detail: detail({ durationMs: 5, responseSize: 0 }),
      requestBody: null,
      responseBody: null,
    });
    expect(entry._error).toBeUndefined();
    expect((entry.response as { bodySize: number }).bodySize).toBe(0);
  });
});
