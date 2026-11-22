import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import http2 from 'node:http2';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import * as mockttp from 'mockttp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTION_HELPER } from '../scripts/patch-mockttp.mjs';
import { startUpstreamOnPickedPort } from './helpers';

// HTTP/2 forbids headers that apply to one connection only (RFC 9113, section 8.2.2). Node takes them
// as a response's headers are set, but refuses them as it sends the head, and keeps them, so even
// Mockttp's own error reply failed and the response never finished; in trailers, the refusal was
// an uncaught error. Wirescry's Mockttp patch (scripts/patch-mockttp.mjs) leaves them out of HTTP/2
// heads and trailers.

const drop = new Function('exports', `${CONNECTION_HELPER}\nreturn wirescryDropConnectionHeaders;`)({}) as (
  headers: Record<string, unknown>,
) => Record<string, unknown>;

const PER_CONNECTION = {
  'Transfer-Encoding': 'chunked',
  'keep-alive': 'timeout=5',
  'proxy-connection': 'close',
  upgrade: 'h2c',
  'http2-settings': 'AAMAAABk',
  te: 'gzip',
  connection: 'close',
};

describe('leaving out per-connection headers', () => {
  it('leaves out each one HTTP/2 forbids, in any case, and keeps the rest', () => {
    expect(drop({ ...PER_CONNECTION, 'Content-Type': 'text/plain', 'x-a': ['1', '2'] })).toEqual({
      'Content-Type': 'text/plain',
      'x-a': ['1', '2'],
    });
    expect(drop({ 'KEEP-ALIVE': 'x', Upgrade: 'h2c', 'x-b': 'kept' })).toEqual({ 'x-b': 'kept' });
  });

  it('keeps TE only when it is "trailers" alone, as Node allows', () => {
    expect(drop({ te: 'trailers' })).toEqual({ te: 'trailers' });
    expect(drop({ TE: ['trailers'] })).toEqual({ TE: ['trailers'] });
    for (const te of ['gzip', 'Trailers', ' trailers', '', ['trailers', 'gzip'], ['trailers', 'trailers']])
      expect(drop({ te })).toEqual({});
    // Two TE headers, even both "trailers": Node refuses them too.
    expect(drop({ te: 'trailers', TE: 'trailers', 'x-a': '1' })).toEqual({ 'x-a': '1' });
  });

  it('matches names as Node stores them, trimmed', () => {
    expect(drop({ 'keep-alive ': 'x', ' Transfer-Encoding': 'chunked', ' te ': 'gzip', 'x-a': '1' })).toEqual(
      {
        'x-a': '1',
      },
    );
    expect(drop({ ' te': 'trailers' })).toEqual({ ' te': 'trailers' });
  });

  it('returns the same object when there is nothing to leave out', () => {
    const headers = { 'content-type': 'application/grpc', 'grpc-status': '5', te: 'trailers' };
    expect(drop(headers)).toBe(headers);
    const empty = {};
    expect(drop(empty)).toBe(empty);
  });

  it('ignores a TE header given no value', () => {
    expect(drop({ te: undefined, 'x-a': '1' })).toStrictEqual({ te: undefined, 'x-a': '1' });
  });
});

interface H2Result {
  status?: number;
  headers: http2.IncomingHttpHeaders;
  /** Whether the response headers were marked as the end of the stream. */
  headersEnded: boolean;
  body: string;
  trailers?: http2.IncomingHttpHeaders;
  timedOut?: boolean;
}

function h2Request(url: string, urlPath: string): Promise<H2Result> {
  const session = http2.connect(url);
  return new Promise<H2Result>((resolve) => {
    const result: H2Result = { headers: {}, headersEnded: false, body: '' };
    const timer = setTimeout(() => resolve({ ...result, timedOut: true }), 3000);
    const req = session.request({ ':path': urlPath }, { endStream: true });
    req.on('response', (headers, flags) => {
      result.status = headers[':status'];
      result.headers = headers;
      result.headersEnded = (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0;
    });
    req.on('trailers', (trailers) => (result.trailers = trailers));
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (result.body += chunk));
    req.on('error', () => undefined);
    req.on('close', () => {
      clearTimeout(timer);
      resolve(result);
    });
  }).finally(() => session.destroy());
}

const FORBIDDEN_NAMES = Object.keys(PER_CONNECTION).map((name) => name.toLowerCase());
const expectNoneForbidden = (headers: Record<string, unknown>) => {
  for (const name of FORBIDDEN_NAMES) expect(headers[name]).toBeUndefined();
};

describe('Mockttp replies over HTTP/2 with per-connection headers', () => {
  const server = mockttp.getLocal({ http2: true });
  let dir: string;
  let recorded: mockttp.CompletedResponse[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-conn-'));
    await writeFile(path.join(dir, 'reply.txt'), 'from a file');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await startUpstreamOnPickedPort(server);
    recorded = [];
    await server.on('response', (response) => recorded.push(response));
  });
  afterEach(async () => {
    await server.stop();
  });

  it('sends a fixed reply, without them', async () => {
    await server.forGet('/fixed').thenReply(200, 'all of it', { ...PER_CONNECTION, 'x-kept': 'yes' });
    const result = await h2Request(server.url, '/fixed');
    expect(result.timedOut).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe('all of it');
    expect(result.headers['x-kept']).toBe('yes');
    expectNoneForbidden(result.headers);
  });

  it('sends a reply from a file, without them', async () => {
    await server
      .forGet('/file')
      .thenFromFile(200, path.join(dir, 'reply.txt'), { 'Transfer-Encoding': 'chunked' });
    const result = await h2Request(server.url, '/file');
    expect(result.timedOut).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe('from a file');
    expectNoneForbidden(result.headers);
  });

  it('sends a callback reply with a body, without them', async () => {
    await server.forGet('/callback-body').thenCallback(() => ({
      statusCode: 201,
      headers: { ...PER_CONNECTION, 'content-type': 'text/plain' },
      body: 'made',
    }));
    const result = await h2Request(server.url, '/callback-body');
    expect(result.timedOut).toBeUndefined();
    expect(result.status).toBe(201);
    expect(result.body).toBe('made');
    expectNoneForbidden(result.headers);
  });

  it('sends a callback reply with no body as one block of headers, without them', async () => {
    await server.forGet('/callback-empty').thenCallback(() => ({
      statusCode: 200,
      headers: { ...PER_CONNECTION, 'content-type': 'application/grpc', 'grpc-status': '5' },
    }));
    const result = await h2Request(server.url, '/callback-empty');
    expect(result.timedOut).toBeUndefined();
    expect(result.headersEnded).toBe(true);
    expect(result.headers['grpc-status']).toBe('5');
    expectNoneForbidden(result.headers);
  });

  it('does the same for raw headers, and for a reply that also repeats a header', async () => {
    await server.forGet('/raw').thenCallback(() => ({
      statusCode: 200,
      headers: [
        ['Keep-Alive', 'timeout=5'],
        ['grpc-status', '5'],
        ['TE', 'gzip'],
      ] as unknown as Record<string, string>,
    }));
    await server.forGet('/repeated').thenCallback(() => ({
      statusCode: 200,
      headers: { 'transfer-encoding': 'chunked', vary: ['a', 'b'], 'grpc-status': '5' },
    }));
    const raw = await h2Request(server.url, '/raw');
    expect(raw.timedOut).toBeUndefined();
    expect(raw.headersEnded).toBe(true);
    expect(raw.headers['grpc-status']).toBe('5');
    expectNoneForbidden(raw.headers);
    // A repeated header (other than Set-Cookie) goes the usual way, which leaves them out too:
    const repeated = await h2Request(server.url, '/repeated');
    expect(repeated.timedOut).toBeUndefined();
    expect(repeated.headersEnded).toBe(false);
    expect(repeated.headers.vary).toBe('a, b');
    expectNoneForbidden(repeated.headers);
  });

  it('keeps TE: trailers, as HTTP/2 allows', async () => {
    await server.forGet('/te').thenReply(200, 'ok', { te: 'trailers' });
    const result = await h2Request(server.url, '/te');
    expect(result.timedOut).toBeUndefined();
    expect(result.headers.te).toBe('trailers');
  });

  it('sends a stream reply, without them', async () => {
    const body = new PassThrough();
    await server.forGet('/stream').thenStream(200, body, { 'Transfer-Encoding': 'chunked', 'x-kept': 'yes' });
    body.end('streamed');
    const result = await h2Request(server.url, '/stream');
    expect(result.timedOut).toBeUndefined();
    expect(result.body).toBe('streamed');
    expect(result.headers['x-kept']).toBe('yes');
    expectNoneForbidden(result.headers);
  });

  it('sends trailers without them, from a callback and from a fixed reply', async () => {
    await server.forGet('/callback-trailers').thenCallback(() => ({
      statusCode: 200,
      headers: { 'content-type': 'application/grpc' },
      body: 'x',
      trailers: { 'grpc-status': '0', 'transfer-encoding': 'chunked', 'Keep-Alive': 'x' },
    }));
    // Mockttp sends a fixed reply's trailers only with Transfer-Encoding: chunked among its headers,
    // so before, over HTTP/2, every such reply hung.
    await server
      .forGet('/fixed-trailers')
      .thenReply(200, 'x', { 'transfer-encoding': 'chunked' }, { 'grpc-status': '0', 'keep-alive': 'x' });
    for (const urlPath of ['/callback-trailers', '/fixed-trailers']) {
      const result = await h2Request(server.url, urlPath);
      expect(result.timedOut).toBeUndefined();
      expect(result.body).toBe('x');
      expect(result.trailers?.['grpc-status']).toBe('0');
      expectNoneForbidden(result.trailers ?? {});
    }
    // Recorded as sent:
    await expect.poll(() => recorded.length).toBe(2);
    for (const response of recorded) {
      const names = response.rawTrailers.map(([name]) => name.toLowerCase());
      expect(names).toContain('grpc-status');
      for (const name of FORBIDDEN_NAMES) expect(names).not.toContain(name);
    }
  });

  it("records a reply's headers without them", async () => {
    await server.forGet('/recorded').thenReply(200, 'ok', { ...PER_CONNECTION, 'x-kept': 'yes' });
    const result = await h2Request(server.url, '/recorded');
    expect(result.timedOut).toBeUndefined();
    await expect.poll(() => recorded.length).toBe(1);
    const names = recorded[0]!.rawHeaders.map(([name]) => name.toLowerCase());
    expect(names).toContain('x-kept');
    for (const name of FORBIDDEN_NAMES) expect(names).not.toContain(name);
  });
});

describe('Mockttp forwarding to an HTTP/1.1 server, over HTTP/2', () => {
  const server = mockttp.getLocal({ http2: true });
  // An upstream server that answers with a body in chunks and per-connection trailers.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', trailer: 'x-t' });
    res.write('from upstream');
    res.addTrailers({ 'x-t': '1', 'Keep-Alive': 'timeout=5' });
    res.end();
  });
  let upstreamUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  beforeEach(async () => {
    await startUpstreamOnPickedPort(server);
  });
  afterEach(() => server.stop());

  it("passes on the server's trailers without them", async () => {
    await server.forGet('/forwarded').thenForwardTo(upstreamUrl);
    const result = await h2Request(server.url, '/forwarded');
    expect(result.timedOut).toBeUndefined();
    expect(result.body).toBe('from upstream');
    expect(result.trailers?.['x-t']).toBe('1');
    expectNoneForbidden(result.trailers ?? {});
  });

  it('leaves them out of headers a beforeResponse hook adds', async () => {
    await server.forGet('/changed').thenForwardTo(upstreamUrl, {
      beforeResponse: (response) => ({
        headers: {
          ...response.headers,
          'transfer-encoding': 'chunked',
          'proxy-connection': 'close',
          'x-added': 'yes',
        },
      }),
    });
    const result = await h2Request(server.url, '/changed');
    expect(result.timedOut).toBeUndefined();
    expect(result.body).toBe('from upstream');
    expect(result.headers['x-added']).toBe('yes');
    expectNoneForbidden(result.headers);
  });
});

describe('Mockttp replies over HTTP/1.1 with the same headers', () => {
  const server = mockttp.getLocal();
  beforeEach(async () => {
    await startUpstreamOnPickedPort(server);
  });
  afterEach(() => server.stop());

  it('sends them as given, as before', async () => {
    await server.forGet('/h1').thenReply(200, 'all of it', {
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      'x-kept': 'yes',
    });
    const { headers, body } = await new Promise<{ headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        http
          .get(`${server.url}/h1`, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (text += chunk));
            res.on('end', () => resolve({ headers: res.headers, body: text }));
          })
          .on('error', reject);
      },
    );
    expect(body).toBe('all of it');
    expect(headers['keep-alive']).toBe('timeout=5');
    expect(headers['transfer-encoding']).toBe('chunked');
    expect(headers['x-kept']).toBe('yes');
  });
});
