/**
 * A Server-Sent Events stream through the real backend: its events read with getSseEvents while
 * it's still going and after, compressed with gzip as it's sent.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ExchangeSummary, SseEventsView } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const WAIT = { timeout: 10_000 };

describe('an event stream through Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let server: http.Server;
  let port: number;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let finish: () => void = () => undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-sse-'));
    server = http.createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
        const gzip = zlib.createGzip();
        gzip.pipe(res);
        const send = (text: string) => {
          gzip.write(text);
          gzip.flush(zlib.constants.Z_SYNC_FLUSH);
        };
        send(': hello\nretry: 2000\n\nevent: tick\nid: 1\ndata: first\n\n');
        finish = () => {
          send('data: second\ndata: line two\n\n');
          gzip.end();
        };
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not events');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
    backend = await startBackend({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });
    api = await apiClient(backend.apiPort);
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    server?.closeAllConnections();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const latest = (urlPath: string): ExchangeSummary | undefined =>
    exchangesIn(api.messages)
      .filter((e) => e.path === urlPath)
      .at(-1);
  /** A GET through Wirescry: resolves once the head is in, with a promise for its end. */
  const get = (urlPath: string) =>
    new Promise<{ ended: Promise<void> }>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: backend.proxyPort,
            path: `http://127.0.0.1:${port}${urlPath}`,
            headers: { host: `127.0.0.1:${port}` },
          },
          (res) => {
            const ended = new Promise<void>((done) => res.on('end', done));
            res.resume();
            resolve({ ended });
          },
        )
        .on('error', reject);
    });
  const events = async (id: string, after = 0) =>
    (await api.send({ command: 'getSseEvents', exchangeId: id, after })) as SseEventsView | null;

  it('reads its events while it’s going, then the rest once it ends', async () => {
    const { ended } = await get('/events');
    await expect.poll(() => latest('/events')?.responding, WAIT).toBe(true);
    const id = latest('/events')!.id;
    let live: SseEventsView | null = null;
    await expect
      .poll(async () => {
        live = await events(id);
        return live?.total;
      }, WAIT)
      .toBe(3);
    expect(live!.receiving).toBe(true);
    expect(live!.items).toEqual([
      { kind: 'comment', index: 1, text: 'hello' },
      { kind: 'retry', index: 2, ms: 2000 },
      { kind: 'event', index: 3, type: 'tick', data: 'first', id: '1' },
    ]);

    finish();
    await ended;
    await expect.poll(() => latest('/events')?.responseSize, WAIT).toBeDefined();
    let done: SseEventsView | null = null;
    await expect
      .poll(async () => {
        done = await events(id, 3);
        return done?.receiving;
      }, WAIT)
      .toBe(false);
    expect(done!.items).toEqual([
      { kind: 'event', index: 4, type: 'message', data: 'second\nline two', id: '1' },
    ]);
    expect(done!.total).toBe(4);
  });

  it('reads an event stream imported from a HAR file, whose body is stored decoded', async () => {
    const file = path.join(dataDir, 'events.har');
    const entry = {
      startedDateTime: new Date().toISOString(),
      time: 5,
      request: {
        method: 'GET',
        url: 'https://imported.test/feed',
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'content-type', value: 'text/event-stream' },
          { name: 'content-encoding', value: 'gzip' },
        ],
        cookies: [],
        content: { size: 26, mimeType: 'text/event-stream', text: 'data: from a HAR file\n\n' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 40,
      },
      cache: {},
      timings: { send: 0, wait: 5, receive: 0 },
    };
    await writeFile(file, JSON.stringify({ log: { version: '1.2', entries: [entry] } }));
    await backend.importHar(file);
    await expect.poll(() => latest('/feed')?.imported, WAIT).toBe(true);
    const view = await events(latest('/feed')!.id);
    expect(view).toMatchObject({ total: 1, receiving: false });
    expect(view!.items).toEqual([{ kind: 'event', index: 1, type: 'message', data: 'from a HAR file' }]);
  });

  it('gives nothing for a response that isn’t an event stream, and refuses bad arguments', async () => {
    await (
      await get('/plain')
    ).ended;
    await expect.poll(() => latest('/plain')?.responseSize, WAIT).toBeDefined();
    expect(await events(latest('/plain')!.id)).toBeNull();
    await expect(events('no-such-exchange')).rejects.toThrow(/not found/);
    await expect(events(latest('/plain')!.id, -1)).rejects.toThrow(/whole number/);
    await expect(
      api.send({ command: 'getSseEvents', exchangeId: latest('/plain')!.id, after: '1' as never }),
    ).rejects.toThrow(/whole number/);
  });
});
