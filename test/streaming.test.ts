import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BodyContent, ExchangeDetail, FormattedBody } from '../src/shared/api';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

const MB = 1024 * 1024;

describe('streaming bodies', () => {
  let dataDir: string;
  let server: http.Server;
  let origin: string;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-stream-test-'));
    const big = Buffer.alloc(20 * MB, 'a');
    const bigGzip = gzipSync(Buffer.alloc(30 * MB, 'b'));
    server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        // Several writes, so the body really streams.
        for (let i = 0; i < 20; i++) res.write(big.subarray(i * MB, (i + 1) * MB));
        res.end();
      } else if (req.url === '/big-gzip') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(bigGzip);
      } else if (req.url === '/cut') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000000' });
        res.write('only part of the body');
        setTimeout(() => res.destroy(), 50);
      } else {
        res.end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      maxBodySize: 16 * MB,
    });
  });

  afterAll(async () => {
    await backend?.stop();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('streams a large body to disk, keeping only up to the limit, and sends the UI the first 5 MB', async () => {
    const api = await apiClient(backend.apiPort);
    const response = await httpViaProxy(backend.proxyPort, `${origin}/big`);
    expect(response.body.length).toBe(20 * MB); // The client still gets everything.

    const id = await api.completed('/big');
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id });
    expect(detail.responseBody).toEqual({ size: 20 * MB, stored: 16 * MB });
    const file = (await readdir(path.join(dataDir, 'bodies'))).find((f) => f.startsWith(`${id}.response.`))!;
    expect((await stat(path.join(dataDir, 'bodies', file))).size).toBe(16 * MB);

    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'response' });
    expect(body.truncated).toBe(true);
    expect(Buffer.from(body.base64, 'base64').length).toBe(5 * MB);
    api.close();
  });

  it('decodes only as much of a large compressed body as the UI needs', async () => {
    const api = await apiClient(backend.apiPort);
    await httpViaProxy(backend.proxyPort, `${origin}/big-gzip`);
    const id = await api.completed('/big-gzip');
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'response' });
    expect(body.encoding).toBe('gzip');
    expect(body.decodeError).toBeUndefined();
    expect(body.truncated).toBe(true);
    expect(body.decodedSize).toBeUndefined();
    const text = Buffer.from(body.base64, 'base64').toString();
    expect(text.length).toBe(5 * MB);
    expect(text).toMatch(/^b+$/);
    api.close();
  });

  it('marks a body that was cut off part way', async () => {
    const api = await apiClient(backend.apiPort);
    await httpViaProxy(backend.proxyPort, `${origin}/cut`).catch(() => undefined);
    let id: string | undefined;
    await expect
      .poll(() => {
        id = exchangesIn(api.messages).find((e) => e.path === '/cut' && e.responseSize !== undefined)?.id;
        return id;
      })
      .toBeTruthy();
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id! });
    expect(detail.responseBody).toMatchObject({ incomplete: true, size: 'only part of the body'.length });
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id!, side: 'response' });
    expect(Buffer.from(body.base64, 'base64').toString()).toBe('only part of the body');
    api.close();
  });
});

describe('formatBody', () => {
  let dataDir: string;
  let server: http.Server;
  let origin: string;
  let backend: RunningBackend;
  const minifiedJs = 'function hello(n){if(n>1){return"many"}return"one"}';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-format-test-'));
    server = http.createServer((req, res) => {
      const routes: Record<string, [string, string | Buffer, Record<string, string>?]> = {
        '/app.js': ['application/javascript', gzipSync(minifiedJs), { 'content-encoding': 'gzip' }],
        '/page': ['text/html; charset=utf-8', '<div><p>Hi</p></div>'],
        '/data.json': ['application/json', '{"a":1}'],
        '/huge.js': ['text/javascript', 'a();'.repeat(600_000)],
      };
      const [type, body, extra] = routes[req.url ?? ''] ?? ['text/plain', 'ok'];
      res.writeHead(200, { 'content-type': type, ...extra });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    backend = await startBackend({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });
  });

  afterAll(async () => {
    await backend?.stop();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const format = async (route: string): Promise<FormattedBody> => {
    const api = await apiClient(backend.apiPort);
    await httpViaProxy(backend.proxyPort, `${origin}${route}`);
    const id = await api.completed(route);
    const result = await api.send<FormattedBody>({ command: 'formatBody', exchangeId: id, side: 'response' });
    api.close();
    return result;
  };

  it('decodes and formats compressed JavaScript', async () => {
    expect(await format('/app.js')).toEqual({
      ok: true,
      language: 'js',
      text: 'function hello(n) {\n  if (n > 1) {\n    return "many"\n  }\n  return "one"\n}',
    });
  });

  it('formats HTML', async () => {
    expect(await format('/page')).toEqual({ ok: true, language: 'html', text: '<div>\n  <p>Hi</p>\n</div>' });
  });

  it('declines other types and bodies over 2 MB', async () => {
    expect(await format('/data.json')).toMatchObject({ ok: false });
    expect(await format('/huge.js')).toEqual({ ok: false, reason: 'too large to format (over 2 MB)' });
  });
});
