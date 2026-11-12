/**
 * The composer's gRPC calls (src/backend/composer.ts): sent over HTTP/2 through Wirescry's own
 * proxy, so the proxy talks HTTP/2 to the server, and binary bodies given as base64.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { Composer, MAX_COMPOSER_BODY, validateComposerRequest } from '../src/backend/composer';
import type { BodyContent, ComposerRequest, ExchangeDetail } from '../src/shared/api';
import { apiClient, exchangesIn, latestExchange, localhostCertificate, TOKEN, UI_ORIGIN } from './helpers';

const request = (overrides: Partial<ComposerRequest>): ComposerRequest => ({
  method: 'POST',
  url: 'https://example.com/shop.Orders/Get',
  headers: [],
  body: '',
  ...overrides,
});

/** Bytes that aren't UTF-8 text: they must arrive exactly as given. */
const BINARY = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x04, 0xff, 0x80, 0x00, 0x0a]);

describe('validateComposerRequest: gRPC calls and binary bodies', () => {
  it('keeps a gRPC call and its bytes', () => {
    const valid = validateComposerRequest(
      request({ grpc: true, body: '{"id":"7"}', bodyBase64: BINARY.toString('base64') }),
    );
    expect(valid.grpc).toBe(true);
    expect(valid.bodyBytes.equals(BINARY)).toBe(true);
    // The text stays as written; the bytes are what's sent.
    expect(valid.body).toBe('{"id":"7"}');
  });

  it('sends the text when there are no bytes, and marks nothing as gRPC unless asked', () => {
    const valid = validateComposerRequest(request({ body: 'é' }));
    expect(valid.bodyBytes.equals(Buffer.from('é'))).toBe(true);
    expect('grpc' in valid).toBe(false);
    expect('bodyBase64' in valid).toBe(false);
    expect(validateComposerRequest(request({ grpc: false })).grpc).toBeUndefined();
  });

  it('drops HTTP2-Settings with the other connection headers', () => {
    const valid = validateComposerRequest(
      request({
        grpc: true,
        headers: [
          ['HTTP2-Settings', 'AAMAAABkAAQAoAAAAAIAAAAA'],
          ['x-a', '1'],
        ],
      }),
    );
    expect(valid.headers).toEqual([['x-a', '1']]);
  });

  it('ignores the text’s size when bytes are given, since only the bytes are sent', () => {
    const valid = validateComposerRequest(
      request({ body: 'x'.repeat(MAX_COMPOSER_BODY + 1), bodyBase64: BINARY.toString('base64') }),
    );
    expect(valid.bodyBytes.equals(BINARY)).toBe(true);
  });

  it('accepts an empty body as base64, and exactly the largest body', () => {
    expect(validateComposerRequest(request({ bodyBase64: '' })).bodyBytes.length).toBe(0);
    const largest = Buffer.alloc(MAX_COMPOSER_BODY, 0xff).toString('base64');
    expect(validateComposerRequest(request({ bodyBase64: largest })).bodyBytes.length).toBe(
      MAX_COMPOSER_BODY,
    );
  });

  it.each([
    [{ grpc: true, url: 'http://example.com/shop.Orders/Get' }, 'only to an https:// URL'],
    [{ grpc: true, method: 'GET' }, 'sent as POST'],
    [{ grpc: true, method: 'put' }, 'sent as POST'],
    [{ grpc: 'yes' }, 'must be true or false'],
    [{ bodyBase64: 123 }, 'must be in base64'],
    [{ bodyBase64: 'abc' }, 'aren’t valid base64'],
    [{ bodyBase64: 'ab$=' }, 'aren’t valid base64'],
    [{ bodyBase64: '-_8=' }, 'aren’t valid base64'],
    // Too long to decode at all (so its size is what's wrong, before its form), and one byte over
    // once decoded.
    [{ bodyBase64: 'A'.repeat(700_001) }, 'at most 512 KB'],
    [{ bodyBase64: Buffer.alloc(MAX_COMPOSER_BODY + 1).toString('base64') }, 'at most 512 KB'],
  ] as const)('refuses %#: %j', (overrides, message) => {
    expect(() => validateComposerRequest(request(overrides as unknown as Partial<ComposerRequest>))).toThrow(
      message,
    );
  });
});

describe('composer: gRPC calls through the proxy', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let server: http2.Http2SecureServer;
  let plain: http.Server;
  let port: number;
  let plainPort: number;
  /** What the server got for each path: headers as sent (lowercase name, value pairs) and the body. */
  const received = new Map<string, { headers: http2.IncomingHttpHeaders; raw: string[]; body: Buffer }>();
  let watching = false;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-composer-grpc-'));
    const upstreamCA = await generateCACertificate();
    const leaf = await localhostCertificate(upstreamCA);
    server = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    server.on(
      'stream',
      (
        stream: http2.ServerHttp2Stream,
        headers: http2.IncomingHttpHeaders,
        _flags: number,
        raw: string[],
      ) => {
        const route = String(headers[':path']).split('?')[0]!;
        const chunks: Buffer[] = [];
        stream.on('error', () => undefined);
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          received.set(route, { headers, raw, body: Buffer.concat(chunks) });
          const grpc = { ':status': 200, 'content-type': 'application/grpc' };
          if (route === '/shop.Orders/Get') {
            // Echoes the request's bytes, then a status in the trailers.
            stream.respond(grpc, { waitForTrailers: true });
            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'x-served': 'yes' }));
            stream.end(Buffer.concat(chunks));
          } else if (route === '/shop.Orders/Watch') {
            // A stream that keeps going until the client cancels it.
            stream.respond(grpc);
            stream.write(Buffer.from([0, 0, 0, 0, 0]), () => (watching = true));
          }
          // Anything else never answers.
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;

    // HTTP/1.1, for a binary body sent without gRPC.
    plain = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hex: body.toString('hex'), length: req.headers['content-length'] }));
      });
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    plainPort = (plain.address() as net.AddressInfo).port;

    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    server?.close();
    plain?.closeAllConnections();
    plain?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const origin = (): string => `https://localhost:${port}`;

  it('sends it over HTTP/2 with the bytes as given, recorded as composed with its trailers', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({
        url: `${origin()}/shop.Orders/Get?from=composer`,
        grpc: true,
        headers: [
          ['Content-Type', 'application/grpc'],
          ['grpc-timeout', '30S'],
          ['X-Token', 'abc'],
        ],
        body: '{"id":"7"}',
        bodyBase64: BINARY.toString('base64'),
      }),
    });
    await expect
      .poll(() => latestExchange(api.messages, (e) => e.id === exchangeId)?.durationMs)
      .toBeDefined();
    const summary = latestExchange(api.messages, (e) => e.id === exchangeId);
    expect(summary).toMatchObject({ composed: true, status: 200, method: 'POST', httpVersion: '2.0' });
    expect(summary?.failure).toBeUndefined();

    // The server got HTTP/2 from the proxy, with gRPC's headers and the exact bytes.
    const got = received.get('/shop.Orders/Get');
    expect(got?.body.equals(BINARY)).toBe(true);
    expect(got?.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/shop.Orders/Get?from=composer',
      te: 'trailers',
      'content-type': 'application/grpc',
      'grpc-timeout': '30S',
      'x-token': 'abc',
    });

    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId });
    expect(detail.responseTrailers).toEqual(
      expect.arrayContaining([
        ['grpc-status', '0'],
        ['x-served', 'yes'],
      ]),
    );
    const sent = await api.send<BodyContent>({ command: 'getBody', exchangeId, side: 'request' });
    expect(Buffer.from(sent.base64, 'base64').equals(BINARY)).toBe(true);
    const reply = await api.send<BodyContent>({ command: 'getBody', exchangeId, side: 'response' });
    expect(Buffer.from(reply.base64, 'base64').equals(BINARY)).toBe(true);
    api.close();
  });

  it('leaves out the headers Wirescry sets, and sends a repeated header once per value', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({
        url: `${origin()}/shop.Orders/Get`,
        grpc: true,
        headers: [
          ['Host', 'elsewhere.example'],
          ['Connection', 'keep-alive'],
          ['Keep-Alive', '5'],
          ['TE', 'gzip'],
          ['Content-Length', '999'],
          ['X-Tag', 'a'],
          ['x-tag', 'b'],
        ],
        body: 'text',
      }),
    });
    await expect
      .poll(() => latestExchange(api.messages, (e) => e.id === exchangeId)?.durationMs)
      .toBeDefined();
    const got = received.get('/shop.Orders/Get')!;
    expect(got.body.toString()).toBe('text');
    expect(got.headers.te).toBe('trailers');
    expect(got.headers[':authority']).toBe(`localhost:${port}`);
    expect(got.headers.host).toBeUndefined();
    expect(got.headers.connection).toBeUndefined();
    expect(got.headers['keep-alive']).toBeUndefined();
    expect(got.headers['content-length']).not.toBe('999');
    const tags = got.raw.flatMap((value, i) => (i % 2 === 0 && value === 'x-tag' ? [got.raw[i + 1]] : []));
    expect(tags).toEqual(['a', 'b']);
    api.close();
  });

  it('sends headers named like object properties as ordinary headers', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({
        url: `${origin()}/shop.Orders/Get`,
        grpc: true,
        headers: [
          ['constructor', 'x'],
          ['__proto__', 'z'],
          ['toString', 'y'],
        ],
      }),
    });
    await expect
      .poll(() => latestExchange(api.messages, (e) => e.id === exchangeId)?.durationMs)
      .toBeDefined();
    // What reached the proxy, as recorded. (Mockttp itself can't pass a `__proto__` header on to
    // the server, so the call fails there; that's past the composer.)
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId });
    const valuesOf = (name: string) =>
      detail.requestHeaders.flatMap(([key, value]) => (key === name ? [value] : []));
    expect(valuesOf('constructor')).toEqual(['x']);
    expect(valuesOf('__proto__')).toEqual(['z']);
    expect(valuesOf('tostring')).toEqual(['y']);
    expect(valuesOf('te')).toEqual(['trailers']);
    api.close();
  });

  it('cancels a call waiting for its reply', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ url: `${origin()}/shop.Orders/Slow`, grpc: true }),
    });
    await expect.poll(() => received.has('/shop.Orders/Slow')).toBe(true);
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(true);
    await expect.poll(() => latestExchange(api.messages, (e) => e.id === exchangeId)?.failure).toBeDefined();
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(false);
    api.close();
  });

  it('cancels a stream still sending, which the proxy records as cut off by the client', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ url: `${origin()}/shop.Orders/Watch`, grpc: true }),
    });
    await expect.poll(() => watching).toBe(true);
    expect(latestExchange(api.messages, (e) => e.id === exchangeId)?.durationMs).toBeUndefined();
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(true);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId && e.failure))
      .toMatchObject({ status: 200, failure: { kind: 'client-closed' } });
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(false);
    api.close();
  });

  it('sends a binary body over HTTP/1.1 too, with its length', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({
        url: `http://127.0.0.1:${plainPort}/upload`,
        bodyBase64: BINARY.toString('base64'),
      }),
    });
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId && e.responseSize !== undefined))
      .toMatchObject({ composed: true, status: 200, httpVersion: '1.1' });
    const reply = await api.send<BodyContent>({ command: 'getBody', exchangeId, side: 'response' });
    expect(JSON.parse(Buffer.from(reply.base64, 'base64').toString())).toEqual({
      hex: BINARY.toString('hex'),
      length: String(BINARY.length),
    });
    api.close();
  });

  it('says why when Node refuses a header given twice, and records nothing', async () => {
    const api = await apiClient(backend.apiPort);
    await expect(
      api.send({
        command: 'composeSend',
        request: request({
          url: `${origin()}/shop.Orders/Twice`,
          grpc: true,
          headers: [
            ['content-type', 'application/grpc'],
            ['Content-Type', 'application/grpc+proto'],
          ],
        }),
      }),
    ).rejects.toThrow("Couldn't send the request");
    // Give a wrongly sent request time to show up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exchangesIn(api.messages).find((e) => e.path === '/shop.Orders/Twice')).toBeUndefined();
    expect(received.has('/shop.Orders/Twice')).toBe(false);
    api.close();
  });

  it('refuses a gRPC call to an http:// URL before sending anything', async () => {
    const api = await apiClient(backend.apiPort);
    await expect(
      api.send({
        command: 'composeSend',
        request: request({ url: `http://127.0.0.1:${plainPort}/shop.Orders/Get`, grpc: true }),
      }),
    ).rejects.toThrow('only to an https:// URL');
    api.close();
  });
});

describe('composer: gRPC calls to a proxy that misbehaves', () => {
  let ca: { key: string; cert: string };
  let leaf: { key: string; cert: string };
  beforeAll(async () => {
    ca = await generateCACertificate();
    leaf = await localhostCertificate(ca);
  });

  /**
   * A stand-in proxy that opens the tunnel, then speaks HTTP/2 itself, handing each stream to
   * `onStream` with a way to claim it as the real proxy would.
   */
  async function fakeH2Proxy(
    onStream: (stream: http2.ServerHttp2Stream, claim: () => void) => void,
    options: { caCert?: string } = {},
  ) {
    const h2 = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    const ports = new WeakMap<object, number>();
    h2.on('secureConnection', (secure: tls.TLSSocket) => {
      ports.set(secure, (secure as unknown as { _parent?: net.Socket })._parent?.remotePort ?? 0);
    });
    h2.on('stream', (stream: http2.ServerHttp2Stream) => {
      stream.on('error', () => undefined);
      const port = ports.get(stream.session!.socket as object) ?? tunnelPorts.at(-1)!;
      onStream(stream, () => composer.claim(port, '127.0.0.1', 'call-1'));
    });
    const sockets = new Set<net.Socket>();
    const tunnelPorts: number[] = [];
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      tunnelPorts.push(socket.remotePort!);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        h2.emit('connection', socket);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const composer = new Composer({
      proxyPort: () => (proxy.address() as net.AddressInfo).port,
      caCert: () => options.caCert ?? ca.cert,
      claimTimeoutMs: 5000,
    });
    return {
      composer,
      sockets,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => proxy.close(resolve));
      },
    };
  }
  const call = () => request({ url: 'https://localhost/shop.Orders/Get', grpc: true });

  it('says the proxy refused it when it answers before recording the request', async () => {
    const proxy = await fakeH2Proxy((stream) => stream.respond({ ':status': 431 }, { endStream: true }));
    try {
      const started = Date.now();
      await expect(proxy.composer.send(call())).rejects.toThrow("Wirescry's proxy refused the request (431)");
      expect(Date.now() - started).toBeLessThan(3000);
      // Its connection to the proxy is closed, not left open.
      await expect.poll(() => proxy.sockets.size).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it.each([
    [
      'refuses the stream',
      http2.constants.NGHTTP2_REFUSED_STREAM,
      "Couldn't send the request: Stream closed",
    ],
    [
      'closes the stream with no error',
      http2.constants.NGHTTP2_NO_ERROR,
      "Wirescry's proxy closed the stream without recording the request.",
    ],
  ])('says so when the proxy %s without recording it', async (_name, code, message) => {
    const proxy = await fakeH2Proxy((stream) => stream.close(code));
    try {
      await expect(proxy.composer.send(call())).rejects.toThrow(message);
      await expect.poll(() => proxy.sockets.size).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it('refuses a proxy whose certificate isn’t Wirescry’s', async () => {
    const other = await generateCACertificate();
    const proxy = await fakeH2Proxy(() => undefined, { caCert: other.cert });
    try {
      await expect(proxy.composer.send(call())).rejects.toThrow("Couldn't send the request");
    } finally {
      await proxy.close();
    }
  });

  it('closes a finished call’s stream normally, and a cancelled one with CANCEL', async () => {
    const codes: number[] = [];
    let pending: http2.ServerHttp2Stream | undefined;
    const proxy = await fakeH2Proxy((stream, claim) => {
      stream.on('close', () => codes.push(stream.rstCode ?? -1));
      stream.resume();
      stream.on('end', () => {
        claim();
        if (stream.sentHeaders) return;
        if (codes.length === 0 && !pending) {
          // The first call finishes: a message, then the status in trailers.
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end(Buffer.from([0, 0, 0, 0, 0]));
        } else {
          // The second waits, to be cancelled.
          pending = stream;
        }
      });
    });
    try {
      await proxy.composer.send(call());
      await expect.poll(() => codes).toEqual([http2.constants.NGHTTP2_NO_ERROR]);
      await expect.poll(() => proxy.sockets.size).toBe(0);

      await proxy.composer.send(call());
      await expect.poll(() => pending).toBeDefined();
      expect(proxy.composer.cancel('call-1')).toBe(true);
      await expect
        .poll(() => codes)
        .toEqual([http2.constants.NGHTTP2_NO_ERROR, http2.constants.NGHTTP2_CANCEL]);
      await expect.poll(() => proxy.sockets.size).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it('says so when the proxy won’t speak HTTP/2, instead of sending the call over HTTP/1.1', async () => {
    let spoke: string | false | null | undefined;
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Picks no protocol, as a proxy that only speaks HTTP/1.1 may.
        const secure = new tls.TLSSocket(socket, { isServer: true, key: leaf.key, cert: leaf.cert });
        secure.on('error', () => undefined);
        secure.on('secure', () => (spoke = secure.alpnProtocol));
        secure.on('data', () => (spoke = 'request'));
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const composer = new Composer({
      proxyPort: () => (proxy.address() as net.AddressInfo).port,
      caCert: () => ca.cert,
      claimTimeoutMs: 2000,
    });
    try {
      await expect(
        composer.send(request({ url: 'https://localhost/shop.Orders/Get', grpc: true })),
      ).rejects.toThrow("didn't agree to HTTP/2");
      // No request went over the TLS connection.
      expect(spoke).not.toBe('request');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
