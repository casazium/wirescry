/**
 * gRPC calls through Wirescry's proxy (src/backend/proxy.ts) and from HAR files
 * (src/backend/har.ts): marked as gRPC, with the call's status and message on the summary.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { parseHar } from '../src/backend/har';
import type { ExchangeSummary } from '../src/shared/api';
import {
  apiClient,
  exchangesIn,
  localhostCertificate,
  TOKEN,
  tunnelThroughProxy,
  UI_ORIGIN,
} from './helpers';

describe('gRPC status through Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let server: http2.Http2SecureServer;
  let port: number;
  let ca: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-grpc-status-'));
    const upstreamCA = await generateCACertificate();
    const leaf = await localhostCertificate(upstreamCA);
    server = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    server.on('stream', (stream, headers) => {
      const route = headers[':path']?.split('?')[0];
      const grpc = { 'content-type': 'application/grpc' };
      if (route === '/shop.Orders/Missing') {
        // An error with no messages: the status in the headers, marked as the end.
        stream.respond(
          { ':status': 200, ...grpc, 'grpc-status': '5', 'grpc-message': 'order%2042%20not%20found' },
          { endStream: true },
        );
      } else if (route === '/shop.Orders/Get') {
        stream.respond({ ':status': 200, ...grpc }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end(Buffer.from([0, 0, 0, 0, 0]));
      } else if (route === '/shop.Web/Call') {
        // gRPC-Web, known only from the response's type; an error sent with nothing else.
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc-web+proto', 'grpc-status': '7' },
          { endStream: true },
        );
      } else if (route === '/shop.Orders/Broken') {
        // A proxy in front of the gRPC server answered with an HTTP error and no gRPC status.
        stream.respond({ ':status': 503, 'content-type': 'text/plain' });
        stream.end('upstream unavailable');
      } else {
        // Not gRPC, though it sends a header named like gRPC's.
        stream.respond({ ':status': 200, 'content-type': 'application/json', 'grpc-status': '5' });
        stream.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
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
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Sends one call through Wirescry, then returns its summary once it has finished. */
  const callViaWirescry = async (
    urlPath: string,
    contentType = 'application/grpc',
  ): Promise<ExchangeSummary> => {
    const api = await apiClient(backend.apiPort);
    const socket = await tunnelThroughProxy(backend.proxyPort, `localhost:${port}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${port}`, { createConnection: () => secure });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = session.request(
          { ':method': 'POST', ':path': urlPath, 'content-type': contentType, te: 'trailers' },
          { endStream: true },
        );
        req.resume();
        req.on('error', reject);
        req.on('close', resolve);
      });
    } finally {
      session.close();
    }
    let found: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        found = exchangesIn(api.messages).find((e) => e.path === urlPath && e.durationMs !== undefined);
        return found;
      })
      .toBeTruthy();
    api.close();
    return found!;
  };

  it('records an error sent with nothing else, with its message decoded', async () => {
    const summary = await callViaWirescry('/shop.Orders/Missing');
    expect(summary.status).toBe(200);
    expect(summary.grpc).toBe(true);
    expect(summary.grpcStatus).toBe(5);
    expect(summary.grpcMessage).toBe('order 42 not found');
  });

  it('records OK from the trailers', async () => {
    const summary = await callViaWirescry('/shop.Orders/Get');
    expect(summary.grpc).toBe(true);
    expect(summary.grpcStatus).toBe(0);
    expect(summary.grpcMessage).toBeUndefined();
  });

  it('knows a gRPC-Web call from its response alone', async () => {
    const summary = await callViaWirescry('/shop.Web/Call', 'application/octet-stream');
    expect(summary.grpc).toBe(true);
    expect(summary.grpcStatus).toBe(7);
  });

  it('marks a gRPC call whose answer has no gRPC status, leaving the status out', async () => {
    const summary = await callViaWirescry('/shop.Orders/Broken');
    expect(summary.status).toBe(503);
    expect(summary.grpc).toBe(true);
    expect(summary.grpcStatus).toBeUndefined();
  });

  it('ignores a header named grpc-status on a request that isn’t gRPC', async () => {
    const summary = await callViaWirescry('/rest/thing', 'application/json');
    expect(summary.grpc).toBeUndefined();
    expect(summary.grpcStatus).toBeUndefined();
  });
});

describe('gRPC status from HAR files', () => {
  const entry = (requestType: string, response: Record<string, unknown>): Record<string, unknown> => ({
    startedDateTime: '2026-11-11T12:00:00.000Z',
    time: 10,
    request: {
      method: 'POST',
      url: 'https://api.test/shop.Orders/Missing',
      httpVersion: 'HTTP/2.0',
      headers: [{ name: 'content-type', value: requestType }],
    },
    response: {
      status: 200,
      statusText: '',
      headers: [{ name: 'content-type', value: 'application/grpc' }],
      content: { size: 0, mimeType: 'application/grpc' },
      ...response,
    },
    timings: { send: 1, wait: 8, receive: 1 },
  });
  const imported = async (e: Record<string, unknown>): Promise<ExchangeSummary> =>
    (await parseHar(JSON.stringify({ log: { version: '1.2', entries: [e] } }), 10)).exchanges[0]!
      .summary as ExchangeSummary;

  it('reads the status from the trailers', async () => {
    const summary = await imported(
      entry('application/grpc', {
        _trailers: [
          { name: 'grpc-status', value: '7' },
          { name: 'grpc-message', value: 'no%20access' },
        ],
      }),
    );
    expect(summary.grpc).toBe(true);
    expect(summary.grpcStatus).toBe(7);
    expect(summary.grpcMessage).toBe('no access');
  });

  it('reads the status from the headers when there are no trailers', async () => {
    const summary = await imported(
      entry('application/grpc', {
        headers: [
          { name: 'content-type', value: 'application/grpc' },
          { name: 'grpc-status', value: '16' },
        ],
      }),
    );
    expect(summary.grpcStatus).toBe(16);
  });

  it('leaves an entry that isn’t gRPC alone, whatever its headers say', async () => {
    const summary = await imported({
      ...entry('application/json', {
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'grpc-status', value: '5' },
        ],
        content: { size: 2, mimeType: 'application/json', text: '{}' },
      }),
    });
    expect(summary.grpc).toBeUndefined();
    expect(summary.grpcStatus).toBeUndefined();
  });

  it('reads no status for a call that never got a response', async () => {
    const summary = await imported(
      entry('application/grpc', { status: 0, headers: [{ name: 'grpc-status', value: '5' }] }),
    );
    expect(summary.grpc).toBe(true);
    expect(summary.grpcStatus).toBeUndefined();
  });
});
