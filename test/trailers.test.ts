/**
 * Trailers: headers sent after a body. gRPC puts a call's status in the response's trailers, so
 * Wirescry keeps them on the exchange (src/backend/proxy.ts), shows them, and writes them to and
 * reads them from HAR files in its own `_trailers` field (src/backend/har.ts).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { harEntry, parseHar } from '../src/backend/har';
import type { ExchangeDetail, ExchangeSummary } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

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

describe('trailers through Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let h2Server: http2.Http2SecureServer;
  let h2Port: number;
  let h1Server: http.Server;
  let h1Port: number;
  let ca: string;
  /** What the HTTP/1.1 server last saw as request trailers. */
  let seenTrailers: NodeJS.Dict<string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-trailers-'));
    const upstreamCA = await generateCACertificate();
    const require = createRequire(import.meta.url);
    const { getCA } = require('mockttp/dist/util/certificates');
    const leaf = await (
      await getCA({ key: upstreamCA.key, cert: upstreamCA.cert })
    ).generateCertificate('localhost');

    h2Server = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    h2Server.on('stream', (stream, headers) => {
      if (headers[':path']?.startsWith('/with-trailers')) {
        // A normal gRPC reply: headers, one message, then the status in trailers.
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'fine' }));
        stream.end(Buffer.from([0, 0, 0, 0, 0]));
      } else {
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('no trailers here');
      }
    });
    await new Promise<void>((resolve) => h2Server.listen(0, '127.0.0.1', resolve));
    h2Port = (h2Server.address() as net.AddressInfo).port;

    h1Server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seenTrailers = { ...req.trailers };
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => h1Server.listen(0, '127.0.0.1', resolve));
    h1Port = (h1Server.address() as net.AddressInfo).port;

    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
    ca = await readFile(backend.caCertPath, 'utf8');
  });

  afterAll(async () => {
    await backend?.stop();
    // Wirescry keeps its HTTP/2 connection to the server open, so don't wait for it to close.
    h2Server?.close();
    h1Server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Sends one HTTP/2 request through Wirescry and reads the whole response. */
  const h2ViaWirescry = async (urlPath: string): Promise<void> => {
    const socket = await tunnel(backend.proxyPort, `localhost:${h2Port}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${h2Port}`, { createConnection: () => secure });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = session.request({ ':method': 'POST', ':path': urlPath }, { endStream: true });
        req.resume();
        req.on('error', reject);
        req.on('close', resolve);
      });
    } finally {
      session.close();
    }
  };

  /** The recorded exchange whose path is this, once it has finished. */
  const recorded = async (urlPath: string): Promise<ExchangeDetail> => {
    const api = await apiClient(backend.apiPort);
    let found: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        found = exchangesIn(api.messages).find((e) => e.path === urlPath && e.durationMs !== undefined);
        return found;
      })
      .toBeTruthy();
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: found!.id });
    api.close();
    return detail;
  };

  /** Sends a chunked HTTP/1.1 upload with a request trailer through Wirescry. */
  const uploadViaWirescry = (urlPath: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: backend.proxyPort,
          method: 'POST',
          path: `http://127.0.0.1:${h1Port}${urlPath}`,
          headers: { 'transfer-encoding': 'chunked', trailer: 'x-checksum' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.write('part one');
      req.addTrailers({ 'x-checksum': 'abc123' });
      req.end();
    });

  it('keeps a response’s trailers, such as a gRPC status', async () => {
    await h2ViaWirescry('/with-trailers');
    const detail = await recorded('/with-trailers');
    expect(detail.responseTrailers).toEqual([
      ['grpc-status', '0'],
      ['grpc-message', 'fine'],
    ]);
    // Not mixed into the headers.
    expect(detail.responseHeaders?.some(([name]) => name === 'grpc-status')).toBe(false);
  });

  it('records no trailers for a response without any', async () => {
    await h2ViaWirescry('/plain');
    const detail = await recorded('/plain');
    expect(detail.responseTrailers).toBeUndefined();
    expect(detail.requestTrailers).toBeUndefined();
  });

  it('keeps a request’s trailers, and still passes them on', async () => {
    await uploadViaWirescry('/upload');
    const detail = await recorded('/upload');
    expect(detail.requestTrailers).toEqual([['x-checksum', 'abc123']]);
    expect(seenTrailers['x-checksum']).toBe('abc123');
  });

  it('exports trailers to a HAR file, and imports them back onto the exchange', async () => {
    await h2ViaWirescry('/with-trailers?again');
    const original = await recorded('/with-trailers?again');
    await uploadViaWirescry('/upload?again');
    const upload = await recorded('/upload?again');
    const file = path.join(dataDir, 'trailers.har');
    expect(await backend.exportHar(file, [original.summary.id, upload.summary.id])).toEqual({ count: 2 });
    const result = await backend.importHar(file);
    expect(result.imported).toBe(2);
    const api = await apiClient(backend.apiPort);
    let found: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        found = exchangesIn(api.messages).find((e) => e.path === '/with-trailers?again' && e.imported);
        return found;
      })
      .toBeTruthy();
    const imported = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: found!.id });
    let importedUpload: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        importedUpload = exchangesIn(api.messages).find((e) => e.path === '/upload?again' && e.imported);
        return importedUpload;
      })
      .toBeTruthy();
    const uploadDetail = await api.send<ExchangeDetail>({
      command: 'getExchange',
      exchangeId: importedUpload!.id,
    });
    api.close();
    expect(imported.responseTrailers).toEqual(original.responseTrailers);
    expect(uploadDetail.requestTrailers).toEqual([['x-checksum', 'abc123']]);
  });
});

describe('trailers in HAR files', () => {
  const base: ExchangeDetail = {
    summary: {
      id: 'a',
      method: 'POST',
      protocol: 'https',
      httpVersion: '2.0',
      host: 'api.test',
      path: '/shop.v1.Orders/Get',
      url: 'https://api.test/shop.v1.Orders/Get',
      startedAt: 0,
      status: 200,
    },
    requestHeaders: [['content-type', 'application/grpc']],
    responseHeaders: [['content-type', 'application/grpc']],
    timing: { startTimestamp: 0 },
  };
  const har = (entries: unknown[]): string => JSON.stringify({ log: { version: '1.2', entries } });
  type Written = { request: Record<string, unknown>; response: Record<string, unknown> };

  it('writes trailers in a `_trailers` field, and reads them back', async () => {
    const detail: ExchangeDetail = {
      ...base,
      requestTrailers: [['x-checksum', 'abc']],
      responseTrailers: [
        ['grpc-status', '5'],
        ['grpc-message', 'not found'],
      ],
    };
    const written = harEntry({ detail, requestBody: null, responseBody: null }) as Written;
    expect(written.response._trailers).toEqual([
      { name: 'grpc-status', value: '5' },
      { name: 'grpc-message', value: 'not found' },
    ]);
    expect(written.request._trailers).toEqual([{ name: 'x-checksum', value: 'abc' }]);
    const [again] = (await parseHar(har([written]), 10)).exchanges;
    expect(again!.responseTrailers).toEqual(detail.responseTrailers);
    expect(again!.requestTrailers).toEqual(detail.requestTrailers);
  });

  it('writes no `_trailers` field when there were none', () => {
    const written = harEntry({ detail: base, requestBody: null, responseBody: null }) as Written;
    expect('_trailers' in written.response).toBe(false);
    expect('_trailers' in written.request).toBe(false);
  });

  it('keeps an entry whose `_trailers` aren’t headers, leaving the trailers out', async () => {
    const written = harEntry({ detail: base, requestBody: null, responseBody: null }) as Written;
    written.response._trailers = 'something another tool wrote';
    written.request._trailers = [{ name: 'only a name' }];
    const result = await parseHar(har([written]), 10);
    expect(result.skipped).toBe(0);
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]!.responseTrailers).toBeUndefined();
    expect(result.exchanges[0]!.requestTrailers).toBeUndefined();
  });

  it('reads no response trailers for an entry with no response', async () => {
    const written = harEntry({
      detail: { ...base, summary: { ...base.summary, status: undefined } },
      requestBody: null,
      responseBody: null,
    }) as Written;
    written.response.status = 0;
    written.response._trailers = [{ name: 'grpc-status', value: '0' }];
    const [again] = (await parseHar(har([written]), 10)).exchanges;
    expect(again!.responseTrailers).toBeUndefined();
  });
});
