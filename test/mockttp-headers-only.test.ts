import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_MARKER, EDITS, MARKER, MARKERS, patchText, TARGET } from '../scripts/patch-mockttp.mjs';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ExchangeDetail } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

// Wirescry patches Mockttp after install (scripts/patch-mockttp.mjs) so that an HTTP/2 response
// the server ended with its headers alone reaches the client the same way. gRPC sends most errors
// like that ("Trailers-Only"), and gRPC clients report INTERNAL instead of the real status otherwise.

describe('the Mockttp patch script', () => {
  const pristine = EDITS.map((edit) => `before\n${edit.find}after\n`).join('');

  it('applies every part to text that has each place once', () => {
    const out = patchText(pristine);
    expect(out).toContain(MARKER);
    expect(out).toContain(CALLBACK_MARKER);
    expect(EDITS.map((edit) => edit.name)).toEqual(['helper', 'detect', 'callback']);
    for (const edit of EDITS) expect(out).toContain(edit.replace);
    expect(out).toContain('before\n');
  });

  it('leaves patched text alone, so running it twice is safe', () => {
    const once = patchText(pristine);
    expect(patchText(once)).toBe(once);
    // Each part once: the helper, for one, keeps the text it was found by.
    for (const edit of EDITS) expect(once.split(edit.replace).length - 1).toBe(1);
  });

  it('adds the newer parts to an install patched by an older version of the script', () => {
    const [helper, detect] = EDITS;
    const older = pristine.replace(helper!.find, helper!.replace).replace(detect!.find, detect!.replace);
    expect(older).toContain(MARKER);
    expect(older).not.toContain(CALLBACK_MARKER);
    const out = patchText(older);
    expect(out).toBe(patchText(pristine));
  });

  it('refuses when the callback part no longer fits', () => {
    const missing = pristine.replace(EDITS[2]!.find, 'something else\n');
    expect(() => patchText(missing)).toThrow(/"callback" part of the patch matches 0 places/);
  });

  it('sends a callback reply as headers alone only over HTTP/2, with no body and no trailers', () => {
    const callback = EDITS[2]!.replace;
    expect(callback).toContain('(0, request_utils_1.isHttp2)(response)');
    expect(callback).toContain('!result.trailers');
    expect(callback).toContain('!(result.rawBody?.length > 0)');
    // A bare end(): end("") would send the headers before the end.
    expect(callback).toMatch(/wirescryHeadOnly\(response[^\n]*\n\s*response\.end\(\);\n\s*return;/);
    // Otherwise, exactly as Mockttp did.
    expect(callback.endsWith(EDITS[2]!.find)).toBe(true);
  });

  it('refuses when Mockttp has changed so a part no longer fits', () => {
    const missing = pristine.replace(EDITS[1]!.find, 'something else\n');
    expect(() => patchText(missing)).toThrow(/"detect" part of the patch matches 0 places/);
  });

  it('refuses when a place appears twice, rather than guess', () => {
    const twice = pristine + EDITS[1]!.find;
    expect(() => patchText(twice)).toThrow(/"detect" part of the patch matches 2 places/);
  });

  it('is checked again before packaging, by the same marker', () => {
    const require = createRequire(import.meta.url);
    const root = path.dirname(path.dirname(require.resolve('mockttp')));
    const builder = readFileSync(path.join(root, '..', '..', 'electron-builder.cjs'), 'utf8');
    expect(MARKERS).toEqual([MARKER, CALLBACK_MARKER]);
    for (const marker of MARKERS) expect(builder).toContain(`'${marker}'`);
    // All of them, not any: an install patched by an older script has the first one only.
    expect(builder).toMatch(/markers\.every\(\(marker\) => mockttpText\.includes\(marker\)\)/);
    const config = require('../electron-builder.cjs') as { beforePack: (context: object) => void };
    // With the installed (patched) Mockttp, this check passes (later checks may fail: no build here).
    expect(() => config.beforePack({ electronPlatformName: 'darwin', arch: 3 })).not.toThrow(
      /Mockttp is not patched/,
    );
  });

  it('has been applied to the installed Mockttp', () => {
    const require = createRequire(import.meta.url);
    // Mockttp's main file is dist/main.js.
    const packageDir = path.dirname(path.dirname(require.resolve('mockttp')));
    const installed = readFileSync(path.join(packageDir, TARGET), 'utf8');
    for (const marker of MARKERS) expect(installed).toContain(marker);
  });
});

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

interface H2Result {
  headers: http2.IncomingHttpHeaders;
  /** Whether the response headers were marked as the end of the stream. */
  headersEnded: boolean;
  body: string;
  trailers?: http2.IncomingHttpHeaders;
  rstCode?: number;
}

describe('HTTP/2 responses that end with their headers, through Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let upstream: http2.Http2SecureServer;
  let upstreamPort: number;
  let ca: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-h2-headers-only-'));
    const upstreamCA = await generateCACertificate();
    const require = createRequire(import.meta.url);
    const { getCA } = require('mockttp/dist/util/certificates');
    const leaf = await (
      await getCA({ key: upstreamCA.key, cert: upstreamCA.cert })
    ).generateCertificate('localhost');

    upstream = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    upstream.on('stream', (stream, headers) => {
      const route = headers[':path']?.split('?')[0];
      const grpc = { 'content-type': 'application/grpc' };
      if (route === '/trailers-only') {
        // A gRPC error with no messages: one block of headers, marked as the end.
        stream.respond(
          { ':status': 200, ...grpc, 'grpc-status': '5', 'grpc-message': 'order%2042%20not%20found' },
          { endStream: true },
        );
      } else if (route === '/trailers-only-cookies') {
        // Headers alone, with a header that appears twice: order matters for cookies.
        stream.respond(
          { ':status': 200, ...grpc, 'grpc-status': '16', 'set-cookie': ['a=1', 'b=2'] },
          { endStream: true },
        );
      } else if (route === '/ok') {
        // A normal gRPC reply: headers, one empty message, then the status in trailers.
        stream.respond({ ':status': 200, ...grpc }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end(Buffer.from([0, 0, 0, 0, 0]));
      } else if (route === '/quick-body') {
        // Headers and a short body, ended at once: the body must not be lost.
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('all of it');
      } else if (route === '/late-end') {
        // Headers now, the (empty) end later: the headers mustn't wait for the end.
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        setTimeout(() => stream.end(), 400);
      } else {
        stream.respond({ ':status': 404 }, { endStream: true });
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;

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
    upstream?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Sends one HTTP/2 request through Wirescry, noting how the response arrived. */
  const viaWirescry = async (urlPath: string, onHeaders?: () => void): Promise<H2Result> => {
    const socket = await tunnel(backend.proxyPort, `localhost:${upstreamPort}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${upstreamPort}`, { createConnection: () => secure });
    try {
      return await new Promise<H2Result>((resolve, reject) => {
        const req = session.request(
          { ':method': 'POST', ':path': urlPath, 'content-type': 'application/grpc', te: 'trailers' },
          { endStream: true },
        );
        const result: H2Result = { headers: {}, headersEnded: false, body: '' };
        req.on('response', (headers, flags) => {
          result.headers = headers;
          result.headersEnded = (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0;
          onHeaders?.();
        });
        req.on('trailers', (trailers) => (result.trailers = trailers));
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (result.body += chunk));
        req.on('error', reject);
        req.on('close', () => resolve({ ...result, rstCode: req.rstCode }));
      });
    } finally {
      session.close();
    }
  };

  it('passes on a gRPC error sent as headers alone, still marked as the end', async () => {
    const result = await viaWirescry('/trailers-only');
    expect(result.headersEnded).toBe(true);
    expect(result.headers[':status']).toBe(200);
    expect(result.headers['grpc-status']).toBe('5');
    expect(result.headers['grpc-message']).toBe('order%2042%20not%20found');
    expect(result.body).toBe('');
    expect(result.trailers).toBeUndefined();
    expect(result.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
  });

  it('still records the status and headers of such a response', async () => {
    const api = await apiClient(backend.apiPort);
    await viaWirescry('/trailers-only?recorded');
    let id: string | undefined;
    await expect
      .poll(() => {
        id = exchangesIn(api.messages).find((e) => e.path === '/trailers-only?recorded' && e.status)?.id;
        return id;
      })
      .toBeTruthy();
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id! });
    expect(detail.summary.status).toBe(200);
    const names = (detail.responseHeaders ?? []).map(([name]) => name.toLowerCase());
    expect(names).toContain('grpc-status');
    expect(names).toContain('grpc-message');
    api.close();
  });

  it('keeps repeated headers in order, sent and recorded', async () => {
    const api = await apiClient(backend.apiPort);
    const result = await viaWirescry('/trailers-only-cookies');
    expect(result.headersEnded).toBe(true);
    expect(result.headers['grpc-status']).toBe('16');
    expect(result.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    let id: string | undefined;
    await expect
      .poll(() => {
        id = exchangesIn(api.messages).find((e) => e.path === '/trailers-only-cookies' && e.status)?.id;
        return id;
      })
      .toBeTruthy();
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id! });
    const cookies = (detail.responseHeaders ?? []).filter(([name]) => name.toLowerCase() === 'set-cookie');
    expect(cookies.map(([, value]) => value)).toEqual(['a=1', 'b=2']);
    api.close();
  });

  it('leaves a normal gRPC reply as it was: headers, message, then status in trailers', async () => {
    const result = await viaWirescry('/ok');
    expect(result.headersEnded).toBe(false);
    expect(result.headers['grpc-status']).toBeUndefined();
    expect(result.body.length).toBe(5);
    expect(result.trailers?.['grpc-status']).toBe('0');
  });

  it("doesn't lose a short body that arrived with the end", async () => {
    const result = await viaWirescry('/quick-body');
    expect(result.headersEnded).toBe(false);
    expect(result.body).toBe('all of it');
  });

  it("doesn't hold back headers until a slow response ends", async () => {
    let headersAt = 0;
    const result = await viaWirescry('/late-end', () => (headersAt = Date.now()));
    const endedAt = Date.now();
    expect(result.headersEnded).toBe(false);
    expect(result.body).toBe('');
    // The server ends 400 ms after its headers; the headers must have come well before that.
    expect(endedAt - headersAt).toBeGreaterThan(200);
  });

  it('passes on any response ended with its headers the same way, such as a 404', async () => {
    const result = await viaWirescry('/nothing-here');
    expect(result.headersEnded).toBe(true);
    expect(result.headers[':status']).toBe(404);
    expect(result.body).toBe('');
  });
});
