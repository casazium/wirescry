import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { encodeBuffer } from 'http-encoding';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import { chromiumArgs } from '../src/backend/browsers';
import {
  API_PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type BodyContent,
  type ClientCommand,
  type ExchangeDetail,
  type ExchangeSummary,
  type ServerMessage,
} from '../src/shared/api';

const TOKEN = 'test-token-0123456789';
const UI_ORIGIN = 'http://localhost:5173';

/** Sends one HTTPS request through an HTTP proxy using CONNECT, trusting only `ca`. */
function requestViaProxy(
  proxyPort: number,
  url: string,
  ca: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
    });
    connect.once('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT failed: ${res.statusCode}`));
      const req = https.request(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: options.method ?? 'GET',
          headers: options.headers,
          ca,
          servername: target.hostname,
          // Run TLS over the CONNECT tunnel.
          createConnection: () => tls.connect({ socket, servername: target.hostname, ca }),
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      req.once('error', reject);
      req.end(options.body);
    });
    connect.once('error', reject);
    connect.end();
  });
}

function connectApi(port: number, opts: { token?: string; origin?: string; host?: string } = {}): WebSocket {
  const protocols = [API_PROTOCOL];
  if (opts.token !== undefined) protocols.push(`${TOKEN_PROTOCOL_PREFIX}${opts.token}`);
  return new WebSocket(`ws://127.0.0.1:${port}/`, protocols, {
    headers: {
      ...(opts.origin ? { Origin: opts.origin } : {}),
      ...(opts.host ? { Host: opts.host } : {}),
    },
  });
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Opens an authorised API connection that can send commands and collects pushed messages. */
async function apiClient(port: number) {
  const ws = connectApi(port, { token: TOKEN, origin: UI_ORIGIN });
  const messages: ServerMessage[] = [];
  const waiting = new Map<number, (m: Extract<ServerMessage, { type: 'result' }>) => void>();
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    if (message.type === 'result') waiting.get(message.id)?.(message);
    else messages.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  return {
    messages,
    close: () => ws.close(),
    async send<T>(command: DistributiveOmit<ClientCommand, 'id'>): Promise<T> {
      const id = nextId++;
      const result = await new Promise<Extract<ServerMessage, { type: 'result' }>>((resolve) => {
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ ...command, id }));
      });
      if (!result.ok) throw new Error(result.error);
      return result.value as T;
    },
    /** Waits for the exchange at `pathAndQuery` to finish and returns its id. */
    async completed(pathAndQuery: string): Promise<string> {
      let found: ExchangeSummary | undefined;
      await expect
        .poll(() => {
          found = messages
            .filter((m): m is Extract<ServerMessage, { type: 'exchange' }> => m.type === 'exchange')
            .map((m) => m.exchange)
            .find((e) => e.path === pathAndQuery && e.status !== undefined);
          return found;
        })
        .toBeTruthy();
      return found!.id;
    },
  };
}

function rejectedStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('Connection was accepted')));
    ws.once('error', () => undefined);
  });
}

describe('backend', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-test-'));

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
    expect(keyStat.mode & 0o077).toBe(0);
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

    await expect
      .poll(() =>
        messages.find(
          (m): m is Extract<ServerMessage, { type: 'exchange' }> =>
            m.type === 'exchange' && m.exchange.status !== undefined,
        ),
      )
      .toBeTruthy();

    const hello = messages[0];
    expect(hello?.type).toBe('hello');
    if (hello?.type === 'hello') expect(hello.status.proxyPort).toBe(backend.proxyPort);

    const completed = messages
      .filter((m) => m.type === 'exchange')
      .map((m) => (m as { exchange: ExchangeSummary }).exchange)
      .find((e) => e.status !== undefined);
    expect(completed).toMatchObject({
      method: 'GET',
      status: 200,
      host: `localhost:${upstream.port}`,
      path: '/hello?x=1',
      protocol: 'https',
    });
    ws.close();
  });

  it('captures headers and bodies, and serves them on request', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    const response = await requestViaProxy(backend.proxyPort, `https://localhost:${upstream.port}/echo`, ca, {
      method: 'POST',
      body: '{"name":"leverframe"}',
      headers: { 'content-type': 'application/json', 'x-test': 'yes' },
    });
    expect(response).toEqual({ status: 201, body: '{"name":"leverframe"}' });

    const id = await api.completed('/echo');
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id });
    expect(detail.requestHeaders).toContainEqual(['x-test', 'yes']);
    expect(detail.responseHeaders).toBeDefined();
    expect(detail.requestBody).toEqual({ size: 21 });
    expect(detail.timing.responseSentTimestamp).toBeGreaterThanOrEqual(detail.timing.startTimestamp);

    const requestBody = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'request' });
    expect(Buffer.from(requestBody.base64, 'base64').toString()).toBe('{"name":"leverframe"}');
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

  it('rejects API connections without the right token', async () => {
    expect(await rejectedStatus(connectApi(backend.apiPort, { origin: UI_ORIGIN }))).toBe(401);
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
