import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeBuffer } from 'http-encoding';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { chromiumArgs } from '../src/backend/browsers';
import { loadOrCreateCA } from '../src/backend/ca';
import type { BodyContent, ExchangeDetail, ServerMessage } from '../src/shared/api';
import {
  apiClient,
  connectApi,
  exchangesIn,
  rejectedStatus,
  requestViaProxy,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

describe('backend', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-test-'));

    // A local HTTPS server standing in for a real website, with its own CA.
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream.forGet('/hello').thenReply(200, 'hello from upstream');
    await upstream.forPost('/echo').thenCallback((req) => ({ statusCode: 201, body: req.body.buffer }));
    for (const encoding of ['gzip', 'br', 'zstd'] as const) {
      const json = Buffer.from(JSON.stringify({ encoding, items: Array(50).fill('compressed') }));
      await upstream.forGet(`/${encoding}`).thenReply(200, await encodeBuffer(json, encoding), {
        'content-type': 'application/json',
        'content-encoding': encoding,
      });
    }
    // Says it's gzip, but isn't.
    await upstream.forGet('/corrupt-gzip').thenReply(200, Buffer.from('definitely not gzip'), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    await upstream.forGet('/odd-encoding').thenReply(200, Buffer.from('raw bytes'), {
      'content-encoding': 'x-made-up',
    });
    await upstream
      .forGet('/large')
      .thenReply(200, Buffer.alloc(200 * 1024, 'x'), { 'content-type': 'text/plain' });

    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      bodyMemoryLimit: 64 * 1024,
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await upstream?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a CA in the data folder with a private key only the user can read', async () => {
    const keyStat = await stat(path.join(dataDir, 'ca.key'));
    // Windows doesn't use Unix permission bits.
    if (process.platform !== 'win32') expect(keyStat.mode & 0o077).toBe(0);
    const cert = await readFile(backend.caCertPath, 'utf8');
    expect(cert).toContain('BEGIN CERTIFICATE');
  });

  it('reuses the same CA on the next start', async () => {
    const first = await loadOrCreateCA(dataDir);
    const second = await loadOrCreateCA(dataDir);
    expect(second.spkiFingerprint).toBe(first.spkiFingerprint);
    expect(first.spkiFingerprint).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('intercepts HTTPS through the proxy and streams it to the UI', async () => {
    const ws = connectApi(backend.apiPort, { token: TOKEN, origin: UI_ORIGIN });
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const ca = await readFile(backend.caCertPath, 'utf8');
    const url = `https://localhost:${upstream.port}/hello?x=1`;
    const response = await requestViaProxy(backend.proxyPort, url, ca);
    expect(response).toEqual({ status: 200, body: 'hello from upstream' });

    await expect.poll(() => exchangesIn(messages).find((e) => e.status !== undefined)).toBeTruthy();

    const hello = messages[0];
    expect(hello?.type).toBe('hello');
    if (hello?.type === 'hello') expect(hello.status.proxyPort).toBe(backend.proxyPort);

    const completed = exchangesIn(messages).find((e) => e.status !== undefined);
    expect(completed).toMatchObject({
      method: 'GET',
      status: 200,
      host: `localhost:${upstream.port}`,
      path: '/hello?x=1',
      protocol: 'https',
      responseSize: 'hello from upstream'.length,
    });
    ws.close();
  });

  it('captures headers and bodies, and serves them on request', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    const response = await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/echo`, ca, {
      method: 'POST',
      body: '{"name":"wirescry"}',
      headers: { 'content-type': 'application/json', 'x-test': 'yes' },
    });
    expect(response).toEqual({ status: 201, body: '{"name":"wirescry"}' });

    const id = await api.completed('/echo');
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id });
    expect(detail.requestHeaders).toContainEqual(['x-test', 'yes']);
    expect(detail.responseHeaders).toBeDefined();
    expect(detail.requestBody).toEqual({ size: 19, stored: 19 }); // The 19-byte body above.
    expect(detail.timing.responseSentTimestamp).toBeGreaterThanOrEqual(detail.timing.startTimestamp);

    const requestBody = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'request' });
    expect(Buffer.from(requestBody.base64, 'base64').toString()).toBe('{"name":"wirescry"}');
    expect(requestBody.contentType).toBe('application/json');
    api.close();
  });

  it.each(['gzip', 'br', 'zstd'])('decodes %s response bodies', async (encoding) => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/${encoding}`, ca);
    const id = await api.completed(`/${encoding}`);
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'response' });
    expect(body.encoding).toBe(encoding);
    expect(body.decodeError).toBeUndefined();
    expect(body.decodedSize).toBeGreaterThan(body.size);
    expect(JSON.parse(Buffer.from(body.base64, 'base64').toString())).toMatchObject({ encoding });
    api.close();
  });

  it('stores large bodies on disk and removes them on clear', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/large`, ca);
    const id = await api.completed('/large');
    const bodiesDir = path.join(dataDir, 'bodies');
    await expect.poll(() => readdir(bodiesDir)).toContain(`${id}.response`);
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'response' });
    expect(Buffer.from(body.base64, 'base64').length).toBe(200 * 1024);

    await api.send({ command: 'clear' });
    expect(await readdir(bodiesDir)).toEqual([]);
    await expect(api.send({ command: 'getExchange', exchangeId: id })).rejects.toThrow('Exchange not found');
    api.close();
  });

  it('clears only the exchanges it is given, and their bodies', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/large?clear=gone`, ca);
    const gone = await api.completed('/large?clear=gone');
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/hello?clear=kept`, ca);
    const kept = await api.completed('/hello?clear=kept');
    const bodiesDir = path.join(dataDir, 'bodies');
    await expect.poll(() => readdir(bodiesDir)).toContain(`${gone}.response`);

    await api.send({ command: 'clear', ids: [gone, 'no-such-id'] });
    await expect(api.send({ command: 'getExchange', exchangeId: gone })).rejects.toThrow(
      'Exchange not found',
    );
    await expect(api.send({ command: 'getExchange', exchangeId: kept })).resolves.toBeDefined();
    await expect.poll(() => readdir(bodiesDir)).not.toContain(`${gone}.response`);
    await expect
      .poll(() =>
        api.messages.some(
          (m) => m.type === 'exchanges' && m.removed.includes(gone) && !m.removed.includes(kept),
        ),
      )
      .toBe(true);
    expect(api.messages.some((m) => m.type === 'cleared')).toBe(false);
    api.close();
  });

  it('looks for browsers again on rescan', async () => {
    const api = await apiClient(backend.apiPort);
    await expect.poll(() => api.messages.some((m) => m.type === 'hello')).toBe(true);
    const found = await api.send<unknown[]>({ command: 'rescanBrowsers' });
    expect(Array.isArray(found)).toBe(true);
    await expect.poll(() => api.messages.some((m) => m.type === 'status')).toBe(true);
    api.close();
  });

  it('sends a burst of requests in a few batched messages', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/hello?burst=${i}`, ca),
      ),
    );
    await expect
      .poll(() => exchangesIn(api.messages).filter((e) => e.path.includes('burst=') && e.status).length)
      .toBe(40);
    // 40 requests each start and finish, which would be 80 messages without batching.
    expect(api.messages.filter((m) => m.type === 'exchanges').length).toBeLessThan(20);
    api.close();
  });

  it('records type and size for each response', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/gzip`, ca);
    await api.completed('/gzip');
    const summary = exchangesIn(api.messages).find((e) => e.path === '/gzip' && e.status);
    expect(summary?.contentType).toBe('application/json');
    expect(summary?.responseSize).toBeGreaterThan(0);
    api.close();
  });

  it('passes traffic through without recording it while paused', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    await api.send({ command: 'setPaused', paused: true });
    expect(api.messages).toContainEqual({ type: 'paused', paused: true });

    const response = await requestViaProxy(
      backend.proxyPort,
      `https://localhost:${upstream.port}/hello?while=paused`,
      ca,
    );
    expect(response.status).toBe(200);

    await api.send({ command: 'setPaused', paused: false });
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/hello?while=resumed`, ca);
    await api.completed('/hello?while=resumed');
    expect(exchangesIn(api.messages).some((e) => e.path === '/hello?while=paused')).toBe(false);
    api.close();
  });

  it('shows the stored bytes, and why, for a body that can’t be decoded, and keeps working', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    for (const [route, expected, error] of [
      ['/corrupt-gzip', 'definitely not gzip', /Couldn't decode gzip/],
      ['/odd-encoding', 'raw bytes', /Unsupported encoding: x-made-up/],
    ] as const) {
      await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}${route}`, ca);
      const id = await api.completed(route);
      const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'response' });
      expect(body.decodeError).toMatch(error);
      expect(Buffer.from(body.base64, 'base64').toString()).toBe(expected);
    }
    // The backend is still serving.
    await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/hello?after=corrupt`, ca);
    await api.completed('/hello?after=corrupt');
    api.close();
  });

  it('survives bad API messages: ignores junk, answers unknown commands with an error', async () => {
    const api = await apiClient(backend.apiPort);
    const raw = connectApi(backend.apiPort, { token: TOKEN, origin: UI_ORIGIN });
    await new Promise((resolve) => raw.once('open', resolve));
    const replies: unknown[] = [];
    raw.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === 'result') replies.push(message);
    });
    raw.send('this is not JSON');
    raw.send(JSON.stringify({ command: 'getStatus' })); // No id: nothing to answer.
    raw.send(JSON.stringify(null));
    raw.send(JSON.stringify({ id: 7, command: 'noSuchCommand' }));
    await expect
      .poll(() => replies)
      .toEqual([{ type: 'result', id: 7, ok: false, error: 'Unknown command' }]);
    await expect(api.send({ command: 'getExchange', exchangeId: 'no-such-id' })).rejects.toThrow(
      'Exchange not found',
    );
    raw.close();
    api.close();
  });

  it('closes only the connection that sends an oversized message', async () => {
    const api = await apiClient(backend.apiPort);
    const big = connectApi(backend.apiPort, { token: TOKEN, origin: UI_ORIGIN });
    await new Promise((resolve) => big.once('open', resolve));
    const closed = new Promise<number>((resolve) => big.once('close', (code) => resolve(code)));
    big.on('error', () => undefined);
    big.send(JSON.stringify({ id: 1, command: 'getStatus', pad: 'x'.repeat(1100 * 1024) }));
    // Cut off: 1009 (message too big), or 1006 since the server terminates the socket.
    expect([1006, 1009]).toContain(await closed);
    // Others carry on: this connection still gets answers.
    await expect(api.send({ command: 'getExchange', exchangeId: 'no-such-id' })).rejects.toThrow(
      'Exchange not found',
    );
    api.close();
  });

  it('rejects API connections without the right token', async () => {
    expect(await rejectedStatus(connectApi(backend.apiPort, { origin: UI_ORIGIN }))).toBe(401);
    expect(await rejectedStatus(connectApi(backend.apiPort))).toBe(401);
    expect(await rejectedStatus(connectApi(backend.apiPort, { token: 'wrong', origin: UI_ORIGIN }))).toBe(
      401,
    );
  });

  it('rejects API connections from other origins or hosts', async () => {
    expect(
      await rejectedStatus(connectApi(backend.apiPort, { token: TOKEN, origin: 'https://evil.example' })),
    ).toBe(403);
    expect(
      await rejectedStatus(
        connectApi(backend.apiPort, {
          token: TOKEN,
          origin: UI_ORIGIN,
          host: `evil.example:${backend.apiPort}`,
        }),
      ),
    ).toBe(403);
  });
});

describe('chromiumArgs', () => {
  it('routes through the proxy, trusts the CA by SPKI and disables QUIC', () => {
    const args = chromiumArgs({ proxyPort: 8000, spkiFingerprint: 'abc=', profileDir: '/tmp/p' });
    expect(args).toContain('--proxy-server=127.0.0.1:8000');
    expect(args).toContain('--ignore-certificate-errors-spki-list=abc=');
    expect(args).toContain('--user-data-dir=/tmp/p');
    expect(args).toContain('--disable-quic');
  });
});
