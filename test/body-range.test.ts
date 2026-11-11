/**
 * Reading part of a body through the real backend, while it arrives and after: the UI's
 * getBodyRange command and plugins' readBody (src/backend/backend.ts, plugin-host.ts).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { BodyRangeContent, ExchangeSummary } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const WAIT = { timeout: 10_000 };

describe('reading part of a body through the backend', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let server: http.Server;
  let port: number;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let host: BackendPluginHost | undefined;
  let finish: () => void = () => undefined;
  /** 200 KB: past what's kept in memory, so it goes to a file while it arrives. */
  const first = Buffer.alloc(200 * 1024, 'a');

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-range-'));
    server = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(first);
        finish = () => res.end('the end');
      } else {
        res.end('small');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
    const reader: BackendPlugin = {
      name: 'reader',
      apiVersion: PLUGIN_API_VERSION,
      start: (h) => void (host = h),
      stop: () => undefined,
      handle: async () => undefined,
    };
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [reader],
      pluginsEnabled: true,
    });
    api = await apiClient(backend.apiPort);
    // Until the plugin has started.
    for (let i = 0; !host && i < 200; i++) await new Promise((r) => setTimeout(r, 50));
    if (!host) throw new Error('the plugin never started');
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    server?.closeAllConnections();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const latest = (urlPath: string): ExchangeSummary | undefined =>
    exchangesIn(api.messages)
      .filter((e) => e.path === urlPath)
      .at(-1);
  const range = async (id: string, offset: number, maxBytes: number) =>
    (await api.send({
      command: 'getBodyRange',
      exchangeId: id,
      side: 'response',
      offset,
      maxBytes,
    })) as BodyRangeContent | null;

  /** Reads a body from the start in pieces, as a live view would. */
  const readAll = async (id: string, piece: number): Promise<{ text: string; last: BodyRangeContent }> => {
    let offset = 0;
    let text = '';
    let last: BodyRangeContent;
    for (;;) {
      last = (await range(id, offset, piece))!;
      const bytes = Buffer.from(last.base64, 'base64');
      text += bytes.toString();
      offset += bytes.length;
      if (bytes.length === 0 || offset >= last.stored) return { text, last };
    }
  };

  it('reads a response while it arrives, in pieces from an offset, and again once it ends', async () => {
    const response = new Promise<void>((resolve, reject) => {
      const url = `http://127.0.0.1:${port}/stream`;
      const req = http.request(
        { host: '127.0.0.1', port: backend.proxyPort, path: url, headers: { host: `127.0.0.1:${port}` } },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });
    await expect.poll(() => latest('/stream')?.responseReceived, WAIT).toBe(first.length);
    const id = latest('/stream')!.id;

    const live = await readAll(id, 50_000);
    expect(live.text).toBe(first.toString());
    expect(live.last).toMatchObject({ receiving: true, stored: first.length, incomplete: false });

    // A plugin reads the same bytes, raw.
    const piece = await host!.readBody(id, 'response', { offset: first.length - 3, maxBytes: 10 });
    expect(Buffer.from(piece!.bytes).toString()).toBe('aaa');
    expect(piece).toMatchObject({ receiving: true, serial: live.last.serial, decoded: false });
    expect(live.last.decoded).toBe(false);

    finish();
    await response;
    await expect.poll(() => latest('/stream')?.responseSize, WAIT).toBeDefined();
    const done = await readAll(id, 64 * 1024);
    expect(done.text).toBe(`${first.toString()}the end`);
    expect(done.last).toMatchObject({ receiving: false, serial: live.last.serial });
    // Reading on from where the live read stopped gives just what came after.
    const rest = await range(id, first.length, 1000);
    expect(Buffer.from(rest!.base64, 'base64').toString()).toBe('the end');
  });

  it('says there is nothing for a side with no body, or an exchange that is gone', async () => {
    await new Promise<void>((resolve, reject) => {
      const url = `http://127.0.0.1:${port}/small`;
      http
        .get(
          { host: '127.0.0.1', port: backend.proxyPort, path: url, headers: { host: `127.0.0.1:${port}` } },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        )
        .on('error', reject);
    });
    await expect.poll(() => latest('/small')?.responseSize, WAIT).toBe(5);
    const id = latest('/small')!.id;
    // A GET sends no body.
    expect(
      await api.send({ command: 'getBodyRange', exchangeId: id, side: 'request', offset: 0, maxBytes: 10 }),
    ).toBeNull();
    expect(await host!.readBody(id, 'request', { offset: 0, maxBytes: 10 })).toBeNull();
    // Gone: the UI is told; a plugin gets null.
    await expect(range('no-such-exchange', 0, 10)).rejects.toThrow(/not found/);
    expect(await host!.readBody('no-such-exchange', 'response', { offset: 0, maxBytes: 10 })).toBeNull();
    // Not an exchange id at all: still just nothing.
    expect(await host!.readBody('../escape', 'response', { offset: 0, maxBytes: 10 })).toBeNull();
    await expect(range('../escape', 0, 10)).rejects.toThrow(/not found/);
  });

  it('says a body imported from a HAR file is already decoded', async () => {
    const file = path.join(dataDir, 'imported.har');
    const entry = {
      startedDateTime: new Date().toISOString(),
      time: 5,
      request: {
        method: 'GET',
        url: 'https://imported.test/data',
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'content-encoding', value: 'gzip' }],
        cookies: [],
        content: { size: 13, mimeType: 'text/plain', text: 'imported body' },
        redirectURL: '',
        headersSize: -1,
        bodySize: 30,
      },
      cache: {},
      timings: { send: 0, wait: 5, receive: 0 },
    };
    await writeFile(file, JSON.stringify({ log: { version: '1.2', entries: [entry] } }));
    await backend.importHar(file);
    await expect.poll(() => latest('/data')?.imported, WAIT).toBe(true);
    const imported = await range(latest('/data')!.id, 0, 100);
    expect(imported).toMatchObject({ decoded: true, receiving: false });
    expect(Buffer.from(imported!.base64, 'base64').toString()).toBe('imported body');
  });

  it('refuses a bad side, offset or length', async () => {
    const id = latest('/small')!.id;
    await expect(
      api.send({ command: 'getBodyRange', exchangeId: id, side: 'other' as never, offset: 0, maxBytes: 10 }),
    ).rejects.toThrow(/side/);
    await expect(range(id, -1, 10)).rejects.toThrow(/whole number/);
    await expect(range(id, 0, 0)).rejects.toThrow(/whole number/);
    await expect(host!.readBody(id, 'other' as never, { offset: 0, maxBytes: 10 })).rejects.toThrow(/side/);
    await expect(host!.readBody(id, 'response', { offset: '0', maxBytes: 10 } as never)).rejects.toThrow(
      /numbers/,
    );
    await expect(host!.readBody(id, 'response', { offset: 0.5, maxBytes: 10 })).rejects.toThrow(
      /whole number/,
    );
    await expect(host!.readBody(id, 'response', undefined as never)).rejects.toThrow(/numbers/);
    await expect(
      api.send({
        command: 'getBodyRange',
        exchangeId: id,
        side: 'response',
        offset: '0' as never,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/whole number/);
  });
});
