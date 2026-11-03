import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BodyContent, ExchangeDetail, ExchangeSummary } from '../src/shared/api';
import { describeFailure, upstreamErrorCode } from '../src/shared/failure';
import { apiClient, exchangesIn, httpViaProxy, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** Opens a CONNECT tunnel through the proxy. */
function tunnel(proxyPort: number, target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else reject(new Error(`CONNECT failed: ${res.statusCode}`));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('upstream failures and WebSockets', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let silent: net.Server;
  let selfSigned: http.Server;
  let backend: RunningBackend;
  let upstreamCA: { key: string; cert: string };

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-robust-test-'));
    upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.forAnyWebSocket().thenEcho();
    await upstream.start();

    // Accepts connections and never answers.
    silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));

    // HTTPS with a certificate nobody trusts.
    const untrusted = await generateCACertificate();
    const { createServer } = await import('node:https');
    selfSigned = createServer({ key: untrusted.key, cert: untrusted.cert }, (_req, res) => res.end('hi'));
    await new Promise<void>((resolve) => selfSigned.listen(0, '127.0.0.1', resolve));

    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await upstream?.stop();
    silent?.close();
    selfSigned?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const failureFor = async (
    api: Awaited<ReturnType<typeof apiClient>>,
    match: (e: ExchangeSummary) => boolean,
  ): Promise<ExchangeSummary> => {
    let found: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        found = exchangesIn(api.messages).find((e) => match(e) && e.failure);
        return found;
      })
      .toBeTruthy();
    return found!;
  };

  it('explains a DNS failure', async () => {
    const api = await apiClient(backend.apiPort);
    const response = await httpViaProxy(backend.proxyPort, 'http://no-such-host.invalid/dns');
    expect(response.status).toBe(502);
    const exchange = await failureFor(api, (e) => e.path === '/dns');
    expect(exchange.failure).toMatchObject({ kind: 'dns' });
    expect(exchange.failure?.message).toContain('no-such-host.invalid');
    api.close();
  });

  it('explains a refused connection', async () => {
    const api = await apiClient(backend.apiPort);
    // Find a port with nothing listening.
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await httpViaProxy(backend.proxyPort, `http://127.0.0.1:${port}/refused`);
    const exchange = await failureFor(api, (e) => e.path === '/refused');
    expect(exchange.failure).toMatchObject({ kind: 'refused', code: 'ECONNREFUSED' });
    expect(exchange.failure?.detail).toContain('ECONNREFUSED');
    api.close();
  });

  it("explains a server certificate that isn't trusted", async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    const port = (selfSigned.address() as net.AddressInfo).port;
    const response = await requestViaProxy(backend.proxyPort, `https://localhost:${port}/tls`, ca);
    expect(response.status).toBe(502);
    const exchange = await failureFor(api, (e) => e.path === '/tls');
    expect(exchange.failure?.kind).toBe('tls');
    expect(exchange.failure?.message).toContain('self-signed');
    expect(exchange.failure?.detail).toMatch(/self[- ]signed certificate/);
    api.close();
  });

  it('keeps the error detail for HTTP/2 requests', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    const port = (selfSigned.address() as net.AddressInfo).port;
    const socket = await tunnel(backend.proxyPort, `localhost:${port}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${port}`, { createConnection: () => secure });
    const status = await new Promise<number>((resolve, reject) => {
      const req = session.request({ ':path': '/tls-h2' });
      req.on('response', (headers) => resolve(Number(headers[':status'])));
      req.on('error', reject);
      req.resume();
      req.end();
    });
    session.close();
    expect(status).toBe(502);
    const exchange = await failureFor(api, (e) => e.path === '/tls-h2');
    expect(exchange.httpVersion).toBe('2.0');
    expect(exchange.failure?.kind).toBe('tls');
    expect(exchange.failure?.detail).toMatch(/self[- ]signed certificate/);
    api.close();
  });

  it('marks a request the client gave up on', async () => {
    const api = await apiClient(backend.apiPort);
    const port = (silent.address() as net.AddressInfo).port;
    const req = http.request({
      host: '127.0.0.1',
      port: backend.proxyPort,
      path: `http://127.0.0.1:${port}/slow`,
    });
    req.on('error', () => undefined);
    req.end();
    await expect.poll(() => exchangesIn(api.messages).some((e) => e.path === '/slow')).toBe(true);
    req.destroy();
    const exchange = await failureFor(api, (e) => e.path === '/slow');
    expect(exchange.failure?.kind).toBe('client-closed');
    // Nothing had arrived: not partial, and no status or body.
    expect(exchange.failure?.partial).toBeFalsy();
    expect(exchange.status).toBeUndefined();
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: exchange.id });
    expect(detail.responseHeaders).toBeUndefined();
    expect(detail.responseBody?.size ?? 0).toBe(0);
    api.close();
  });

  /** An upstream response that sends its headers and part of its body, then never ends. */
  const stalling = async (urlPath: string): Promise<PassThrough> => {
    const body = new PassThrough();
    body.write('first part ');
    await upstream.forGet(urlPath).thenStream(200, body, { 'content-type': 'text/plain' });
    return body;
  };

  const expectClosedMidBody = async (
    api: Awaited<ReturnType<typeof apiClient>>,
    urlPath: string,
    httpVersion: string,
  ): Promise<void> => {
    const exchange = await failureFor(api, (e) => e.path === urlPath && e.responseSize !== undefined);
    expect(exchange).toMatchObject({
      httpVersion,
      status: 200,
      contentType: 'text/plain',
      responseSize: 'first part '.length,
      failure: {
        kind: 'client-closed',
        partial: true,
        message: 'The client closed the connection part way through the response.',
      },
    });
    expect(exchange.durationMs).toBeGreaterThanOrEqual(0);
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: exchange.id });
    expect(detail.responseHeaders).toContainEqual(['content-type', 'text/plain']);
    expect(detail.responseBody).toMatchObject({ incomplete: true });
    // What the server sent, without the error text Mockttp writes to the closed connection.
    const body = await api.send<BodyContent>({
      command: 'getBody',
      exchangeId: exchange.id,
      side: 'response',
    });
    expect(Buffer.from(body.base64, 'base64').toString()).toBe('first part ');
  };

  it('marks a response the client closed part way through', async () => {
    const api = await apiClient(backend.apiPort);
    const body = await stalling('/closed-mid-body');
    const req = http.request({
      host: '127.0.0.1',
      port: backend.proxyPort,
      path: `http://localhost:${upstream.port}/closed-mid-body`,
    });
    req.on('error', () => undefined);
    req.on('response', (res) => res.once('data', () => req.destroy()));
    req.end();
    try {
      await expectClosedMidBody(api, '/closed-mid-body', '1.1');
    } finally {
      body.destroy();
      api.close();
    }
  });

  it('marks an HTTP/2 response the client cancelled part way through', async () => {
    const api = await apiClient(backend.apiPort);
    const body = await stalling('/closed-mid-body-h2');
    const ca = await readFile(backend.caCertPath, 'utf8');
    const socket = await tunnel(backend.proxyPort, `localhost:${upstream.port}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${upstream.port}`, { createConnection: () => secure });
    session.on('error', () => undefined);
    const req = session.request({ ':path': '/closed-mid-body-h2' });
    req.on('error', () => undefined);
    req.once('data', () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.end();
    try {
      await expectClosedMidBody(api, '/closed-mid-body-h2', '2.0');
    } finally {
      session.destroy();
      body.destroy();
      api.close();
    }
  });

  it.each(['ws', 'wss'] as const)('passes %s:// WebSockets through and records them', async (scheme) => {
    const api = await apiClient(backend.apiPort);
    const target = `localhost:${upstream.port}`;
    let socket: net.Socket | tls.TLSSocket = await tunnel(backend.proxyPort, target);
    if (scheme === 'wss') {
      const ca = await readFile(backend.caCertPath, 'utf8');
      socket = tls.connect({ socket, servername: 'localhost', ca });
    }
    const ws = new WebSocket(`${scheme}://${target}/chat-${scheme}`, { createConnection: () => socket });
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.once('open', () => ws.send(`hello over ${scheme}`));
      ws.once('message', (data) => resolve(data.toString()));
      ws.once('error', reject);
    });
    expect(echoed).toBe(`hello over ${scheme}`);
    ws.close(1000);

    await expect
      .poll(() =>
        exchangesIn(api.messages).find((e) => e.path === `/chat-${scheme}` && e.closeCode !== undefined),
      )
      .toMatchObject({ websocket: true, status: 101, closeCode: 1000, protocol: scheme });
    api.close();
  });
});

describe('describeFailure', () => {
  it.each([
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'refused'],
    ['ETIMEDOUT', 'timeout'],
    ['ECONNRESET', 'reset'],
    ['EHOSTUNREACH', 'unreachable'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
    ['CLIENT_CLOSED', 'client-closed'],
    ['E_SOMETHING_ELSE', 'other'],
  ])('%s is %s', (code, kind) => {
    const failure = describeFailure(code, 'api.example.com:443');
    expect(failure.kind).toBe(kind);
    expect(failure.code).toBe(code);
  });

  it('names the host and the specific TLS problem', () => {
    expect(describeFailure('CERT_HAS_EXPIRED', 'old.example.com').message).toBe(
      "TLS failed with old.example.com: the server's certificate has expired.",
    );
  });

  it('keeps error text only when it says more than the code', () => {
    // Node's error when every address of a host failed is a bare "AggregateError".
    expect(describeFailure('ETIMEDOUT', 'a.example', 'AggregateError').detail).toBeUndefined();
    expect(describeFailure('ECONNRESET', 'a.example', ' ECONNRESET ').detail).toBeUndefined();
    expect(describeFailure('ECONNRESET', 'a.example', '').detail).toBeUndefined();
    expect(describeFailure('EPROTO', 'a.example', 'wrong version number').detail).toBe(
      'wrong version number',
    );
  });

  it('reads the error code from Mockttp tags', () => {
    expect(upstreamErrorCode(['x', 'passthrough-error:ENOTFOUND'])).toBe('ENOTFOUND');
    expect(upstreamErrorCode(['x'])).toBeUndefined();
  });
});
