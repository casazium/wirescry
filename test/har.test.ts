import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeBuffer } from 'http-encoding';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import { harEntry, MAX_HAR_IMPORT_BYTES, parseHar } from '../src/backend/har';
import type { BodyContent, ExchangeDetail, ServerMessage, WebSocketMessages } from '../src/shared/api';
import { apiClient, exchangesIn, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

const JSON_BODY = JSON.stringify({ users: [{ id: 1, name: 'Ada' }], note: 'héllo ✓' });
// Not valid UTF-8, so it has to travel as base64.
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

describe('HAR export and import', () => {
  let dir: string;
  let upstream: Mockttp;
  let upstreamCA: Awaited<ReturnType<typeof generateCACertificate>>;
  const backends: RunningBackend[] = [];

  const start = async (name: string): Promise<{ backend: RunningBackend; ca: string }> => {
    const dataDir = path.join(dir, name);
    const backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      app: { version: '9.9.9', releaseDate: new Date().toISOString() },
    });
    backends.push(backend);
    return { backend, ca: (await loadOrCreateCA(dataDir)).cert };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-har-'));
    upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream.forGet('/json').thenReply(200, await encodeBuffer(Buffer.from(JSON_BODY), 'gzip'), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    await upstream.forGet('/binary').thenReply(200, BINARY, { 'content-type': 'image/png' });
    await upstream.forPost('/echo').thenCallback((req) => ({
      statusCode: 201,
      body: req.body.buffer,
      headers: { 'content-type': 'application/json' },
    }));
  });

  afterAll(async () => {
    for (const backend of backends) await backend.stop();
    await upstream?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('exports what was captured, and imports it back exactly', async () => {
    const { backend, ca } = await start('first');
    const api = await apiClient(backend.apiPort);
    const base = `https://localhost:${upstream.port}`;
    await requestViaProxy(backend.proxyPort, `${base}/json`, ca);
    await requestViaProxy(backend.proxyPort, `${base}/binary`, ca);
    await requestViaProxy(backend.proxyPort, `${base}/echo?x=1`, ca, {
      method: 'POST',
      body: '{"hello":"world"}',
      headers: { 'content-type': 'application/json' },
    });
    const ids = [
      await api.completed('/json'),
      await api.completed('/binary'),
      await api.completed('/echo?x=1'),
    ];

    const file = path.join(dir, 'capture.har');
    expect(await backend.exportHar(file, [...ids, 'gone-already'])).toEqual({ count: 3 });
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]); // No temp file left.

    const har = JSON.parse(await readFile(file, 'utf8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Wirescry', version: '9.9.9' });
    const [json, binary, echo] = har.log.entries;
    // Bodies are written decoded, the way browsers write them.
    expect(json.response.content.text).toBe(JSON_BODY);
    expect(json.response.content.encoding).toBeUndefined();
    expect(json.response.headers).toContainEqual({ name: 'content-encoding', value: 'gzip' });
    expect(json.request.url).toBe(`${base}/json`);
    expect(json.response.status).toBe(200);
    expect(binary.response.content.encoding).toBe('base64');
    expect(Buffer.from(binary.response.content.text, 'base64').equals(BINARY)).toBe(true);
    expect(echo.request.method).toBe('POST');
    expect(echo.request.postData).toEqual({ mimeType: 'application/json', text: '{"hello":"world"}' });
    expect(echo.request.queryString).toEqual([{ name: 'x', value: '1' }]);
    expect(echo.response.status).toBe(201);
    api.close();

    // Into a fresh Wirescry.
    const second = (await start('second')).backend;
    expect(await second.importHar(file)).toEqual({ imported: 3, skipped: 0, problems: [], removed: 0 });
    const api2 = await apiClient(second.apiPort);
    await expect.poll(() => exchangesIn(api2.messages).length).toBe(3);
    const imported = exchangesIn(api2.messages);
    expect(imported.every((e) => e.imported === true)).toBe(true);
    expect(imported.map((e) => e.path)).toEqual(['/json', '/binary', '/echo?x=1']);

    const byPath = (p: string): string => imported.find((e) => e.path === p)!.id;
    const detail = await api2.send<ExchangeDetail>({ command: 'getExchange', exchangeId: byPath('/json') });
    expect(detail.importedFrom).toBe('capture.har');
    // Stored decoded, so its gzip header mustn't make Wirescry decode it again.
    const body = await api2.send<BodyContent>({
      command: 'getBody',
      exchangeId: byPath('/json'),
      side: 'response',
    });
    expect(body.decodeError).toBeUndefined();
    expect(Buffer.from(body.base64, 'base64').toString('utf8')).toBe(JSON_BODY);
    const png = await api2.send<BodyContent>({
      command: 'getBody',
      exchangeId: byPath('/binary'),
      side: 'response',
    });
    expect(Buffer.from(png.base64, 'base64').equals(BINARY)).toBe(true);
    const post = await api2.send<BodyContent>({
      command: 'getBody',
      exchangeId: byPath('/echo?x=1'),
      side: 'request',
    });
    expect(Buffer.from(post.base64, 'base64').toString('utf8')).toBe('{"hello":"world"}');

    // And out again: the same requests and bodies.
    const again = path.join(dir, 'again.har');
    await second.exportHar(
      again,
      imported.map((e) => e.id),
    );
    const entries = JSON.parse(await readFile(again, 'utf8')).log.entries;
    for (const [i, entry] of entries.entries()) {
      expect(entry.request.url).toBe(har.log.entries[i].request.url);
      expect(entry.response.content.text).toBe(har.log.entries[i].response.content.text);
    }
    api2.close();
  });

  it('refuses a file that is too large or not HAR', async () => {
    const { backend } = await start('third');
    const notHar = path.join(dir, 'not.har');
    await writeFile(notHar, '{"hello": 1}');
    await expect(backend.importHar(notHar)).rejects.toThrow('no log.entries');
    await writeFile(notHar, 'not json at all');
    await expect(backend.importHar(notHar)).rejects.toThrow("isn't valid JSON");
    const huge = path.join(dir, 'huge.har');
    await writeFile(huge, '');
    await truncate(huge, MAX_HAR_IMPORT_BYTES + 1); // Sparse, so it costs no disk.
    await expect(backend.importHar(huge)).rejects.toThrow('larger than 256 MB');
    await rm(huge);
  });

  it("fails an export it can't write, and keeps running", async () => {
    const { backend } = await start('unwritable');
    const har = (n: number): string =>
      JSON.stringify({
        log: {
          entries: Array.from({ length: n }, (_, i) => ({
            startedDateTime: '2026-10-26T12:00:00.000Z',
            request: { method: 'GET', url: `https://example.com/${i}` },
            response: { status: 200, content: { text: 'x'.repeat(200_000) } },
          })),
        },
      });
    const source = path.join(dir, 'source.har');
    await writeFile(source, har(3));
    await backend.importHar(source);
    const api = await apiClient(backend.apiPort);
    await expect.poll(() => exchangesIn(api.messages).length).toBe(3);
    const ids = exchangesIn(api.messages).map((e) => e.id);

    // A path inside a file can't be written on any system.
    const notAFolder = path.join(dir, 'source.har', 'x.har');
    await expect(backend.exportHar(notAFolder, ids)).rejects.toThrow(/ENOTDIR|ENOENT/);

    // Still running, and nothing is left behind.
    await expect(backend.exportHar(path.join(dir, 'gone.har'), ['no-such-id'])).rejects.toThrow(
      'None of those requests',
    );
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await backend.exportHar(path.join(dir, 'ok.har'), ids)).toEqual({ count: 3 });
    api.close();
  });

  it('says how many older requests made room, and stops when the list is cleared', async () => {
    const { backend } = await start('room');
    const entries = (n: number, body = ''): string =>
      JSON.stringify({
        log: {
          entries: Array.from({ length: n }, (_, i) => ({
            startedDateTime: '2026-10-26T12:00:00.000Z',
            request: { method: 'GET', url: `https://example.com/${i}` },
            response: { status: 200, content: body ? { text: body } : {} },
          })),
        },
      });
    const file = path.join(dir, 'many.har');
    await writeFile(file, entries(6000));
    expect((await backend.importHar(file)).removed).toBe(0);
    expect(await backend.importHar(file)).toMatchObject({ imported: 6000, removed: 2000 });

    // Clear while an import is storing bodies: the clear works and the import stops.
    await writeFile(file, entries(300, 'y'.repeat(100_000)));
    const api = await apiClient(backend.apiPort);
    const importing = backend.importHar(file);
    const cleared = api.send({ command: 'clear' });
    await expect(importing).rejects.toThrow('the list was cleared');
    await expect(cleared).resolves.toBeUndefined();
    api.close();
    // A fresh client sees an empty list: in its first message, and in the backend's store.
    const after = await apiClient(backend.apiPort);
    const hello = after.messages[0] as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.type).toBe('hello');
    expect(hello.exchanges).toEqual([]);
    expect(exchangesIn(after.messages)).toEqual([]);
    after.close();
  });

  it('imports WebSocket messages, and exports them again', async () => {
    const { backend } = await start('websocket');
    const startedAt = Date.parse('2026-10-26T12:00:00.000Z');
    const file = path.join(dir, 'ws.har');
    await writeFile(
      file,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: new Date(startedAt).toISOString(),
              _resourceType: 'websocket',
              request: { method: 'GET', url: 'wss://example.com/socket' },
              response: { status: 101, statusText: 'Switching Protocols' },
              _webSocketMessages: [
                { type: 'send', time: startedAt / 1000 + 0.5, opcode: 1, data: 'hello' },
                { type: 'receive', time: startedAt / 1000 + 1, opcode: 2, data: BINARY.toString('base64') },
                { type: 'receive', time: startedAt / 1000 + 2, opcode: 9, data: '' },
              ],
            },
          ],
        },
      }),
    );
    await backend.importHar(file);
    const api = await apiClient(backend.apiPort);
    await expect.poll(() => exchangesIn(api.messages).length).toBe(1);
    const [socket] = exchangesIn(api.messages);
    expect(socket).toMatchObject({ websocket: true, messageCount: 2, status: 101 });
    const { messages } = await api.send<WebSocketMessages>({
      command: 'getWebSocketMessages',
      exchangeId: socket!.id,
    });
    expect(messages.map((m) => [m.fromClient, m.isBinary, m.time])).toEqual([
      [true, false, 500],
      [false, true, 1000],
    ]);
    expect(Buffer.from(messages[1]!.base64, 'base64').equals(BINARY)).toBe(true);

    const out = path.join(dir, 'ws-again.har');
    await backend.exportHar(out, [socket!.id]);
    const [entry] = JSON.parse(await readFile(out, 'utf8')).log.entries;
    expect(entry._webSocketMessages).toEqual([
      { type: 'send', time: startedAt / 1000 + 0.5, opcode: 1, data: 'hello' },
      { type: 'receive', time: startedAt / 1000 + 1, opcode: 2, data: BINARY.toString('base64') },
    ]);
    api.close();
  });
});

describe('parseHar', () => {
  const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    startedDateTime: '2026-10-26T12:00:00.000Z',
    time: 120,
    request: {
      method: 'post',
      url: 'https://api.example.com/v1/items?page=2',
      httpVersion: 'h2',
      headers: [
        { name: ':authority', value: 'api.example.com' },
        { name: 'content-type', value: 'application/json' },
      ],
      postData: { mimeType: 'application/json', text: '{"a":1}' },
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
      content: { size: 2, mimeType: 'application/json; charset=utf-8', text: 'e30=', encoding: 'base64' },
    },
    timings: { send: 1, wait: 100, receive: 19 },
    ...overrides,
  });
  const har = (entries: unknown[]): string => JSON.stringify({ log: { version: '1.2', entries } });

  it('keeps the device a request came from, and ignores a malformed one', async () => {
    const pixel = { kind: 'android', id: 'serial-123', label: 'Pixel 8' };
    const [kept] = (await parseHar(har([entry({ _wirescrySource: pixel })]), 10)).exchanges;
    expect(kept!.summary.source).toEqual(pixel);
    for (const bad of [
      'Pixel 8',
      { kind: 'ios', id: 'x', label: 'y' },
      { kind: 'android', id: '', label: 'y' },
      { kind: 'android', id: 'x', label: 'y'.repeat(101) },
      { kind: 'android', id: 7, label: 'y' },
      null,
    ]) {
      const [e] = (await parseHar(har([entry({ _wirescrySource: bad })]), 10)).exchanges;
      expect(e!.summary.source, JSON.stringify(bad)).toBeUndefined();
    }
    // Only the known fields are kept.
    const [extra] = (await parseHar(har([entry({ _wirescrySource: { ...pixel, secret: 'x' } })]), 10))
      .exchanges;
    expect(extra!.summary.source).toEqual(pixel);
  });

  it("reads a browser's entry", async () => {
    const { exchanges, skipped } = await parseHar(har([entry()]), 100);
    expect(skipped).toBe(0);
    const [e] = exchanges;
    expect(e!.summary).toMatchObject({
      method: 'POST',
      protocol: 'https',
      httpVersion: '2.0',
      host: 'api.example.com',
      path: '/v1/items?page=2',
      status: 200,
      contentType: 'application/json',
      durationMs: 120,
      startedAt: Date.parse('2026-10-26T12:00:00.000Z'),
    });
    expect(e!.requestBody?.toString()).toBe('{"a":1}');
    expect(e!.responseBody?.toString()).toBe('{}');
    expect(e!.timing).toEqual({
      startTimestamp: 0,
      bodyReceivedTimestamp: 1,
      headersSentTimestamp: 101,
      responseSentTimestamp: 120,
    });
  });

  it('skips bad entries, and says why for the first few', async () => {
    const bad = [
      entry({ request: { method: 'GET' } }),
      entry({ request: { method: 'GET', url: 'ftp://example.com/' } }),
      entry({ startedDateTime: 'yesterday' }),
      entry({ request: { method: 'G E T', url: 'https://example.com/' } }),
      { nonsense: true },
      entry({ response: { status: 200, content: { text: '!!!', encoding: 'base64' } } }),
    ];
    const result = await parseHar(har([entry(), ...bad]), 100);
    expect(result.exchanges).toHaveLength(1);
    expect(result.skipped).toBe(6);
    expect(result.problems).toHaveLength(5);
    expect(result.problems[0]).toMatch(/^Entry 2: no valid URL/);
  });

  it('keeps failures, and a request with no response', async () => {
    const failed = entry({
      response: { status: 0, headers: [], content: { size: 0 } },
      _error: 'net::ERR_CONNECTION_REFUSED',
    });
    const [e] = (await parseHar(har([failed]), 10)).exchanges;
    expect(e!.summary.status).toBeUndefined();
    expect(e!.responseHeaders).toBeUndefined();
    expect(e!.summary.failure).toEqual({
      kind: 'other',
      code: 'IMPORTED',
      message: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  it('stops at the most the list can hold', async () => {
    const result = await parseHar(har([entry(), entry(), entry()]), 2);
    expect(result.exchanges).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.problems).toEqual(['Only the first 2 entries were imported.']);
  });

  it("refuses what isn't HAR", async () => {
    await expect(parseHar('[]', 10)).rejects.toThrow('no log.entries');
    await expect(parseHar('{"log":{"pages":[]}}', 10)).rejects.toThrow('no log.entries');
    await expect(parseHar('{', 10)).rejects.toThrow("isn't valid JSON");
    await expect(parseHar('{"log":{"entries":[{}]}} trailing', 10)).rejects.toThrow("isn't valid JSON");
    await expect(parseHar('{"log":{"entries":[{"a":"b]}', 10)).rejects.toThrow("isn't valid JSON");
  });

  it('reads what browsers write: status 0, full timings, form params, sizes', async () => {
    const result = await parseHar(
      har([
        entry({ response: { status: 0, headers: [], content: { size: 0 } } }),
        entry({
          timings: { blocked: 100, dns: 20, connect: 30, ssl: 10, send: 1, wait: 100, receive: 19 },
          time: 270,
        }),
        entry({
          request: {
            method: 'POST',
            url: 'https://example.com/form',
            postData: {
              mimeType: 'application/x-www-form-urlencoded',
              params: [{ name: 'a b', value: '1&2' }],
            },
          },
          response: {
            status: 200,
            bodySize: 40,
            content: { size: 100, mimeType: 'x'.repeat(5_000_000), text: 'hi' },
          },
        }),
        entry({ request: { method: 'GET', url: 'data:text/plain,hi' } }),
        entry({ request: { method: 'GET', url: 'blob:https://example.com/1' } }),
        entry({ time: 1e308, timings: { send: 1e308 } }),
        entry({ response: { status: 200, content: { text: '_-8', encoding: 'base64' } } }),
      ]),
      100,
    );
    expect(result.skipped).toBe(0); // data: and blob: entries are left out quietly.
    const [canceled, timed, form, huge, urlSafe] = result.exchanges;
    expect(result.exchanges).toHaveLength(5);
    expect(canceled!.summary.failure).toEqual({
      kind: 'other',
      code: 'IMPORTED',
      message: 'No response in the HAR file',
    });
    expect(timed!.timing).toEqual({
      startTimestamp: 0,
      bodyReceivedTimestamp: 151,
      headersSentTimestamp: 251,
      responseSentTimestamp: 270,
    });
    expect(form!.requestBody?.toString()).toBe('a+b=1%262');
    expect(form!.summary.responseSize).toBe(40);
    expect(form!.summary.contentType).toBeUndefined();
    expect(Number.isFinite(huge!.timing.responseSentTimestamp)).toBe(true);
    expect(Number.isFinite(huge!.summary.durationMs)).toBe(true);
    expect([...urlSafe!.responseBody!]).toEqual([...Buffer.from('_-8', 'base64url')]);
  });

  it('skips an entry too large to read, and accepts a byte order mark', async () => {
    const big = `{"_x":[${'{},'.repeat(1_000_001)}{}]}`;
    const text = `\ufeff{"log":{"entries":[${big},${JSON.stringify(entry())}]}}`;
    const result = await parseHar(text, 10);
    expect(result.exchanges).toHaveLength(1);
    expect(result.problems).toEqual(['Entry 1: too large to read.']);
  });

  it('keeps going past a very large file of empty entries', async () => {
    const text = `{"log":{"entries":[${'{},'.repeat(200_000)}{}]}}`;
    const result = await parseHar(text, 10);
    expect(result.exchanges).toEqual([]);
    expect(result.skipped).toBe(200_001);
    expect(result.problems.at(-1)).toBe('After 100,000 unreadable entries, the rest were skipped.');
  });
});

describe('harEntry', () => {
  const detail = (overrides: Partial<ExchangeDetail> = {}): ExchangeDetail => ({
    summary: {
      id: 'a',
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'example.com',
      path: '/',
      url: 'https://example.com/',
      startedAt: 0,
      status: 200,
    },
    requestHeaders: [],
    responseHeaders: [['content-encoding', 'gzip']],
    timing: { startTimestamp: 0 },
    ...overrides,
  });
  const body = (text: string, extra: Partial<BodyContent> = {}): BodyContent => ({
    base64: Buffer.from(text).toString('base64'),
    size: text.length,
    truncated: false,
    ...extra,
  });

  it('writes the device a request came from, and nothing for this computer', () => {
    const source = { kind: 'android' as const, id: 'serial-123', label: 'Pixel 8' };
    const fromPhone = harEntry({
      detail: detail({ summary: { ...detail().summary, source } }),
      requestBody: null,
      responseBody: null,
    });
    expect(fromPhone._wirescrySource).toEqual(source);
    expect(
      harEntry({ detail: detail(), requestBody: null, responseBody: null })._wirescrySource,
    ).toBeUndefined();
  });

  it("lists a form's fields as postData.params, as browsers do", () => {
    const form =
      'grant_type=authorization_code&code=abc%2F123&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&scope=a+b&empty=';
    const entry = harEntry({
      detail: detail({
        requestHeaders: [['content-type', 'application/x-www-form-urlencoded; charset=UTF-8']],
        requestBody: { size: form.length, stored: form.length },
      }),
      requestBody: body(form),
      responseBody: null,
    });
    expect((entry.request as { postData: unknown }).postData).toEqual({
      mimeType: 'application/x-www-form-urlencoded; charset=UTF-8',
      text: form,
      params: [
        { name: 'grant_type', value: 'authorization_code' },
        { name: 'code', value: 'abc/123' },
        { name: 'redirect_uri', value: 'https://app.test/cb' },
        { name: 'scope', value: 'a b' },
        { name: 'empty', value: '' },
      ],
    });

    // Other bodies, and a form that isn't text, keep only text.
    const json = harEntry({
      detail: detail({
        requestHeaders: [['content-type', 'application/json']],
        requestBody: { size: 2, stored: 2 },
      }),
      requestBody: body('{}'),
      responseBody: null,
    });
    expect((json.request as { postData: Record<string, unknown> }).postData.params).toBeUndefined();
    const binary = harEntry({
      detail: detail({
        requestHeaders: [['content-type', 'application/x-www-form-urlencoded']],
        requestBody: { size: 2, stored: 2 },
      }),
      requestBody: { base64: Buffer.from([0, 255]).toString('base64'), size: 2, truncated: false },
      responseBody: null,
    });
    expect((binary.request as { postData: Record<string, unknown> }).postData.params).toBeUndefined();
  });

  it('says when a body is cut short or still encoded', () => {
    const cut = harEntry({
      detail: detail({ responseHeaders: [], responseBody: { size: 200, stored: 3 } }),
      requestBody: null,
      responseBody: body('abc', { size: 200, truncated: true }),
    });
    expect((cut.response as { content: { size: number } }).content.size).toBe(200);
    expect(cut.comment).toMatch(/only part of the response body/);

    const undecoded = harEntry({
      detail: detail({ responseBody: { size: 3, stored: 3 } }),
      requestBody: null,
      responseBody: body('abc', { encoding: 'gzip', decodeError: 'bad gzip' }),
    });
    expect(undecoded._wirescryUndecoded).toEqual(['response body']);
    expect((undecoded.response as { content: Record<string, unknown> }).content.compression).toBeUndefined();
    expect(undecoded.comment).toMatch(/couldn't be decoded/);
  });

  it('notes WebSocket messages that were dropped or cut', () => {
    const entry = harEntry({
      detail: detail({ summary: { ...detail().summary, websocket: true } }),
      requestBody: null,
      responseBody: null,
      messages: {
        messages: [{ index: 3, fromClient: true, isBinary: true, time: 0, size: 100_000, base64: 'AAAA' }],
        dropped: 3,
        total: 4,
      },
    });
    expect(entry._wirescryDroppedMessages).toBe(3);
    expect(entry.comment).toMatch(/first 3 WebSocket messages/);
    expect(entry.comment).toMatch(/1 WebSocket messages were cut/);
  });
});
