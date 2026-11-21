/**
 * The MCP server's listener (src/backend/mcp/http.ts): what a request must be before the SDK sees
 * it, and serving both protocol eras. With a stand-in reader.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hasToken, isOwnHost, MAX_BODY, McpHttpServer, type Activity } from '../src/backend/mcp/http';
import { Reader, type ReaderBackend } from '../src/backend/mcp/reader';

const TOKEN = 'A'.repeat(42) + 'b';
const OTHER = 'C'.repeat(42) + 'd';

const backend: ReaderBackend = {
  summaries: () => [
    {
      id: 'a',
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'h.test',
      path: '/x',
      url: 'https://h.test/x',
      startedAt: 0,
    },
  ],
  detail: () => undefined,
  maskFields: async (fields) => ({ fields: fields.map((f) => f.value) }),
  part: () => ({}),
  body: async () => null,
  wsPage: () => ({ messages: [], dropped: 0, total: 0 }),
  maskMessages: async (_d, page) => page,
  sseRead: async () => null,
  maskEvents: async (_d, view) => view,
  generation: () => 1,
};

const servers: McpHttpServer[] = [];
let calls: Activity[] = [];
async function started(token = TOKEN): Promise<{ server: McpHttpServer; port: number }> {
  calls = [];
  const server = new McpHttpServer({
    reader: new Reader(backend),
    log: () => undefined,
    onCall: (c) => calls.push(c),
  });
  servers.push(server);
  await server.start(0, token);
  return { server, port: server.listening! };
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};
const listCall = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'list_exchanges', arguments: {}, _meta: META },
};
const modern = {
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': 'tools/call',
  'mcp-name': 'list_exchanges',
};

/** A raw HTTP/1.1 request, so Host and Origin can be anything. */
function raw(port: number, lines: string[], body = ''): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        [...lines, `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body].join('\r\n'),
      );
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString('utf8')));
    socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), text: data }));
    socket.on('error', reject);
  });
}

function post(
  port: number,
  opts: {
    host?: string;
    origin?: string;
    token?: string | null;
    path?: string;
    headers?: Record<string, string>;
    body?: unknown;
    method?: string;
  } = {},
) {
  const body =
    opts.body === undefined
      ? JSON.stringify(listCall)
      : typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...modern,
    ...opts.headers,
  };
  return raw(
    port,
    [
      `${opts.method ?? 'POST'} ${opts.path ?? '/mcp'} HTTP/1.1`,
      `Host: ${opts.host ?? `127.0.0.1:${port}`}`,
      ...(opts.origin !== undefined ? [`Origin: ${opts.origin}`] : []),
      ...(opts.token === null ? [] : [`Authorization: Bearer ${opts.token ?? TOKEN}`]),
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ],
    opts.method && opts.method !== 'POST' ? '' : body,
  );
}

describe('hasToken and isOwnHost', () => {
  it('takes the right token only, as a Bearer header', () => {
    expect(hasToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(hasToken(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(hasToken(`Bearer ${OTHER}`, TOKEN)).toBe(false);
    expect(hasToken(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(hasToken(TOKEN, TOKEN)).toBe(false);
    expect(hasToken(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(hasToken(`Bearer  ${TOKEN}`, TOKEN)).toBe(false);
    expect(hasToken(undefined, TOKEN)).toBe(false);
    expect(hasToken('Bearer ', '')).toBe(false);
  });

  it('takes only this server’s names, on its port', () => {
    expect(isOwnHost('127.0.0.1:45450', 45450)).toBe(true);
    expect(isOwnHost('LOCALHOST:45450', 45450)).toBe(true);
    expect(isOwnHost('127.0.0.1:45451', 45450)).toBe(false);
    expect(isOwnHost('127.0.0.1', 45450)).toBe(false);
    expect(isOwnHost('evil.test:45450', 45450)).toBe(false);
    expect(isOwnHost('127.0.0.1.evil.test:45450', 45450)).toBe(false);
    expect(isOwnHost('[::1]:45450', 45450)).toBe(false);
    expect(isOwnHost(undefined, 45450)).toBe(false);
  });
});

describe('the listener', () => {
  it('serves a 2026-07-28 client that sends the token', async () => {
    const { port } = await started();
    const res = await post(port);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Captured network traffic follows');
    expect(res.text).toContain('https://h.test/x');
    expect(calls.map((c) => [c.tool, c.ok])).toEqual([['list_exchanges', true]]);
  });

  it('serves a 2025-11-25 client: initialize, then a call', async () => {
    const { port } = await started();
    const init = await post(port, {
      headers: { 'mcp-method': '', 'mcp-name': '', 'mcp-protocol-version': '2025-11-25' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      },
    });
    expect(init.status).toBe(200);
    expect(init.text).toContain('"serverInfo"');
    const call = await post(port, {
      headers: { 'mcp-method': '', 'mcp-name': '', 'mcp-protocol-version': '2025-11-25' },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_exchanges', arguments: {} },
      },
    });
    expect(call.status).toBe(200);
    expect(call.text).toContain('h.test');
  });

  it('refuses a Host that isn’t this server: DNS rebinding', async () => {
    const { port } = await started();
    for (const host of ['evil.test', `evil.test:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
      const res = await post(port, { host });
      expect(res.status, host).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('refuses any request from a browser page, even one on this computer', async () => {
    const { port } = await started();
    for (const origin of ['https://evil.test', `http://127.0.0.1:${port}`, 'http://localhost:3000', 'null']) {
      expect((await post(port, { origin })).status, origin).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a request without the right token', async () => {
    const { port } = await started();
    expect((await post(port, { token: null })).status).toBe(401);
    const wrong = await post(port, { token: OTHER });
    expect(wrong.status).toBe(401);
    expect(wrong.text.toLowerCase()).toContain('www-authenticate: bearer');
    expect(calls).toEqual([]);
  });

  it('answers only POST on /mcp', async () => {
    const { port } = await started();
    expect((await post(port, { path: '/' })).status).toBe(404);
    expect((await post(port, { path: '/mcp/x' })).status).toBe(404);
    for (const method of ['GET', 'DELETE', 'OPTIONS', 'PUT']) {
      expect((await post(port, { method })).status, method).toBe(405);
    }
  });

  it('refuses a body over 1 MiB, and a subscription stream', async () => {
    const { port } = await started();
    const big = JSON.stringify({
      ...listCall,
      params: { ...listCall.params, arguments: { query: 'x'.repeat(MAX_BODY) } },
    });
    expect((await post(port, { body: big })).status).toBe(413);
    const listen = await post(port, {
      headers: { 'mcp-method': 'subscriptions/listen', 'mcp-name': '' },
      body: { jsonrpc: '2.0', id: 3, method: 'subscriptions/listen', params: { _meta: META } },
    });
    expect(listen.status).toBe(404);
  });

  it('listens on 127.0.0.1 only', async () => {
    const { port } = await started();
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: '::1' }, () => {
        s.destroy();
        resolve(false);
      });
      s.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('stops taking the old token once restarted with a new one, and stops entirely when stopped', async () => {
    const { server, port } = await started();
    expect((await post(port)).status).toBe(200);
    await server.start(port, OTHER);
    expect((await post(port)).status).toBe(401);
    expect((await post(port, { token: OTHER })).status).toBe(200);
    await server.stop();
    expect(server.listening).toBeUndefined();
    await expect(post(port, { token: OTHER })).rejects.toThrow();
  });

  it('fails to start on a port that’s taken, and tries no other', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as net.AddressInfo).port;
    const server = new McpHttpServer({
      reader: new Reader(backend),
      log: () => undefined,
      onCall: () => undefined,
    });
    servers.push(server);
    await expect(server.start(port, TOKEN)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(server.listening).toBeUndefined();
    holder.close();
  });
});
