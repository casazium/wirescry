import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import net from 'node:net';
import { Composer, validateComposerRequest } from '../src/backend/composer';
import type { BodyContent, ComposerRequest, ExchangeDetail } from '../src/shared/api';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

const request = (overrides: Partial<ComposerRequest>): ComposerRequest => ({
  method: 'GET',
  url: 'https://example.com/',
  headers: [],
  body: '',
  ...overrides,
});

describe('validateComposerRequest', () => {
  it('cleans up the method and drops headers Wirescry sets itself', () => {
    const valid = validateComposerRequest(
      request({
        method: ' post ',
        headers: [
          ['Accept', 'application/json'],
          ['Content-Length', '3'],
          ['Host', 'other.example'],
          ['Connection', 'close'],
        ],
      }),
    );
    expect(valid.method).toBe('POST');
    expect(valid.headers).toEqual([['Accept', 'application/json']]);
  });

  it.each([
    [{ method: 'GE T' }, 'Enter a method'],
    [{ method: 'CONNECT' }, "can't send CONNECT"],
    [{ url: 'example.com/path' }, 'Enter a full URL'],
    [{ url: 'ftp://example.com/' }, 'Enter a full URL'],
    [{ url: 'https://user:pass@example.com/' }, 'Authorization header'],
    [{ headers: [['Bad Name', 'x']] }, "isn't a valid header name"],
    [{ headers: [['X-Emoji', 'hi 👋']] }, 'plain text'],
    [{ headers: [['X-Split', 'a\r\nInjected: yes']] }, 'plain text'],
    [{ body: 'x'.repeat(512 * 1024 + 1) }, 'at most 512 KB'],
  ] as const)('refuses %j', (overrides, message) => {
    expect(() => validateComposerRequest(request(overrides as Partial<ComposerRequest>))).toThrow(message);
  });

  it('strips the fragment, drops hop-by-hop headers, and keeps header case and duplicates', () => {
    const valid = validateComposerRequest(
      request({
        url: 'http://a.example:80/p?q=1#frag',
        headers: [
          ['X-Mixed-Case', '1'],
          ['set-thing', 'a'],
          ['set-thing', 'b'],
          ['Proxy-Connection', 'keep-alive'],
          ['TE', 'trailers'],
          ['Upgrade', 'h2c'],
          ['Keep-Alive', '5'],
          ['Transfer-Encoding', 'chunked'],
        ],
      }),
    );
    expect(valid.url).toBe('http://a.example/p?q=1');
    expect(valid.headers).toEqual([
      ['X-Mixed-Case', '1'],
      ['set-thing', 'a'],
      ['set-thing', 'b'],
    ]);
  });

  it('accepts every method the proxy parses, and an IPv6 host', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PATCH', 'PROPFIND', 'M-SEARCH']) {
      expect(validateComposerRequest(request({ method })).method).toBe(method);
    }
    expect(validateComposerRequest(request({ url: 'https://[::1]:8443/x' })).parsedUrl.hostname).toBe(
      '[::1]',
    );
  });

  it.each([
    [{ method: 'FOO' }, "isn't an HTTP method"],
    [{ headers: Array.from({ length: 5 }, (_, i) => [`X-${i}`, 'v'.repeat(4000)]) }, 'at most 16 KB'],
    [{ headers: Array.from({ length: 201 }, () => ['A', 'b']) }, 'Too many headers'],
    [{ url: `https://a.example/${'x'.repeat(16 * 1024)}` }, 'too long'],
    [{ url: 'https://' }, 'Enter a full URL'],
  ] as const)('also refuses %j', (overrides, message) => {
    expect(() => validateComposerRequest(request(overrides as Partial<ComposerRequest>))).toThrow(message);
  });

  it('limits the URL and headers together, as the proxy does', () => {
    const half = 'v'.repeat(9 * 1024);
    expect(() => validateComposerRequest(request({ url: `https://a.example/?q=${half}` }))).not.toThrow();
    expect(() => validateComposerRequest(request({ headers: [['X-Big', half]] }))).not.toThrow();
    expect(() =>
      validateComposerRequest(request({ url: `https://a.example/?q=${half}`, headers: [['X-Big', half]] })),
    ).toThrow('URL and headers can be at most 16 KB together');
  });

  it('refuses things that aren’t a request', () => {
    expect(() => validateComposerRequest(null)).toThrow();
    expect(() => validateComposerRequest({ method: 'GET', url: 'https://a.example/', headers: 'x' })).toThrow(
      'Headers must be a list',
    );
  });
});

describe('composer', () => {
  let dataDir: string;
  let secure: Mockttp;
  let plain: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-composer-'));
    const upstreamCA = await generateCACertificate();
    secure = getLocal({ https: upstreamCA });
    plain = getLocal();
    await Promise.all([secure.start(), plain.start()]);
    for (const server of [secure, plain]) {
      await server.forPost('/echo').thenCallback(async (req) => ({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: req.method,
          host: req.headers.host,
          token: req.headers['x-token'],
          length: req.headers['content-length'],
          body: await req.body.getText(),
        }),
      }));
      await server.forGet('/slow').thenTimeout();
      await server
        .forAnyRequest()
        .matching((req) => new URL(req.url).pathname === '/raw')
        .thenCallback(async (req) => ({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            method: req.method,
            rawHeaders: req.rawHeaders,
            body: await req.body.getText(),
          }),
        }));
    }
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await Promise.all([secure?.stop(), plain?.stop()]);
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['https', () => `https://localhost:${secure.port}`],
    ['http', () => `http://localhost:${plain.port}`],
  ])('sends over %s through the proxy, recorded and marked as composed', async (_name, origin) => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({
        method: 'POST',
        url: `${origin()}/echo?from=composer`,
        headers: [
          ['X-Token', 'abc'],
          ['Content-Type', 'application/json'],
        ],
        body: '{"hi":"é"}',
      }),
    });
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId && e.responseSize !== undefined))
      .toMatchObject({ composed: true, status: 201, method: 'POST', path: '/echo?from=composer' });
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId, side: 'response' });
    expect(JSON.parse(Buffer.from(body.base64, 'base64').toString())).toEqual({
      method: 'POST',
      host: new URL(origin()).host,
      token: 'abc',
      length: String(Buffer.byteLength('{"hi":"é"}')),
      body: '{"hi":"é"}',
    });
    api.close();
  });

  it('records a composed request while recording is paused, and nothing else', async () => {
    const api = await apiClient(backend.apiPort);
    await api.send({ command: 'setPaused', paused: true });
    try {
      const { exchangeId } = await api.send<{ exchangeId: string }>({
        command: 'composeSend',
        request: request({ method: 'POST', url: `http://localhost:${plain.port}/echo?paused=1` }),
      });
      await expect.poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.status).toBe(201);
      const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId });
      expect(detail.summary.composed).toBe(true);
    } finally {
      await api.send({ command: 'setPaused', paused: false });
      api.close();
    }
  });

  it('cancels a request waiting for its response', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ url: `https://localhost:${secure.port}/slow` }),
    });
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(true);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.failure)
      .toBeDefined();
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(false);
    api.close();
  });

  it.each([
    ['https', () => `https://[::1]:${secure.port}`],
    ['http', () => `http://[::1]:${plain.port}`],
  ])('sends over %s to an IPv6 host', async (_name, origin) => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ method: 'POST', url: `${origin()}/echo` }),
    });
    await expect.poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.status).toBe(201);
    api.close();
  });

  /** Sends to /raw and returns what the server received. */
  const sendRaw = async (overrides: Partial<ComposerRequest>) => {
    const api = await apiClient(backend.apiPort);
    try {
      const { exchangeId } = await api.send<{ exchangeId: string }>({
        command: 'composeSend',
        request: request({ url: `http://localhost:${plain.port}/raw`, ...overrides }),
      });
      await expect
        .poll(() =>
          exchangesIn(api.messages).find((e) => e.id === exchangeId && e.responseSize !== undefined),
        )
        .toBeDefined();
      const body = await api.send<BodyContent>({ command: 'getBody', exchangeId, side: 'response' });
      const seen = JSON.parse(Buffer.from(body.base64, 'base64').toString()) as {
        method: string;
        rawHeaders: [string, string][];
        body: string;
      };
      const header = (name: string) => seen.rawHeaders.filter(([n]) => n.toLowerCase() === name);
      return { ...seen, header };
    } finally {
      api.close();
    }
  };

  it('keeps header case and duplicates as written', async () => {
    const seen = await sendRaw({
      headers: [
        ['X-Mixed-Case', '1'],
        ['x-dup', 'a'],
        ['x-dup', 'b'],
      ],
    });
    expect(seen.rawHeaders).toContainEqual(['X-Mixed-Case', '1']);
    expect(seen.header('x-dup').map(([, v]) => v)).toEqual(['a', 'b']);
  });

  it('sends Content-Length: 0 for an empty POST, and none for a GET', async () => {
    expect((await sendRaw({ method: 'POST' })).header('content-length')).toEqual([['Content-Length', '0']]);
    expect((await sendRaw({ method: 'GET' })).header('content-length')).toEqual([]);
  });

  it('sends a body with OPTIONS when there is one, and HEAD without one', async () => {
    const options = await sendRaw({ method: 'OPTIONS', body: 'probe' });
    expect(options).toMatchObject({ method: 'OPTIONS', body: 'probe' });
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ method: 'HEAD', url: `http://localhost:${plain.port}/raw?head=1` }),
    });
    await expect.poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.status).toBe(200);
    api.close();
  });

  it('records a server that can’t be reached as a failure, still marked as composed', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ url: `http://127.0.0.1:${port}/` }),
    });
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId && e.failure))
      .toMatchObject({ composed: true });
    api.close();
  });

  it('gives each of several sends at once its own exchange', async () => {
    const api = await apiClient(backend.apiPort);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api.send<{ exchangeId: string }>({
          command: 'composeSend',
          request: request({ method: 'POST', url: `http://localhost:${plain.port}/echo?n=${i}` }),
        }),
      ),
    );
    const ids = results.map((r) => r.exchangeId);
    expect(new Set(ids).size).toBe(8);
    await expect
      .poll(() => ids.map((id) => exchangesIn(api.messages).find((e) => e.id === id)?.path).sort())
      .toEqual(Array.from({ length: 8 }, (_, i) => `/echo?n=${i}`).sort());
    api.close();
  });

  it('doesn’t mark or keep other clients’ requests, even while paused', async () => {
    const api = await apiClient(backend.apiPort);
    await httpViaProxy(backend.proxyPort, `http://localhost:${plain.port}/raw?client=other`);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.path === '/raw?client=other'))
      .toBeDefined();
    expect(exchangesIn(api.messages).find((e) => e.path === '/raw?client=other')?.composed).toBeUndefined();
    await api.send({ command: 'setPaused', paused: true });
    try {
      await httpViaProxy(backend.proxyPort, `http://localhost:${plain.port}/raw?client=paused`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exchangesIn(api.messages).find((e) => e.path === '/raw?client=paused')).toBeUndefined();
    } finally {
      await api.send({ command: 'setPaused', paused: false });
      api.close();
    }
  });

  it('cancels a response still streaming in', async () => {
    let streamed = false;
    const streaming = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first part ', () => (streamed = true));
      // ...and never finishes.
    });
    await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve));
    const port = (streaming.address() as net.AddressInfo).port;
    const api = await apiClient(backend.apiPort);
    try {
      const { exchangeId } = await api.send<{ exchangeId: string }>({
        command: 'composeSend',
        request: request({ url: `http://127.0.0.1:${port}/stream` }),
      });
      await expect.poll(() => streamed).toBe(true);
      // The proxy records the status once the response is complete, so until then it's pending.
      expect(exchangesIn(api.messages).find((e) => e.id === exchangeId)?.durationMs).toBeUndefined();
      expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(true);
      // The connection is gone: there's nothing left to cancel. (The proxy doesn't mark a
      // response cut off mid-body as failed, for any client; the UI hides Cancel itself.)
      expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(false);
    } finally {
      api.close();
      streaming.closeAllConnections();
      streaming.close();
    }
  });

  it('returns false when cancelling something it isn’t sending', async () => {
    const api = await apiClient(backend.apiPort);
    expect(await api.send({ command: 'composeCancel', exchangeId: 'no-such-id' })).toBe(false);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ method: 'POST', url: `http://localhost:${plain.port}/echo?done=1` }),
    });
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.durationMs)
      .toBeDefined();
    await expect.poll(() => api.send({ command: 'composeCancel', exchangeId })).toBe(false);
    api.close();
  });

  it('answers a bad request with the reason', async () => {
    const api = await apiClient(backend.apiPort);
    await expect(
      api.send({ command: 'composeSend', request: request({ url: 'not a url' }) }),
    ).rejects.toThrow('Enter a full URL');
    api.close();
  });
});

describe('Composer against a proxy that misbehaves', () => {
  /** A stand-in proxy that answers each connection with `respond`. */
  async function fakeProxy(respond: (socket: net.Socket) => void) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      respond(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    return {
      port,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }
  const composerFor = (port: number, claimTimeoutMs = 2000) =>
    new Composer({ proxyPort: () => port, caCert: () => '', claimTimeoutMs });

  it('says the proxy refused it when an answer comes before the request is recorded', async () => {
    const proxy = await fakeProxy((socket) =>
      socket.once('data', () =>
        socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\n\r\n'),
      ),
    );
    const started = Date.now();
    await expect(composerFor(proxy.port).send(request({ url: 'http://a.example/' }))).rejects.toThrow(
      "Wirescry's proxy refused the request (431)",
    );
    expect(Date.now() - started).toBeLessThan(1500);
    await proxy.close();
  });

  it('says so when the proxy closes the connection without recording it', async () => {
    const proxy = await fakeProxy((socket) => socket.once('data', () => socket.destroy()));
    await expect(composerFor(proxy.port).send(request({ url: 'http://a.example/' }))).rejects.toThrow(
      /closed the connection|Couldn't send/,
    );
    await proxy.close();
  });

  it('gives up when the proxy never records it, and forgets the send', async () => {
    const proxy = await fakeProxy(() => undefined);
    const composer = composerFor(proxy.port, 200);
    await expect(composer.send(request({ url: 'http://a.example/' }))).rejects.toThrow(
      "didn't receive the request",
    );
    expect(composer.claim(12345, '127.0.0.1', 'x')).toBe(false);
    await proxy.close();
  });

  it('refuses a tunnel the proxy won’t open', async () => {
    const proxy = await fakeProxy((socket) =>
      socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')),
    );
    await expect(composerFor(proxy.port).send(request({ url: 'https://a.example/' }))).rejects.toThrow(
      '(403)',
    );
    await proxy.close();
  });

  it('fails a send still waiting when it stops', async () => {
    const proxy = await fakeProxy(() => undefined);
    const composer = composerFor(proxy.port, 10_000);
    const sending = composer.send(request({ url: 'http://a.example/' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    composer.close();
    await expect(sending).rejects.toThrow('Wirescry stopped');
    await proxy.close();
  });

  it('says so when the proxy can’t be reached', async () => {
    const proxy = await fakeProxy(() => undefined);
    await proxy.close();
    await expect(composerFor(proxy.port).send(request({ url: 'http://a.example/' }))).rejects.toThrow(
      "Couldn't connect to Wirescry's proxy",
    );
  });

  it('claims only from 127.0.0.1, on a port it is waiting for', () => {
    const composer = composerFor(1);
    expect(composer.claim(undefined, '127.0.0.1', 'x')).toBe(false);
    expect(composer.claim(1234, '127.0.0.2', 'x')).toBe(false);
    expect(composer.claim(1234, '::1', 'x')).toBe(false);
    expect(composer.claim(1234, '127.0.0.1', 'x')).toBe(false);
  });
});
