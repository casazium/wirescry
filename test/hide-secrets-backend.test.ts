/**
 * View › Hide Secrets in the backend, end to end: real traffic through a real backend, bodies
 * asked for masked (getBody and formatBody with `mask`), and searched for the secrets.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import type { BodyContent, FormattedBody, SseEventsView, WebSocketMessages } from '../src/shared/api';
import {
  apiClient,
  exchangesIn,
  requestViaProxy,
  TOKEN,
  UI_ORIGIN,
  startUpstreamOnPickedPort,
} from './helpers';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const PASSWORD = 'hunter2' + 'Correct9Horse';

const bytesOf = (body: BodyContent): Buffer => Buffer.from(body.base64, 'base64');

describe('Hide Secrets: bodies masked by the backend', () => {
  let dir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;
  let api: Awaited<ReturnType<typeof apiClient>>;
  const ids: Record<string, string> = {};
  let ca: string;

  /** The traffic, captured once, by the first test (expect.poll runs only in tests). */
  let captured: Promise<void> | undefined;
  const ready = (): Promise<void> => (captured ??= capture());
  const capture = async (): Promise<void> => {
    api = await apiClient(backend.apiPort);
    const base = `https://localhost:${upstream.port}`;
    await requestViaProxy(backend.proxyPort, `${base}/json`, ca, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    ids.json = await api.completed('/json');
    for (const name of [
      'echo',
      'blob',
      'png',
      'broken',
      'app.js',
      'broken.js',
      'utf16',
      'many.xml',
      'events',
      'pairs',
    ]) {
      await requestViaProxy(backend.proxyPort, `${base}/${name}`, ca);
      ids[name] = await api.completed(`/${name}`);
    }
    await requestViaProxy(backend.proxyPort, `${base}/login`, ca, {
      method: 'POST',
      body: `user=ada&password=${PASSWORD}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    ids.login = await api.completed('/login');
    // A WebSocket, imported: text frames with secrets, a binary one holding a known value, one without.
    const t = Date.parse('2026-11-20T12:00:00.000Z') / 1000;
    const file = path.join(dir, 'ws.har');
    await writeFile(
      file,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: new Date(t * 1000).toISOString(),
              _resourceType: 'websocket',
              request: {
                method: 'GET',
                url: 'wss://example.com/socket',
                headers: [{ name: 'Authorization', value: `Bearer ${PASSWORD}` }],
              },
              response: { status: 101, statusText: 'Switching Protocols' },
              _webSocketMessages: [
                { type: 'send', time: t, opcode: 1, data: JSON.stringify({ token: ACCESS }) },
                { type: 'receive', time: t + 1, opcode: 1, data: `welcome ${PASSWORD}` },
                {
                  type: 'receive',
                  time: t + 2,
                  opcode: 2,
                  data: Buffer.concat([Buffer.from([7, 0]), Buffer.from(PASSWORD)]).toString('base64'),
                },
                { type: 'receive', time: t + 3, opcode: 2, data: Buffer.from([1, 2, 3]).toString('base64') },
                { type: 'receive', time: t + 4, opcode: 1, data: 'ping' },
              ],
            },
          ],
        },
      }),
    );
    await backend.importHar(file);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.imported).length).toBe(1);
    ids.ws = exchangesIn(api.messages).find((e) => e.imported)!.id;
    // Another, read only from partway: a token in its first message, plain in its second.
    const late = path.join(dir, 'ws-late.har');
    await writeFile(
      late,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: new Date(t * 1000).toISOString(),
              _resourceType: 'websocket',
              request: { method: 'GET', url: 'wss://example.com/late', headers: [] },
              response: { status: 101, statusText: 'Switching Protocols' },
              _webSocketMessages: [
                { type: 'receive', time: t, opcode: 1, data: JSON.stringify({ token: ACCESS }) },
                { type: 'receive', time: t + 1, opcode: 1, data: `again ${ACCESS}` },
              ],
            },
          ],
        },
      }),
    );
    await backend.importHar(late);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.imported).length).toBe(2);
    ids.wsLate = exchangesIn(api.messages).find((e) => e.imported && e.id !== ids.ws)!.id;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-hide-secrets-'));
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await startUpstreamOnPickedPort(upstream);
    await upstream.forGet('/json').thenReply(200, JSON.stringify({ access_token: ACCESS, n: 1 }), {
      'content-type': 'application/json',
    });
    // Echoes a value only another request's header held.
    await upstream.forGet('/echo').thenReply(200, `you sent ${BEARER}`, { 'content-type': 'text/plain' });
    await upstream
      .forGet('/blob')
      .thenReply(200, Buffer.concat([Buffer.from([0, 1, 0xff]), Buffer.from(BEARER), Buffer.from([0xfe])]), {
        'content-type': 'application/octet-stream',
      });
    await upstream.forGet('/png').thenReply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2, 3]), {
      'content-type': 'image/png',
    });
    // Says gzip, isn't: can't be decoded, so can't be checked.
    await upstream.forGet('/broken').thenReply(200, `password=${PASSWORD}`, {
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
    });
    // Says gzip, isn't, and is code: not formatted to be shown masked.
    await upstream.forGet('/broken.js').thenReply(200, `var p="${PASSWORD}";`, {
      'content-type': 'application/javascript',
      'content-encoding': 'gzip',
    });
    // More secrets than it will look for again once formatted.
    await upstream
      .forGet('/many.xml')
      .thenReply(
        200,
        `<r>${Array.from({ length: 5_001 }, (_, i) => `<password>v${i}Zq9Xw8Vu7Ts6</password>`).join('')}</r>`,
        { 'content-type': 'application/xml' },
      );
    await upstream
      .forGet('/events')
      .thenReply(
        200,
        `event: login\nid: 7\ndata: {"access_token":"${ACCESS}"}\n\n: seen ${ACCESS}\n\ndata: plain message\n\n`,
        { 'content-type': 'text/event-stream' },
      );
    // ASCII in UTF-16 with no BOM: valid UTF-8 too.
    await upstream.forGet('/utf16').thenReply(200, Buffer.from(`user=bob&password=${PASSWORD}`, 'utf16le'), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    await upstream.forGet('/app.js').thenReply(200, `var c={t:"${BEARER}",n:1};`, {
      'content-type': 'application/javascript',
    });
    // Name/value pairs in the shapes real APIs use, and an ordinary one that must stay readable.
    await upstream.forGet('/pairs').thenReply(
      200,
      JSON.stringify({
        headers: [
          { value: ACCESS, name: 'x-api-key' },
          { Name: 'Authorization', Value: `Bearer ${BEARER}` },
          { name: 'accept', value: 'text/html' },
        ],
        tuples: [['password', PASSWORD]],
      }),
      { 'content-type': 'application/json' },
    );
    await upstream.forPost('/login').thenReply(200, `{"welcome":"${PASSWORD}"}`, {
      'content-type': 'application/json',
    });

    const dataDir = path.join(dir, 'data');
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      app: { version: '9.9.9', releaseDate: new Date().toISOString() },
    });
    ca = (await loadOrCreateCA(dataDir)).cert;
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    await upstream?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (id: string, side: 'request' | 'response', mask = true) =>
    api.send<BodyContent>({ command: 'getBody', exchangeId: id, side, ...(mask ? { mask } : {}) });

  it('masks a secret in JSON, in its text and its bytes', async () => {
    await ready();
    const body = await get(ids.json!, 'response');
    expect(body.masked).toMatchObject({ text: '{"access_token":"[redacted]","n":1}' });
    expect(bytesOf(body).toString()).toBe(`{"access_token":"${'*'.repeat(ACCESS.length)}","n":1}`);
    const masked = body.masked as { ranges: Array<[number, number]> };
    expect(masked.ranges).toEqual([[17, 17 + ACCESS.length]]);
  });

  it('masks name/value pairs in any order and shape, and keeps ordinary ones', async () => {
    await ready();
    const body = await get(ids.pairs!, 'response');
    const text = (body.masked as { text: string }).text;
    const bytes = bytesOf(body).toString();
    for (const secret of [ACCESS, BEARER, PASSWORD]) {
      expect(text).not.toContain(secret);
      expect(bytes).not.toContain(secret);
    }
    expect(text).toContain('{"name":"accept","value":"text/html"}');
    expect(text).toContain('"name":"x-api-key"');
    // The real body is still there for Copy as curl, Save and Compose.
    expect(bytesOf(await get(ids.pairs!, 'response', false)).toString()).toContain(ACCESS);
  });

  it('masks a value another request’s header held', async () => {
    await ready();
    const body = await get(ids.echo!, 'response');
    expect(body.masked).toMatchObject({ text: 'you sent [redacted]' });
    expect(bytesOf(body).toString()).not.toContain(BEARER);
  });

  it('masks a response with what its request body held', async () => {
    await ready();
    const body = await get(ids.login!, 'response');
    expect(body.masked).toMatchObject({ text: '{"welcome":"[redacted]"}' });
    const request = await get(ids.login!, 'request');
    expect(request.masked).toMatchObject({ text: 'user=ada&password=[redacted]' });
  });

  it('hides a body that isn’t text but holds a known value, with no bytes', async () => {
    await ready();
    const body = await get(ids.blob!, 'response');
    expect(body.masked).toHaveProperty('hidden');
    expect(body.base64).toBe('');
  });

  it('shows one that isn’t text and holds none, marked as unchecked', async () => {
    await ready();
    const body = await get(ids.png!, 'response');
    expect(body.masked).toEqual({ ranges: [], binary: true });
    expect(bytesOf(body)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2, 3]));
  });

  it('hides a body it couldn’t decode, and drops the decoding error', async () => {
    await ready();
    const body = await get(ids.broken!, 'response');
    expect(body.masked).toEqual({
      hidden: 'This body couldn’t be decoded, so it can’t be checked for secrets.',
    });
    expect(body.base64).toBe('');
    expect(body.decodeError).toBeUndefined();
    // Without `mask`, as before.
    const raw = await get(ids.broken!, 'response', false);
    expect(raw.decodeError).toBeDefined();
    expect(bytesOf(raw).toString()).toContain(PASSWORD);
  });

  it('gives the real body without `mask`, for Copy as curl, Save and Compose', async () => {
    await ready();
    const body = await get(ids.json!, 'response', false);
    expect(body.masked).toBeUndefined();
    expect(bytesOf(body).toString()).toContain(ACCESS);
  });

  it('refuses to show code formatted when it can’t find every secret again', async () => {
    await ready();
    const masked = await api.send<FormattedBody>({
      command: 'formatBody',
      exchangeId: ids['many.xml']!,
      side: 'response',
      mask: true,
    });
    expect(masked).toEqual({
      ok: false,
      reason: 'some secrets in it couldn’t be found again once formatted',
    });
  });

  it('masks UTF-16 with no BOM, in its bytes', async () => {
    await ready();
    const body = await get(ids.utf16!, 'response');
    expect(bytesOf(body).toString('utf16le')).toBe(`user=bob&password=${'\u2a2a'.repeat(PASSWORD.length)}`);
  });

  it('won’t format a body it couldn’t decode, masked; formats it as before without `mask`', async () => {
    await ready();
    const masked = await api.send<FormattedBody>({
      command: 'formatBody',
      exchangeId: ids['broken.js']!,
      side: 'response',
      mask: true,
    });
    expect(masked).toEqual({
      ok: false,
      reason: 'it couldn’t be decoded, so it can’t be checked for secrets',
    });
    const real = await api.send<FormattedBody>({
      command: 'formatBody',
      exchangeId: ids['broken.js']!,
      side: 'response',
    });
    expect(real.ok).toBe(true);
  });

  it('masks WebSocket messages, binary ones that read as text too, and leaves the rest', async () => {
    await ready();
    const page = await api.send<WebSocketMessages>({
      command: 'getWebSocketMessages',
      exchangeId: ids.ws!,
      mask: true,
    });
    expect(page.messages.map((m) => m.masked)).toEqual([
      { text: '{"token":"[redacted]"}', ranges: [[10, 10 + ACCESS.length]] },
      { text: 'welcome [redacted]', ranges: [[8, 8 + PASSWORD.length]] },
      // Binary, but it reads as text: checked as text.
      { text: `\u0007\u0000[redacted]`, ranges: [[2, 2 + PASSWORD.length]] },
      // Bytes that read as UTF-8: checked as text; nothing in them.
      { text: '\u0001\u0002\u0003', ranges: [] },
      { text: 'ping', ranges: [] },
    ]);
    const all = page.messages.map((m) => Buffer.from(m.base64, 'base64').toString('latin1')).join('\n');
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(PASSWORD);
    // Without `mask`, as before.
    const real = await api.send<WebSocketMessages>({ command: 'getWebSocketMessages', exchangeId: ids.ws! });
    expect(real.messages.every((m) => m.masked === undefined)).toBe(true);
    expect(Buffer.from(real.messages[0]!.base64, 'base64').toString()).toContain(ACCESS);
  });

  it('reads a WebSocket from partway with what its earlier messages taught, though never read before', async () => {
    await ready();
    // Message 0 is {"token":ACCESS}: found by a rule. Read from message 2 on, never from the start:
    // the worker has nothing for this stream, so it's taught the earlier messages first.
    const fresh = await api.send<WebSocketMessages>({
      command: 'getWebSocketMessages',
      exchangeId: ids.wsLate!,
      after: 0,
      mask: true,
    });
    expect(fresh.messages.map((m) => m.masked && 'text' in m.masked && m.masked.text)).toEqual([
      `again [redacted]`,
    ]);
  });

  it('masks an event stream’s data, IDs and comments', async () => {
    await ready();
    const view = await api.send<SseEventsView>({
      command: 'getSseEvents',
      exchangeId: ids.events!,
      after: 0,
      mask: true,
    });
    expect(JSON.stringify(view)).not.toContain(ACCESS);
    expect(view.items).toEqual([
      expect.objectContaining({
        kind: 'event',
        type: 'login',
        id: '7',
        data: '{"access_token":"[redacted]"}',
      }),
      expect.objectContaining({ kind: 'comment', text: 'seen [redacted]' }),
      expect.objectContaining({ kind: 'event', type: 'message', data: 'plain message' }),
    ]);
    const real = await api.send<SseEventsView>({
      command: 'getSseEvents',
      exchangeId: ids.events!,
      after: 0,
    });
    expect(JSON.stringify(real)).toContain(ACCESS);
  });

  // A value another request's header held, found in the code before and after formatting.
  it('formats code and masks it, or formats it as before without `mask`', async () => {
    await ready();
    const masked = await api.send<FormattedBody>({
      command: 'formatBody',
      exchangeId: ids['app.js']!,
      side: 'response',
      mask: true,
    });
    expect(masked.ok).toBe(true);
    expect(masked.ok && masked.text).toContain('[redacted]');
    expect(JSON.stringify(masked)).not.toContain(BEARER);
    const real = await api.send<FormattedBody>({
      command: 'formatBody',
      exchangeId: ids['app.js']!,
      side: 'response',
    });
    expect(real.ok && real.text).toContain(BEARER);
  });
});
