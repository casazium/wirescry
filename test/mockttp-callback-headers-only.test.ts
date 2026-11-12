/**
 * Replies made by a plugin's rule (a callback step, or `beforeRequest` on a pass-through step) with
 * no body and no trailers go out over HTTP/2 as one block of headers marked as the end of the
 * stream: a gRPC "Trailers-Only" reply. Wirescry's Mockttp patch (scripts/patch-mockttp.mjs) does
 * this; without it, the headers go first and the end follows on its own, and gRPC clients then
 * report INTERNAL instead of the status. Plugin API 11.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import * as mockttp from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost, PluginRule } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import { httpViaProxy, TOKEN, tunnelThroughProxy, UI_ORIGIN } from './helpers';

const HOST = 'grpc-mock.test';
const GRPC = { 'content-type': 'application/grpc' };
const NOT_FOUND = { ...GRPC, 'grpc-status': '5', 'grpc-message': 'order%2042%20not%20found' };

type Reply = mockttp.requestSteps.CallbackResponseMessageResult;

/** Each path's reply, as a plugin's callback returns it. */
const REPLIES: Record<string, () => Reply> = {
  '/trailers-only': () => ({ statusCode: 200, headers: NOT_FOUND }),
  '/empty-string-body': () => ({ statusCode: 200, headers: NOT_FOUND, body: '' }),
  '/empty-raw-body': () => ({ statusCode: 200, headers: NOT_FOUND, rawBody: Buffer.alloc(0) }),
  '/no-status-code': () => ({ headers: NOT_FOUND }),
  '/not-found': () => ({ statusCode: 404, statusMessage: 'Not Found' }),
  '/cookies': () => ({
    statusCode: 200,
    headers: { ...GRPC, 'grpc-status': '16', 'set-cookie': ['a=1', 'b=2'] },
  }),
  '/with-body': () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'all of it' }),
  '/with-raw-body': () => ({ statusCode: 200, headers: GRPC, rawBody: Buffer.from([0, 0, 0, 0, 0]) }),
  '/with-trailers': () => ({
    statusCode: 200,
    headers: GRPC,
    trailers: { 'grpc-status': '5', 'grpc-message': 'gone' },
  }),
  '/with-empty-trailers': () => ({ statusCode: 200, headers: GRPC, trailers: {} }),
  '/json': () => ({ statusCode: 200, json: {} }),
  '/throws': () => {
    throw new Error('callback broke');
  },
};

interface H2Result {
  headers: http2.IncomingHttpHeaders;
  /** Whether the response headers were marked as the end of the stream. */
  headersEnded: boolean;
  body: Buffer;
  trailers?: http2.IncomingHttpHeaders;
  rstCode?: number;
}

describe('HTTP/2 replies from plugin rules, through Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let ca: string;
  let emptyFile: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-callback-headers-only-'));
    emptyFile = path.join(dataDir, 'empty.bin');
    await writeFile(emptyFile, '');
    const plugin: BackendPlugin = {
      name: 'callback-replies',
      apiVersion: PLUGIN_API_VERSION,
      async start(pluginHost) {
        await pluginHost.setProxyRules(rulesFor(pluginHost));
      },
      async handle() {
        return undefined;
      },
    };
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [plugin],
      pluginsEnabled: true,
    });
    ca = await readFile(backend.caCertPath, 'utf8');
  });

  const rulesFor = (host: BackendPluginHost): PluginRule[] => {
    const onHost = new mockttp.matchers.HostnameMatcher(HOST);
    const rules: PluginRule[] = [
      {
        // As a breakpoint's request-stage reply: beforeRequest answers instead of the server.
        id: 'before-request',
        label: 'Before request',
        matchers: [onHost, new mockttp.matchers.FlexiblePathMatcher('/before-request')],
        steps: [
          host.passThroughStep({
            beforeRequest: () => ({ response: { statusCode: 200, headers: NOT_FOUND } }),
          }),
        ],
      },
      {
        id: 'empty-file',
        label: 'Empty file',
        matchers: [onHost, new mockttp.matchers.FlexiblePathMatcher('/empty-file')],
        steps: [
          new mockttp.requestSteps.FileStep(200, undefined, emptyFile, { 'content-type': 'text/plain' }),
        ],
      },
      {
        id: 'callback',
        label: 'Callback',
        matchers: [onHost],
        steps: [
          new mockttp.requestSteps.CallbackStep((request) => {
            const reply = REPLIES[new URL(request.url).pathname];
            return reply ? reply() : { statusCode: 500, body: 'no reply for this path' };
          }),
        ],
      },
    ];
    return rules;
  };

  afterAll(async () => {
    await backend?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Sends one HTTP/2 request through Wirescry, noting how the response arrived. */
  const viaWirescry = async (urlPath: string): Promise<H2Result> => {
    const socket = await tunnelThroughProxy(backend.proxyPort, `${HOST}:443`);
    const secure = tls.connect({ socket, servername: HOST, ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://${HOST}`, { createConnection: () => secure });
    try {
      return await new Promise<H2Result>((resolve, reject) => {
        const req = session.request(
          { ':method': 'POST', ':path': urlPath, ...GRPC, te: 'trailers' },
          { endStream: true },
        );
        const chunks: Buffer[] = [];
        const result: H2Result = { headers: {}, headersEnded: false, body: Buffer.alloc(0) };
        req.on('response', (headers, flags) => {
          result.headers = headers;
          result.headersEnded = (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0;
        });
        req.on('trailers', (trailers) => (result.trailers = trailers));
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('error', reject);
        req.on('close', () => resolve({ ...result, body: Buffer.concat(chunks), rstCode: req.rstCode }));
      });
    } finally {
      session.close();
    }
  };

  describe('with no body and no trailers: one block of headers, marked as the end', () => {
    it('sends a gRPC error the way gRPC servers do (Trailers-Only)', async () => {
      const result = await viaWirescry('/trailers-only');
      expect(result.headersEnded).toBe(true);
      expect(result.headers[':status']).toBe(200);
      expect(result.headers['content-type']).toBe('application/grpc');
      expect(result.headers['grpc-status']).toBe('5');
      expect(result.headers['grpc-message']).toBe('order%2042%20not%20found');
      expect(result.body.length).toBe(0);
      expect(result.trailers).toBeUndefined();
      expect(result.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
    });

    it.each(['/empty-string-body', '/empty-raw-body'])(
      'treats an empty body as none (%s)',
      async (urlPath) => {
        const result = await viaWirescry(urlPath);
        expect(result.headersEnded).toBe(true);
        expect(result.headers['grpc-status']).toBe('5');
        expect(result.body.length).toBe(0);
      },
    );

    it('uses status 200 when the reply gives none, as before', async () => {
      const result = await viaWirescry('/no-status-code');
      expect(result.headersEnded).toBe(true);
      expect(result.headers[':status']).toBe(200);
      expect(result.headers['grpc-status']).toBe('5');
    });

    it('does the same for any reply without a body, such as a 404', async () => {
      const result = await viaWirescry('/not-found');
      expect(result.headersEnded).toBe(true);
      expect(result.headers[':status']).toBe(404);
      expect(result.body.length).toBe(0);
    });

    it('keeps repeated headers, in order', async () => {
      const result = await viaWirescry('/cookies');
      expect(result.headersEnded).toBe(true);
      expect(result.headers['grpc-status']).toBe('16');
      expect(result.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    });

    it("does it for a reply made before the request is sent on (a breakpoint's)", async () => {
      const result = await viaWirescry('/before-request');
      expect(result.headersEnded).toBe(true);
      expect(result.headers['grpc-status']).toBe('5');
      expect(result.body.length).toBe(0);
    });
  });

  describe('with a body or trailers: unchanged', () => {
    it('sends the headers first, then the body', async () => {
      const result = await viaWirescry('/with-body');
      expect(result.headersEnded).toBe(false);
      expect(result.body.toString()).toBe('all of it');
    });

    it('sends a gRPC message as it was', async () => {
      const result = await viaWirescry('/with-raw-body');
      expect(result.headersEnded).toBe(false);
      expect([...result.body]).toEqual([0, 0, 0, 0, 0]);
    });

    it('sends the status in trailers after the headers, with no body', async () => {
      const result = await viaWirescry('/with-trailers');
      expect(result.headersEnded).toBe(false);
      expect(result.headers['grpc-status']).toBeUndefined();
      expect(result.body.length).toBe(0);
      expect(result.trailers?.['grpc-status']).toBe('5');
      expect(result.trailers?.['grpc-message']).toBe('gone');
      expect(result.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
    });

    it('treats trailers given, even none, as trailers', async () => {
      const result = await viaWirescry('/with-empty-trailers');
      expect(result.headersEnded).toBe(false);
      expect(result.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
    });

    it('sends a JSON reply with its body', async () => {
      const result = await viaWirescry('/json');
      expect(result.headersEnded).toBe(false);
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body.toString()).toBe('{}');
    });

    it("still reports a callback that throws as a 500 with Mockttp's message", async () => {
      const result = await viaWirescry('/throws');
      expect(result.headersEnded).toBe(false);
      expect(result.headers[':status']).toBe(500);
      expect(result.body.toString()).toContain('callback broke');
    });

    it('still ends a reply from an empty file', async () => {
      const result = await viaWirescry('/empty-file');
      expect(result.headers[':status']).toBe(200);
      expect(result.body.length).toBe(0);
      expect(result.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
    });
  });

  describe('over HTTP/1.1: unchanged', () => {
    it('sends a reply without a body, complete', async () => {
      const result = await httpViaProxy(backend.proxyPort, `http://${HOST}/not-found`);
      expect(result.status).toBe(404);
      expect(result.body).toBe('');
    });

    it('sends a reply with a body, complete', async () => {
      const result = await httpViaProxy(backend.proxyPort, `http://${HOST}/with-body`);
      expect(result.status).toBe(200);
      expect(result.body).toBe('all of it');
    });
  });
});
