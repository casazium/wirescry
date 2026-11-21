/**
 * The MCP server end to end: real traffic through a real backend, the server turned on with
 * setMcp, every tool called over HTTP as a 2026-07-28 client, and every answer searched for the
 * secrets. Also its settings: off by default, the token, reset, port changes, a port in use.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import { loadSettings } from '../src/backend/settings';
import type { McpStatus } from '../src/shared/api';
import { apiClient, exchangesIn, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const KEY = 'ak_' + 'Zx8Wv6Ut4Sr2Qp0n';
const PASSWORD = 'hunter2' + 'Correct9Horse';
const SECRETS = { ACCESS, BEARER, KEY, PASSWORD };

/** Every form a secret could take in an answer: as written, JSON-escaped, percent-encoded. */
function leaked(text: string): string[] {
  return Object.entries(SECRETS)
    .filter(([, s]) =>
      [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)].some((f) => text.includes(f)),
    )
    .map(([name]) => name);
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

describe('the MCP server, end to end', () => {
  let dir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let dataDir: string;
  let status: McpStatus;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-'));
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream.forGet('/api').thenReply(200, JSON.stringify({ access_token: ACCESS, n: 1 }), {
      'content-type': 'application/json',
      'x-echo': BEARER,
    });
    await upstream.forGet(`/user/${BEARER}`).thenReply(200, 'ok', { 'content-type': 'text/plain' });
    await upstream
      .forGet('/events')
      .thenReply(200, `data: {"password":"${PASSWORD}"}\n\n: saw ${BEARER}\n\n`, {
        'content-type': 'text/event-stream',
      });
    dataDir = path.join(dir, 'data');
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      app: { version: '9.9.9', releaseDate: new Date().toISOString() },
    });
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    await upstream?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let captured: Promise<void> | undefined;
  const ready = (): Promise<void> => (captured ??= capture());
  const capture = async (): Promise<void> => {
    api = await apiClient(backend.apiPort);
    const ca = (await loadOrCreateCA(dataDir)).cert;
    const base = `https://localhost:${upstream.port}`;
    await requestViaProxy(backend.proxyPort, `${base}/api?api_key=${KEY}`, ca, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    ids.api = await api.completed(`/api?api_key=${KEY}`);
    await requestViaProxy(backend.proxyPort, `${base}/user/${BEARER}`, ca);
    ids.user = await api.completed(`/user/${BEARER}`);
    await requestViaProxy(backend.proxyPort, `${base}/events`, ca);
    ids.events = await api.completed('/events');
    const t = Date.parse('2026-11-21T12:00:00.000Z') / 1000;
    const file = path.join(dir, 'ws.har');
    await writeFile(
      file,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: new Date(t * 1000).toISOString(),
              _resourceType: 'websocket',
              request: { method: 'GET', url: 'wss://example.com/socket', headers: [] },
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
    await backend.importHar(file);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.imported).length).toBe(1);
    ids.ws = exchangesIn(api.messages).find((e) => e.imported)!.id;
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
                { type: 'receive', time: t + 1, opcode: 1, data: 'nothing here' },
                { type: 'receive', time: t + 2, opcode: 1, data: `later ${ACCESS}` },
              ],
            },
          ],
        },
      }),
    );
    await backend.importHar(late);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.imported).length).toBe(2);
    ids.wsLate = exchangesIn(api.messages).find((e) => e.imported && e.id !== ids.ws)!.id;
    // A long WebSocket (more than the 2,000 a lost stream's replay would cover), with a token found
    // in its first message and bare in its last; and 20 others, to make the worker let it go.
    const long = path.join(dir, 'ws-long.har');
    const many = 2_100;
    const socket = (url: string, messages: Array<{ data: string }>) => ({
      startedDateTime: new Date(t * 1000).toISOString(),
      _resourceType: 'websocket',
      request: { method: 'GET', url, headers: [] },
      response: { status: 101, statusText: 'Switching Protocols' },
      _webSocketMessages: messages.map((m, i) => ({
        type: 'receive',
        time: t + i / 1000,
        opcode: 1,
        data: m.data,
      })),
    });
    await writeFile(
      long,
      JSON.stringify({
        log: {
          entries: [
            socket('wss://example.com/long', [
              { data: JSON.stringify({ token: ACCESS }) },
              ...Array.from({ length: many - 2 }, (_, i) => ({ data: `tick ${i}` })),
              { data: `bare ${ACCESS}` },
            ]),
            ...Array.from({ length: 20 }, (_, i) =>
              socket(`wss://example.com/other${i}`, [{ data: 'hello' }]),
            ),
          ],
        },
      }),
    );
    await backend.importHar(long);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.imported).length).toBe(23);
    const imported = exchangesIn(api.messages).filter((e) => e.imported);
    ids.wsLong = imported.find((e) => e.url.endsWith('/long'))!.id;
    ids.others = imported
      .filter((e) => /\/other\d+$/.test(e.url))
      .map((e) => e.id)
      .join(',');
    status = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port: await freePort() });
  };

  let nextId = 1;
  /** A tool call as a 2026-07-28 client: the answer's text, and whether it was an error. */
  async function call(
    name: string,
    args: Record<string, unknown>,
    token = status.token!,
  ): Promise<{ http: number; text: string; isError?: boolean }> {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const raw = await res.text();
    if (res.status !== 200) return { http: res.status, text: raw };
    const json = JSON.parse(raw) as { result?: { content: Array<{ text: string }>; isError?: boolean } };
    return {
      http: 200,
      text: json.result!.content.map((c) => c.text).join('\n'),
      isError: json.result!.isError,
    };
  }

  it('is off until turned on, then listens with a token kept in the settings', async () => {
    const before = await (await apiClient(backend.apiPort)).send<McpStatus>({ command: 'getMcp' });
    expect(before).toMatchObject({ enabled: false, listening: false, activity: [] });
    await ready();
    expect(status).toMatchObject({ enabled: true, listening: true });
    expect(status.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(status.url).toBe(`http://127.0.0.1:${status.port}/mcp`);
    expect((await loadSettings(dataDir)).mcp).toEqual({
      enabled: true,
      port: status.port,
      token: status.token,
    });
  });

  it('lists captured traffic masked: a value known from a header hidden in a path too', async () => {
    await ready();
    const out = await call('list_exchanges', {});
    expect(out.isError).toBeFalsy();
    expect(leaked(out.text)).toEqual([]);
    expect(out.text).toContain('/user/[redacted]');
    expect(out.text).toContain('api_key=[redacted]');
  });

  it('gives an exchange’s headers masked, an odd header holding a known value too', async () => {
    await ready();
    const out = await call('get_exchange', { id: ids.api });
    expect(leaked(out.text)).toEqual([]);
    expect(out.text).toContain('Bearer [redacted]');
    expect(out.text).toMatch(/"x-echo","\[redacted\]"/);
  });

  it('gives a body masked, a page at a time', async () => {
    await ready();
    const out = await call('get_body', { id: ids.api, side: 'response' });
    expect(leaked(out.text)).toEqual([]);
    expect(out.text).toContain('access_token');
    const page = await call('get_body', { id: ids.api, side: 'response', offset: 5, maxChars: 10 });
    expect(page.text).toContain('"offset":5');
  });

  it('gives WebSocket messages and events masked, from partway too', async () => {
    await ready();
    const all = await call('get_websocket_messages', { id: ids.ws });
    expect(leaked(all.text)).toEqual([]);
    const late = await call('get_websocket_messages', { id: ids.ws, after: 0 });
    expect(leaked(late.text)).toEqual([]);
    expect(late.text).toContain('again [redacted]');
    const events = await call('get_sse_events', { id: ids.events });
    expect(leaked(events.text)).toEqual([]);
    expect(events.text).toContain('[redacted]');
  });

  it('reads a WebSocket first from partway, with what its first message taught', async () => {
    await ready();
    const out = await call('get_websocket_messages', { id: ids.wsLate, after: 1 });
    expect(leaked(out.text)).toEqual([]);
    expect(out.text).toContain('later [redacted]');
  });

  it('teaches a long stream again from the start when the worker let it go, not just its last 2,000', async () => {
    await ready();
    const first = await call('get_websocket_messages', { id: ids.wsLong, after: 2_000, limit: 5 });
    expect(leaked(first.text)).toEqual([]);
    // The window reads 20 other streams, masked: the worker keeps 20, so it lets the agent's go.
    for (const other of ids.others!.split(',')) {
      await api.send({ command: 'getWebSocketMessages', exchangeId: other, mask: true });
    }
    const last = await call('get_websocket_messages', { id: ids.wsLong, after: 2_097 });
    expect(leaked(last.text)).toEqual([]);
    expect(last.text).toContain('bare [redacted]');
  });

  it('refuses header and body terms, and can’t find a secret by searching for it', async () => {
    await ready();
    for (const query of [`body~${ACCESS}`, `header.authorization~${BEARER}`]) {
      const out = await call('list_exchanges', { query });
      expect(out.isError, query).toBe(true);
      expect(leaked(out.text)).toEqual([]);
    }
    const guess = await call('list_exchanges', { query: `path~${BEARER}` });
    expect(guess.text).toContain('"exchanges":[]');
    const found = await call('list_exchanges', { query: 'path~/user/' });
    expect(found.text).toContain(ids.user);
  });

  it('says so for an exchange that isn’t there, with no secret in the error', async () => {
    await ready();
    const out = await call('get_exchange', { id: `x${ACCESS}` });
    expect(out.isError).toBe(true);
    expect(leaked(out.text)).toEqual([]);
  });

  it('keeps an activity list of calls, without what they read', async () => {
    await ready();
    const now = await api.send<McpStatus>({ command: 'getMcp' });
    expect(now.activity.length).toBeGreaterThan(3);
    expect(now.activity.map((a) => a.tool)).toContain('get_body');
    expect(leaked(JSON.stringify(now.activity))).toEqual([]);
  });

  it('stops taking the old token when it’s reset, and moves to a new port', async () => {
    await ready();
    const old = status.token!;
    status = await api.send<McpStatus>({ command: 'setMcp', resetToken: true });
    expect(status.token).not.toBe(old);
    expect((await call('list_exchanges', {}, old)).http).toBe(401);
    expect((await call('list_exchanges', {})).http).toBe(200);
    const oldUrl = status.url;
    status = await api.send<McpStatus>({ command: 'setMcp', port: await freePort() });
    expect(status.url).not.toBe(oldUrl);
    await expect(fetch(oldUrl, { method: 'POST' })).rejects.toThrow();
    expect((await call('list_exchanges', {})).http).toBe(200);
  });

  it('reports a port in use, and refuses a bad port', async () => {
    await ready();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const taken = (holder.address() as net.AddressInfo).port;
    const result = await api.send<McpStatus>({ command: 'setMcp', port: taken });
    expect(result).toMatchObject({
      enabled: true,
      listening: false,
      problem: expect.stringContaining('in use'),
    });
    holder.close();
    await expect(api.send({ command: 'setMcp', port: 80 })).rejects.toThrow(/1024 to 65535/);
    status = await api.send<McpStatus>({ command: 'setMcp', port: await freePort() });
    expect(status.listening).toBe(true);
  });

  it('still changes the token when the settings can’t be saved', async () => {
    if (process.platform === 'win32') return; // Folder permissions work differently there.
    await ready();
    const old = status.token!;
    await chmod(dataDir, 0o500);
    try {
      await expect(api.send({ command: 'setMcp', resetToken: true })).rejects.toThrow();
    } finally {
      await chmod(dataDir, 0o700);
    }
    expect((await call('list_exchanges', {}, old)).http).toBe(401);
    status = await api.send<McpStatus>({ command: 'getMcp' });
    expect((await call('list_exchanges', {})).http).toBe(200);
  });

  it('stops listening when turned off, keeping the token for next time', async () => {
    await ready();
    const off = await api.send<McpStatus>({ command: 'setMcp', enabled: false });
    expect(off).toMatchObject({ enabled: false, listening: false, token: status.token });
    await expect(fetch(status.url, { method: 'POST' })).rejects.toThrow();
    expect((await loadSettings(dataDir)).mcp?.enabled).toBe(false);
  });
});
