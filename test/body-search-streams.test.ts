/**
 * Searching bodies while they arrive, through a real proxy and backend: a streamed response and a
 * slow upload are found before they end, -body~ follows what has arrived, uploads report their
 * size so far, and a finished body is answered without reading it again.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ExchangeSummary } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

/** The latest summary of the exchange at this path: the window's batches repeat it as it changes. */
const latest = (messages: Parameters<typeof exchangesIn>[0], urlPath: string): ExchangeSummary | undefined =>
  exchangesIn(messages)
    .filter((e) => e.path === urlPath)
    .at(-1);

describe('searching bodies while they arrive', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let upstream: http.Server;
  let upstreamPort: number;
  /** Ends the streamed response or the upload's reading, by path. */
  const release = new Map<string, () => void>();

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-streams-test-'));
    upstream = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first-part-marker\n\n');
        release.set('/stream', () => res.end('data: second-part-marker\n\n'));
        return;
      }
      // An upload: read it all, then answer.
      req.resume();
      req.on('end', () => res.writeHead(200).end('uploaded'));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
    backend = await startBackend({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });
  });

  afterAll(async () => {
    for (const end of release.values()) end();
    await backend?.stop();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A request through the proxy, plain HTTP; returns the request so the test can finish it. */
  const send = (urlPath: string, method = 'GET') => {
    const req = http.request({
      host: '127.0.0.1',
      port: backend.proxyPort,
      method,
      path: `http://127.0.0.1:${upstreamPort}${urlPath}`,
      headers: {
        host: `127.0.0.1:${upstreamPort}`,
        ...(method === 'POST' ? { 'content-type': 'text/plain' } : {}),
      },
    });
    const response = new Promise<string>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });
    response.catch(() => undefined);
    return { req, response };
  };

  it('finds a streamed response by its body before it ends, and -body~ follows it', async () => {
    const api = await apiClient(backend.apiPort);
    const { req, response } = send('/stream');
    req.end();
    const exchange = () => latest(api.messages, '/stream');
    await expect.poll(() => exchange()?.responding).toBe(true);
    const id = exchange()!.id;
    const match = async (query: string) =>
      (await api.send<{ ids: string[] }>({ command: 'matchExchanges', query, ids: [id] })).ids;

    await expect.poll(() => match('resbody~first-part-marker')).toEqual([id]);
    expect(await match('resbody~second-part-marker')).toEqual([]);
    expect(await match('-resbody~second-part-marker')).toEqual([id]);

    release.get('/stream')!();
    expect(await response).toContain('second-part-marker');
    await expect.poll(() => match('resbody~second-part-marker')).toEqual([id]);
    expect(await match('-resbody~second-part-marker')).toEqual([]);
    api.close();
  });

  it('finds an upload by its body before it ends, and reports its size so far', async () => {
    const api = await apiClient(backend.apiPort);
    const { req, response } = send('/upload', 'POST');
    req.write('upload-start-marker ');
    const exchange = () => latest(api.messages, '/upload');
    await expect.poll(() => exchange()?.requestReceived).toBeGreaterThan(0);
    const id = exchange()!.id;
    const match = async (query: string) =>
      (await api.send<{ ids: string[] }>({ command: 'matchExchanges', query, ids: [id] })).ids;
    await expect.poll(() => match('reqbody~upload-start-marker')).toEqual([id]);
    expect(await match('reqbody~upload-end-marker')).toEqual([]);

    // Its size so far grows as more arrives.
    const before = exchange()!.requestReceived!;
    req.write('x'.repeat(5000));
    await expect.poll(() => exchange()?.requestReceived ?? 0).toBeGreaterThan(before);

    req.end('upload-end-marker');
    expect(await response).toBe('uploaded');
    await expect.poll(() => match('reqbody~upload-end-marker')).toEqual([id]);
    // Finished: no size so far any more.
    await expect.poll(() => exchange()?.requestReceived).toBeUndefined();
    api.close();
  });

  it('a finished exchange gets no size so far, and its updates come one per tick', async () => {
    const api = await apiClient(backend.apiPort);
    const { req, response } = send('/upload-quick', 'POST');
    req.end('all at once');
    await response;
    await expect.poll(() => latest(api.messages, '/upload-quick')?.durationMs).toBeDefined();
    const updates = api.messages.flatMap((m) =>
      m.type === 'exchanges' ? m.exchanges : [],
    ) as ExchangeSummary[];
    expect(updates.filter((e) => e.path === '/upload-quick' && e.requestReceived !== undefined)).toEqual([]);
    api.close();
  });

  it('remembers what it found, and forgets it when the exchange is deleted or everything is cleared', async () => {
    const api = await apiClient(backend.apiPort);
    const { req, response } = send('/remembered', 'POST');
    req.end('remembered body');
    await response;
    await expect.poll(() => latest(api.messages, '/remembered')?.durationMs).toBeDefined();
    const id = latest(api.messages, '/remembered')!.id;
    const before = backend.bodyMemoSize();
    expect(
      (
        await api.send<{ ids: string[] }>({
          command: 'matchExchanges',
          query: 'reqbody~remembered',
          ids: [id],
        })
      ).ids,
    ).toEqual([id]);
    expect(backend.bodyMemoSize()).toBe(before + 1);
    await api.send({ command: 'clear', ids: [id] });
    expect(backend.bodyMemoSize()).toBe(before);
    // Clear forgets everything.
    await api.send({ command: 'matchExchanges', query: 'body~anything' });
    await api.send({ command: 'clear' });
    expect(backend.bodyMemoSize()).toBe(0);
    api.close();
  });
});
