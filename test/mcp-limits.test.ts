/**
 * The MCP server's limit on work (security review 2, F12): a batch can't run many calls under one
 * request's count, and a client that hangs up doesn't free its place while its tool still runs.
 * Calls are counted where the work is (`guarded`, with `CallSlots`), up to MAX_CALLS from every
 * request together; batches are refused before the SDK sees them.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { McpHttpServer } from '../src/backend/mcp/http';
import { Reader, type ReaderBackend } from '../src/backend/mcp/reader';
import { CallSlots, guarded, MAX_CALLS, type PluginToolSource } from '../src/backend/mcp/tools';

const TOKEN = 'A'.repeat(42) + 'b';
const BOM = String.fromCharCode(0xfeff);
const BUSY = 'Wirescry is busy: too many calls at once. Try again in a moment.';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};
const MODERN = {
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': 'tools/call',
  'mcp-name': 'list_exchanges',
};
const LEGACY = { 'mcp-protocol-version': '2025-11-25' };
const ERAS = [
  ['modern', MODERN],
  ['older', LEGACY],
] as const;
const call = (id: number, name = 'list_exchanges', args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args, _meta: META },
});
/** A call as a client of the era these headers name: an older one sends no protocol version in it. */
const callFor = (headers: Record<string, string>, id: number) =>
  headers === LEGACY
    ? { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_exchanges', arguments: {} } }
    : call(id);

/** A stand-in backend whose masking waits on a gate, counting how often it was asked. */
function heldBackend() {
  let asked = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
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
  return { backend, asked: () => asked, openAll: () => open() };
}

const servers: McpHttpServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function start(backend: ReaderBackend, plugins?: PluginToolSource): Promise<number> {
  const server = new McpHttpServer({
    reader: new Reader(backend),
    log: () => undefined,
    onCall: () => undefined,
    plugins,
  });
  servers.push(server);
  await server.start(0, TOKEN);
  return server.listening!;
}

/** The body of an HTTP/1.1 answer, chunked or not. */
function bodyOf(text: string): string {
  const split = text.indexOf('\r\n\r\n');
  const head = text.slice(0, split).toLowerCase();
  const rest = text.slice(split + 4);
  if (!head.includes('transfer-encoding: chunked')) return rest;
  let out = '';
  let left = rest;
  for (;;) {
    const line = left.indexOf('\r\n');
    const size = parseInt(left.slice(0, line), 16);
    if (!size) break;
    out += left.slice(line + 2, line + 2 + size);
    left = left.slice(line + 2 + size + 2);
  }
  return out;
}

/** Opens a connection and sends one request: the socket, and the answer to come. */
function open(port: number, body: string, headers: Record<string, string>) {
  let data = '';
  let settle!: (answer: { status: number; text: string }) => void;
  const answer = new Promise<{ status: number; text: string }>((resolve) => (settle = resolve));
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      [
        'POST /mcp HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${TOKEN}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body,
    );
  });
  const done = () => settle({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), text: data });
  socket.on('data', (chunk) => {
    data += chunk.toString('utf8');
    // An older client's answer is an event stream the SDK keeps open a few seconds after its one
    // event: taken as soon as the event is in, as a client would.
    const split = data.indexOf('\r\n\r\n');
    if (split !== -1 && /content-type: text\/event-stream/i.test(data.slice(0, split))) {
      if (/\ndata: [^\n]*\n\n/.test(bodyOf(data))) {
        done();
        socket.destroy();
      }
    }
  });
  socket.on('close', done);
  socket.on('error', () => undefined);
  return { socket, answer };
}

/** A request's answer: the status, and for a tool call its text and whether it was an error. */
async function ask(
  port: number,
  body: string,
  headers: Record<string, string> = MODERN,
): Promise<{ status: number; body: string; text?: string; isError?: boolean }> {
  const { status, text } = await open(port, body, headers).answer;
  const raw = bodyOf(text);
  // An older client's answer comes as an event stream: its JSON is the data line.
  const json = raw.startsWith('event:')
    ? (raw
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? '')
    : raw;
  try {
    const parsed = JSON.parse(json) as { result?: { content: Array<{ text: string }>; isError?: boolean } };
    return {
      status,
      body: raw,
      text: parsed.result?.content.map((c) => c.text).join(''),
      isError: parsed.result?.isError,
    };
  } catch {
    return { status, body: raw };
  }
}

/** Sends a call and hangs up once its work has started (`started` passes): the tool runs on. */
async function hangUpOnceStarted(
  port: number,
  body: string,
  headers: Record<string, string>,
  started: () => boolean,
): Promise<void> {
  const { socket } = open(port, body, headers);
  await expect.poll(started, { timeout: 10_000 }).toBe(true);
  socket.destroy();
}

/** Runs `fn` with console.error silenced (the busy refusal logs a line). */
async function quietly<T>(fn: () => Promise<T> | T): Promise<T> {
  const error = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = error;
  }
}

describe('CallSlots', () => {
  it('gives out at most its places, and takes them back', async () => {
    const slots = new CallSlots(3);
    await quietly(() =>
      expect([slots.take(), slots.take(), slots.take(), slots.take()]).toEqual([true, true, true, false]),
    );
    expect(slots.running).toBe(3);
    slots.release();
    expect(slots.running).toBe(2);
    expect(slots.take()).toBe(true);
  });

  it('never counts below none', () => {
    const slots = new CallSlots(2);
    slots.release();
    expect(slots.running).toBe(0);
    expect([slots.take(), slots.take()]).toEqual([true, true]);
  });

  it('says once in the log that it started refusing, and again only after a call got a place', () => {
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      const slots = new CallSlots(1);
      slots.take();
      slots.take();
      slots.take();
      expect(lines).toEqual(['[wirescry] MCP: 1 tool calls running, refusing more until one ends']);
      slots.release();
      slots.take();
      slots.take();
      expect(lines).toHaveLength(2);
    } finally {
      console.error = error;
    }
  });

  it('defaults to MAX_CALLS', () => {
    expect(new CallSlots().max).toBe(MAX_CALLS);
    expect(MAX_CALLS).toBe(8);
  });
});

describe('guarded with places', () => {
  it('holds a place while the handler runs, and frees it when it ends, resolved or thrown', async () => {
    const slots = new CallSlots(1);
    let finish!: () => void;
    const held = guarded(
      't',
      () =>
        new Promise(
          (resolve) => (finish = () => resolve({ content: [{ type: 'text' as const, text: 'ok' }] })),
        ),
      slots,
    );
    const first = held({}, {});
    expect(slots.running).toBe(1);
    finish();
    expect(await first).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(slots.running).toBe(0);
    await quietly(() =>
      guarded(
        't',
        async () => {
          throw new Error('x');
        },
        slots,
      )({}, {}),
    );
    expect(slots.running).toBe(0);
  });

  it('refuses a call when every place is taken, without running its handler', async () => {
    const slots = new CallSlots(1);
    expect(slots.take()).toBe(true);
    let ran = false;
    const result = await quietly(() =>
      guarded(
        't',
        async () => {
          ran = true;
          return { content: [] };
        },
        slots,
      )({}, {}),
    );
    expect(ran).toBe(false);
    expect(result).toEqual({ content: [{ type: 'text', text: BUSY }], isError: true });
    // A refused call took nothing.
    expect(slots.running).toBe(1);
  });
});

describe('the listener', () => {
  it.each(ERAS)('refuses every batch from a %s client before any tool runs', async (_era, headers) => {
    const held = heldBackend();
    held.openAll();
    const port = await start(held.backend);
    const bodies = [
      JSON.stringify(Array.from({ length: 100 }, (_, i) => call(i + 1))),
      JSON.stringify([call(1), call(2), call(3)]),
      JSON.stringify([call(1)]),
      '[]',
      `${BOM}${JSON.stringify([call(1), call(2)])}`,
      ` \n\t${JSON.stringify([call(1)])}`,
      `[[${JSON.stringify(call(1))}]]`,
      JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
    ];
    for (const body of bodies) {
      const res = await ask(port, body, headers);
      expect(res.status, body.slice(0, 40)).toBe(400);
      expect(res.body).toContain('batches aren’t served');
    }
    expect(held.asked()).toBe(0);
  });

  it('still passes a single message to the SDK, and text that isn’t JSON, which the SDK refuses', async () => {
    const held = heldBackend();
    held.openAll();
    const port = await start(held.backend);
    const single = await ask(port, JSON.stringify(call(1)));
    expect(single.status).toBe(200);
    expect(single.isError).toBeFalsy();
    expect(held.asked()).toBe(1);
    const notJson = await ask(port, 'not json');
    expect(notJson.status).toBe(400);
    expect(notJson.body).toMatch(/Parse error/i);
    expect(notJson.body).not.toContain('batches');
  });

  // Many calls one after another: room on a slow Windows runner.
  it.each(ERAS)(
    'keeps a %s client’s place held after it hung up, until its work ends',
    { timeout: 60_000 },
    async (_era, headers) => {
      const held = heldBackend();
      const port = await start(held.backend);
      // MAX_CALLS clients, one after another, each hanging up once its call has started.
      for (let i = 0; i < MAX_CALLS; i++) {
        await hangUpOnceStarted(
          port,
          JSON.stringify(callFor(headers, i + 1)),
          headers,
          () => held.asked() === i + 1,
        );
      }
      // Every call after them, from clients that wait, is refused: the work still runs.
      await quietly(async () => {
        for (let i = 0; i < 12; i++) {
          const busy = await ask(port, JSON.stringify(callFor(headers, 100 + i)), headers);
          expect(busy.status).toBe(200);
          expect(busy.isError).toBe(true);
          expect(busy.text).toBe(BUSY);
        }
      });
      expect(held.asked()).toBe(MAX_CALLS);
      // The held work ends: the places free, and a call is served again.
      held.openAll();
      await expect
        .poll(async () => (await ask(port, JSON.stringify(callFor(headers, 200)), headers)).isError, {
          timeout: 10_000,
        })
        .toBeFalsy();
    },
  );

  it('gives arguments that don’t fit no place: with every place taken, the SDK still answers them', async () => {
    const held = heldBackend();
    const port = await start(held.backend);
    for (let i = 0; i < MAX_CALLS; i++) {
      await hangUpOnceStarted(port, JSON.stringify(call(i + 1)), MODERN, () => held.asked() === i + 1);
    }
    await quietly(async () => {
      // Control: a good call now is refused.
      expect((await ask(port, JSON.stringify(call(60)))).text).toBe(BUSY);
      const bad = await ask(port, JSON.stringify(call(61, 'get_exchange', { id: 7 })), {
        ...MODERN,
        'mcp-name': 'get_exchange',
      });
      expect(bad.status).toBe(200);
      expect(bad.isError).toBe(true);
      expect(bad.text).not.toBe(BUSY);
      expect(bad.text).toMatch(/\bid\b/);
    });
    held.openAll();
  });

  it('counts a plugin tool’s calls, held while they run though their clients hung up', async () => {
    const held = heldBackend();
    held.openAll();
    let running = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const plugins = {
      list: () => [
        {
          plugin: 'p',
          name: 'wait_tool',
          title: 'Wait',
          description: 'Waits.',
          inputSchema: { type: 'object' },
          contains: 'traffic',
        },
      ],
      // Ignores the abort, as a slow plugin may: the place is held until it ends.
      call: async () => {
        running += 1;
        await gate;
        return { done: true };
      },
    } as unknown as PluginToolSource;
    const port = await start(held.backend, plugins);
    const waitHeaders = { ...MODERN, 'mcp-name': 'wait_tool' };
    for (let i = 0; i < MAX_CALLS; i++) {
      await hangUpOnceStarted(
        port,
        JSON.stringify(call(i + 1, 'wait_tool')),
        waitHeaders,
        () => running === i + 1,
      );
    }
    await quietly(async () => {
      // The app's own tools share the places.
      expect((await ask(port, JSON.stringify(call(50)))).text).toBe(BUSY);
      expect((await ask(port, JSON.stringify(call(51, 'wait_tool')), waitHeaders)).text).toBe(BUSY);
    });
    expect(running).toBe(MAX_CALLS);
    finish();
    await expect
      .poll(async () => (await ask(port, JSON.stringify(call(52)))).isError, { timeout: 10_000 })
      .toBeFalsy();
  });

  it('still tells a plugin tool to stop when its client hung up', async () => {
    const held = heldBackend();
    held.openAll();
    let aborted = 0;
    let started = 0;
    const plugins = {
      list: () => [
        {
          plugin: 'p',
          name: 'stop_tool',
          title: 'Stop',
          description: 'Stops.',
          inputSchema: { type: 'object' },
          contains: 'traffic',
        },
      ],
      call: (_plugin: string, _name: string, _args: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          started += 1;
          signal.addEventListener('abort', () => {
            aborted += 1;
            reject(new Error('aborted'));
          });
        }),
    } as unknown as PluginToolSource;
    const port = await start(held.backend, plugins);
    await hangUpOnceStarted(
      port,
      JSON.stringify(call(1, 'stop_tool')),
      { ...MODERN, 'mcp-name': 'stop_tool' },
      () => started === 1,
    );
    await expect.poll(() => aborted).toBe(1);
  });
});
