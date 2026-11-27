/**
 * The MCP listener's connections (security review 2, F13): idle or slow connections that never
 * send the token can't lock agents out. Waiting connections past MAX_WAITING make room by closing
 * the oldest; trusted ones (a request passed the checks) are kept apart, up to MAX_TRUSTED; and a
 * connection that doesn't send a whole request head in time is closed by Node.
 */
import { EventEmitter } from 'node:events';
import net, { type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Connections, MAX_TRUSTED, MAX_WAITING, McpHttpServer } from '../src/backend/mcp/http';
import { Reader, type ReaderBackend } from '../src/backend/mcp/reader';

const TOKEN = 'A'.repeat(42) + 'b';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};
const CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'list_exchanges', arguments: {}, _meta: META },
});

/** A stand-in backend; with `hold`, masking waits until `open` is called. */
function backendFor(hold = false) {
  let open!: () => void;
  const gate = hold ? new Promise<void>((resolve) => (open = resolve)) : Promise.resolve();
  let asked = 0;
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
    maskFields: async (fields) => {
      asked += 1;
      await gate;
      return { fields: fields.map((f) => f.value), full: false };
    },
    part: () => ({}),
    body: async () => null,
    wsPage: () => ({ messages: [], dropped: 0, total: 0 }),
    maskMessages: async (_d, page) => page,
    sseRead: async () => null,
    maskEvents: async (_d, view) => view,
    generation: () => 1,
  };
  return { backend, asked: () => asked, open: () => open?.() };
}

const servers: McpHttpServer[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.stop();
});

// A long deadline unless a test asks: so a close the tests look for comes from eviction, not it.
async function start(
  backend: ReaderBackend,
  options: { headDeadlineMs?: number; checkEveryMs?: number } = { headDeadlineMs: 60_000 },
): Promise<number> {
  const server = new McpHttpServer({
    reader: new Reader(backend),
    log: () => undefined,
    onCall: () => undefined,
    ...options,
  });
  servers.push(server);
  await server.start(0, TOKEN);
  return server.listening!;
}

type Conn = { socket: net.Socket; closed: () => boolean; data: () => string };

/** A connection, open: resolves once the server could have accepted it. */
async function connect(
  port: number,
): Promise<{ socket: net.Socket; closed: () => boolean; data: () => string }> {
  const socket = net.connect(port, '127.0.0.1');
  sockets.push(socket);
  let closed = false;
  let data = '';
  socket.on('close', () => (closed = true));
  socket.on('data', (chunk) => (data += chunk.toString('utf8')));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return { socket, closed: () => closed, data: () => data };
}

/** A request head and body; `keepAlive` leaves the connection open after the answer. */
function request(
  port: number,
  opts: { token?: string; host?: string; origin?: string; keepAlive?: boolean } = {},
) {
  const body = CALL;
  return [
    'POST /mcp HTTP/1.1',
    `Host: ${opts.host ?? `127.0.0.1:${port}`}`,
    `Authorization: Bearer ${opts.token ?? TOKEN}`,
    ...(opts.origin !== undefined ? [`Origin: ${opts.origin}`] : []),
    'Content-Type: application/json',
    'Accept: application/json, text/event-stream',
    'mcp-protocol-version: 2026-07-28',
    'mcp-method: tools/call',
    'mcp-name: list_exchanges',
    `Content-Length: ${Buffer.byteLength(body)}`,
    `Connection: ${opts.keepAlive ? 'keep-alive' : 'close'}`,
    '',
    body,
  ].join('\r\n');
}

/** The status of the next answer on a connection. */
async function nextStatus(c: { data: () => string }, from = 0): Promise<number> {
  await expect
    .poll(() => /HTTP\/1\.1 (\d+)/.exec(c.data().slice(from))?.[1], { timeout: 10_000 })
    .toBeDefined();
  return Number(/HTTP\/1\.1 (\d+)/.exec(c.data().slice(from))![1]);
}

/** A fresh client: connects, sends a call, and gets its status. */
async function callOnce(port: number): Promise<number> {
  const c = await connect(port);
  c.socket.write(request(port));
  return nextStatus(c);
}

describe('Connections', () => {
  /** A socket stand-in whose 'close' comes a moment after destroy(), as a real one's does. */
  const fake = () => {
    const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): void };
    socket.destroyed = false;
    socket.destroy = () => {
      socket.destroyed = true;
      setImmediate(() => socket.emit('close'));
    };
    return socket;
  };

  it('closes a different oldest for each of two connections that come at once', async () => {
    const connections = new Connections();
    const all = Array.from({ length: MAX_WAITING + 2 }, fake);
    // All in one turn: the first one closed hasn't emitted 'close' when the next comes.
    for (const socket of all) connections.opened(socket as unknown as Socket);
    expect(all.filter((s) => s.destroyed)).toEqual([all[0], all[1]]);
    expect(connections.counts.waiting).toBe(MAX_WAITING);
    await new Promise((resolve) => setImmediate(resolve));
    expect(connections.counts.waiting).toBe(MAX_WAITING);
  });

  it('forgets a socket when it closes, in either group', async () => {
    const connections = new Connections();
    const a = fake();
    const b = fake();
    connections.opened(a as unknown as Socket);
    connections.opened(b as unknown as Socket);
    expect(connections.trust(b as unknown as Socket)).toBe(true);
    expect(connections.counts).toEqual({ waiting: 1, trusted: 1 });
    a.emit('close');
    b.emit('close');
    expect(connections.counts).toEqual({ waiting: 0, trusted: 0 });
  });
});

describe('connections that never send the token', () => {
  it('can’t lock a client out: the oldest idle one makes room', async () => {
    const port = await start(backendFor().backend);
    const idle: Conn[] = [];
    for (let i = 0; i < MAX_WAITING; i++) idle.push(await connect(port));
    expect(await callOnce(port)).toBe(200);
    // The client's own connection pushed out the oldest.
    await expect.poll(() => idle[0]!.closed()).toBe(true);
    expect(idle.slice(1).some((c) => c.closed())).toBe(false);
  });

  it('closes the oldest first, however many come', async () => {
    const port = await start(backendFor().backend);
    const idle: Conn[] = [];
    for (let i = 0; i < 40; i++) idle.push(await connect(port));
    await expect.poll(() => idle.filter((c) => c.closed()).length).toBe(40 - MAX_WAITING);
    expect(idle.slice(0, 40 - MAX_WAITING).every((c) => c.closed())).toBe(true);
    expect(idle.slice(40 - MAX_WAITING).some((c) => c.closed())).toBe(false);
    expect(await callOnce(port)).toBe(200);
  });

  it('can’t hold on by sending a head slowly', async () => {
    const port = await start(backendFor().backend);
    const slow: Conn[] = [];
    for (let i = 0; i < MAX_WAITING; i++) {
      const c = await connect(port);
      c.socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      slow.push(c);
    }
    expect(await callOnce(port)).toBe(200);
    await expect.poll(() => slow[0]!.closed()).toBe(true);
  });

  it('can’t hold on with a wrong token, a wrong Host or an Origin, keeping the connection open', async () => {
    const port = await start(backendFor().backend);
    const refused: Conn[] = [];
    for (const [opts, status] of [
      [{ token: 'B'.repeat(43) }, 401],
      [{ host: 'evil.test' }, 403],
      [{ origin: 'https://evil.test' }, 403],
    ] as const) {
      const c = await connect(port);
      c.socket.write(request(port, { ...opts, keepAlive: true }));
      expect(await nextStatus(c)).toBe(status);
      refused.push(c);
    }
    expect(refused.some((c) => c.closed())).toBe(false);
    // Still waiting, not trusted: they go first when room is needed.
    for (let i = 0; i < MAX_WAITING; i++) await connect(port);
    // Soon: well before any keep-alive or head timeout would close them.
    await expect.poll(() => refused.every((c) => c.closed()), { timeout: 3000 }).toBe(true);
  });
});

describe('trusted connections', () => {
  it('are kept when idle connections come, and keep working', async () => {
    const port = await start(backendFor().backend);
    const agent = await connect(port);
    agent.socket.write(request(port, { keepAlive: true }));
    expect(await nextStatus(agent)).toBe(200);
    for (let i = 0; i < 40; i++) await connect(port);
    expect(agent.closed()).toBe(false);
    const before = agent.data().length;
    agent.socket.write(request(port, { keepAlive: true }));
    expect(await nextStatus(agent, before)).toBe(200);
  });

  it(`turn a ${MAX_TRUSTED + 1}th away, and the others keep working`, async () => {
    const port = await start(backendFor().backend);
    const agents: Conn[] = [];
    for (let i = 0; i < MAX_TRUSTED; i++) {
      const c = await connect(port);
      c.socket.write(request(port, { keepAlive: true }));
      expect(await nextStatus(c)).toBe(200);
      agents.push(c);
    }
    expect(agents.some((c) => c.closed())).toBe(false);
    const extra = await connect(port);
    extra.socket.write(request(port, { keepAlive: true }));
    expect(await nextStatus(extra)).toBe(429);
    expect(extra.data()).toContain('Too many connections');
    expect(extra.data().toLowerCase()).toContain('connection: close');
    expect(extra.data().toLowerCase()).toContain('retry-after: 1');
    await expect.poll(() => extra.closed(), { timeout: 3000 }).toBe(true);
    const first = agents[0]!;
    const before = first.data().length;
    first.socket.write(request(port, { keepAlive: true }));
    expect(await nextStatus(first, before)).toBe(200);
  });

  it('are trusted on passing the checks, before the path or method is looked at', async () => {
    const port = await start(backendFor().backend);
    const c = await connect(port);
    c.socket.write(request(port, { keepAlive: true }).replace('POST /mcp', 'GET /mcp'));
    expect(await nextStatus(c)).toBe(405);
    for (let i = 0; i < MAX_WAITING; i++) await connect(port);
    expect(c.closed()).toBe(false);
  });

  it('are all closed, with the waiting ones, when the listener stops', async () => {
    const port = await start(backendFor().backend);
    const agent = await connect(port);
    agent.socket.write(request(port, { keepAlive: true }));
    expect(await nextStatus(agent)).toBe(200);
    const idle = await connect(port);
    await servers.pop()!.stop();
    await expect.poll(() => agent.closed() && idle.closed(), { timeout: 3000 }).toBe(true);
  });

  it('a call held while many idle connections come still answers', async () => {
    const held = backendFor(true);
    const port = await start(held.backend);
    const agent = await connect(port);
    agent.socket.write(request(port));
    await expect.poll(() => held.asked()).toBe(1);
    for (let i = 0; i < 32; i++) await connect(port);
    held.open();
    expect(await nextStatus(agent)).toBe(200);
  });
});

describe('the deadline for a request head', () => {
  it('closes a connection that sends nothing, and one that sends half a head', async () => {
    const port = await start(backendFor().backend, { headDeadlineMs: 200, checkEveryMs: 50 });
    const idle = await connect(port);
    const half = await connect(port);
    half.socket.write('POST /mcp HTTP/1.1\r\n');
    await expect.poll(() => idle.closed(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => half.closed(), { timeout: 5000 }).toBe(true);
  });

  it('leaves one that sent its request in time, even while its call runs past the deadline', async () => {
    const held = backendFor(true);
    const port = await start(held.backend, { headDeadlineMs: 1000, checkEveryMs: 50 });
    const agent = await connect(port);
    agent.socket.write(request(port));
    await expect.poll(() => held.asked()).toBe(1);
    // Past two deadlines.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(agent.closed()).toBe(false);
    held.open();
    expect(await nextStatus(agent)).toBe(200);
  });

  it('applies to a later request on a trusted connection too', async () => {
    const port = await start(backendFor().backend, { headDeadlineMs: 300, checkEveryMs: 50 });
    const agent = await connect(port);
    agent.socket.write(request(port, { keepAlive: true }));
    expect(await nextStatus(agent)).toBe(200);
    agent.socket.write('POST /mcp HTTP/1.1\r\n');
    await expect.poll(() => agent.closed(), { timeout: 5000 }).toBe(true);
  });

  it('is about 5 s by default, checked each second', { timeout: 15_000 }, async () => {
    const port = await start(backendFor().backend, {});
    const idle = await connect(port);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(idle.closed()).toBe(false);
    await expect.poll(() => idle.closed(), { timeout: 3000 }).toBe(true);
  });
});
