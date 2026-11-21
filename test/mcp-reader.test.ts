/**
 * What the MCP tools read (src/backend/mcp/reader.ts), against a stand-in backend: only allowed
 * fields, always masked, never the originals when masking fails, and streams read from partway
 * taught everything before.
 */
import { describe, expect, it, vi } from 'vitest';
import { Reader, ReadError, type ReaderBackend } from '../src/backend/mcp/reader';
import type { ExchangeDetail, ExchangeSummary, WebSocketMessages } from '../src/shared/api';

const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const mask = (text: string) => text.split(SECRET).join('[redacted]');

const summary = (id: string, more: Partial<ExchangeSummary> = {}): ExchangeSummary => ({
  id,
  method: 'GET',
  protocol: 'https',
  httpVersion: '1.1',
  host: 'api.test',
  path: `/${id}`,
  url: `https://api.test/${id}`,
  startedAt: 0,
  status: 200,
  ...more,
});

function backend(list: ExchangeSummary[], more: Partial<ReaderBackend> = {}): ReaderBackend {
  return {
    summaries: () => list,
    detail: (id) => {
      const s = list.find((e) => e.id === id);
      return s
        ? ({
            summary: s,
            requestHeaders: [['authorization', `Bearer ${SECRET}`]],
            responseHeaders: [['x-echo', SECRET]],
            timing: { startTimestamp: 1, responseSentTimestamp: 5 },
            requestBody: { size: 10, stored: 10 },
            importedFrom: '/Users/someone/secret-file.har',
          } as ExchangeDetail)
        : undefined;
    },
    maskFields: async (fields) => ({ fields: fields.map((f) => mask(f.value)) }),
    part: () => ({}),
    body: async () => null,
    wsPage: () => ({ messages: [], dropped: 0, total: 0 }),
    maskMessages: async (_d, page) => page,
    sseRead: async () => null,
    maskEvents: async (_d, view) => view,
    generation: () => 1,
    ...more,
  };
}

describe('list', () => {
  const list = [
    summary('a', { path: `/a?token=${SECRET}`, url: `https://api.test/a?token=${SECRET}` }),
    summary('b', {
      annotations: [{ plugin: 'pro', label: 'Spec', tone: 'warn', title: SECRET }],
      source: { kind: 'android', id: 'd1', label: 'Ada’s phone' },
      imported: true,
      handledBy: { plugin: 'pro', ruleId: 'r', label: `rule ${SECRET}` },
    }),
    summary('c', { status: 500, statusMessage: `failed ${SECRET}` }),
  ];

  it('gives newest first, only allowed fields, all masked', async () => {
    const out = await new Reader(backend(list)).list(undefined, 50, undefined);
    expect(out.exchanges.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Ada’s phone');
    expect(text).not.toContain('annotations');
    expect(out.exchanges[1]).toMatchObject({
      imported: true,
      fromDevice: true,
      handledByRule: 'rule [redacted]',
    });
    expect(out.exchanges[2]!.url).toBe('https://api.test/a?token=[redacted]');
  });

  it('pages with a cursor, and caps the page size', async () => {
    const r = new Reader(backend(list));
    const first = await r.list(undefined, 2, undefined);
    expect(first.exchanges.map((e) => e.id)).toEqual(['c', 'b']);
    expect(first.nextCursor).toBe('b');
    const second = await r.list(undefined, 2, first.nextCursor);
    expect(second.exchanges.map((e) => e.id)).toEqual(['a']);
    expect(second.nextCursor).toBeUndefined();
    await expect(r.list(undefined, 2, 'gone')).rejects.toBeInstanceOf(ReadError);
    const many = Array.from({ length: 300 }, (_, i) => summary(`x${i}`));
    expect((await new Reader(backend(many)).list(undefined, 1000, undefined)).exchanges).toHaveLength(200);
  });

  it('refuses header and body terms, in every form', async () => {
    const r = new Reader(backend(list));
    for (const q of [
      'header~authorization',
      `reqheader.authorization~${SECRET}`,
      'resheader.x-echo=*',
      `header.authorization!=x`,
      `body~${SECRET}`,
      `-body~${SECRET}`,
      `"reqbody~${SECRET}"`,
      `method=GET resbody~${SECRET}`,
    ]) {
      await expect(r.list(q, 50, undefined), q).rejects.toThrow(/Header and body terms/);
    }
  });

  it('takes plain words that only look like those terms, matched over what’s masked', async () => {
    const r = new Reader(backend(list));
    expect((await r.list(`header:${SECRET}`, 50, undefined)).exchanges).toEqual([]);
  });

  it('refuses a query with errors, or too long', async () => {
    const r = new Reader(backend(list));
    await expect(r.list('status>abc', 50, undefined)).rejects.toBeInstanceOf(ReadError);
    await expect(r.list('x'.repeat(5000), 50, undefined)).rejects.toThrow(/longer than/);
  });

  it('matches what the agent sees, masked: a secret’s value finds nothing', async () => {
    const r = new Reader(backend(list));
    expect((await r.list(`path~${SECRET.slice(0, 10)}`, 50, undefined)).exchanges).toEqual([]);
    expect((await r.list(SECRET, 50, undefined)).exchanges).toEqual([]);
    expect((await r.list('path~redacted', 50, undefined)).exchanges.map((e) => e.id)).toEqual(['a']);
    expect((await r.list('status>=500', 50, undefined)).exchanges.map((e) => e.id)).toEqual(['c']);
  });

  it('never gives the originals when masking fails', async () => {
    for (const maskFields of [
      async () => ({ failed: 'Couldn’t check this body for secrets.' }),
      async () => {
        throw new Error(SECRET);
      },
      async () => ({ fields: ['too', 'few'] }),
      async () => ({ fields: Array.from({ length: 999 }, () => 1 as unknown as string) }),
    ]) {
      const r = new Reader(backend(list, { maskFields: maskFields as ReaderBackend['maskFields'] }));
      const error = await r.list(undefined, 50, undefined).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ReadError);
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
  });
});

describe('get', () => {
  it('gives headers masked, the query from the masked URL, and no file path', async () => {
    const list = [summary('a', { url: `https://api.test/a?token=${SECRET}`, imported: true })];
    const out = await new Reader(backend(list)).get('a');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('secret-file');
    expect(out.requestHeaders).toEqual([['authorization', 'Bearer [redacted]']]);
    expect(out.responseHeaders).toEqual([['x-echo', '[redacted]']]);
    expect(out.query).toEqual([['token', '[redacted]']]);
    expect(out.requestBody).toEqual({ size: 10, kept: 10 });
    expect(out.timing).toEqual({ startTimestamp: 1, responseSentTimestamp: 5 });
  });

  it('says so for an exchange that isn’t there', async () => {
    await expect(new Reader(backend([])).get('nope')).rejects.toThrow(/No such exchange/);
  });
});

describe('body', () => {
  const text = 'a'.repeat(30_000) + ' [redacted] ' + 'b'.repeat(10);
  const withBody = (content: unknown) =>
    backend([summary('a')], { body: vi.fn(async () => content as never) });

  it('pages through the masked text, masking it once', async () => {
    const b = withBody({
      base64: '',
      size: 99,
      truncated: false,
      contentType: 'text/plain',
      masked: { text, ranges: [] },
    });
    const r = new Reader(b);
    const first = await r.body('a', 'request', 0, 20_000);
    expect(first).toMatchObject({ kind: 'text', totalChars: text.length, offset: 0, more: true });
    const second = await r.body('a', 'request', 20_000, 20_000);
    expect(second).toMatchObject({ kind: 'text', offset: 20_000 });
    expect(second.kind === 'text' && second.more).toBeFalsy();
    expect(first.kind === 'text' && second.kind === 'text' && first.text + second.text).toBe(text);
    const past = await r.body('a', 'request', 1e9, 10);
    expect(past).toMatchObject({ kind: 'text', text: '' });
    expect(b.body).toHaveBeenCalledTimes(1);
  });

  it('gives a binary body’s size only, a hidden one’s reason, and none', async () => {
    expect(
      await new Reader(
        withBody({ base64: 'AAEC', size: 3, truncated: false, masked: { ranges: [], binary: true } }),
      ).body('a', 'request', 0, 10),
    ).toEqual({ kind: 'binary', size: 3 });
    expect(
      await new Reader(withBody({ base64: '', size: 3, truncated: false, masked: { hidden: 'nope' } })).body(
        'a',
        'request',
        0,
        10,
      ),
    ).toEqual({ kind: 'hidden', reason: 'nope', size: 3 });
    expect(await new Reader(withBody(null)).body('a', 'request', 0, 10)).toEqual({ kind: 'none' });
  });

  it('refuses a body that came back unmasked', async () => {
    const r = new Reader(
      withBody({ base64: Buffer.from(SECRET).toString('base64'), size: 3, truncated: false }),
    );
    await expect(r.body('a', 'request', 0, 10)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('streams read from partway', () => {
  const N = 1_200;
  const all = Array.from({ length: N }, (_, i) => ({
    index: i,
    fromClient: false,
    isBinary: false,
    time: i,
    size: 1,
    base64: 'eA==',
  }));
  const page = (_id: string, after: number, limit: number): WebSocketMessages => ({
    messages: all.filter((m) => m.index > after).slice(0, limit),
    dropped: 0,
    total: N,
  });

  it('teaches every earlier message first, in pages, from the start; then only what’s new', async () => {
    const taught: Array<[number, number, boolean]> = [];
    let generation = 1;
    const b = backend([summary('w', { websocket: true, messageCount: N })], {
      wsPage: page,
      maskMessages: async (_d, p, fresh) => {
        taught.push([p.messages[0]!.index, p.messages.at(-1)!.index, fresh]);
        return p;
      },
      generation: () => generation,
    });
    const r = new Reader(b);
    await r.messages('w', 1_100, 10);
    expect(taught).toEqual([
      [0, 499, true],
      [500, 999, false],
      [1000, 1100, false],
      [1101, 1110, false],
    ]);
    taught.length = 0;
    await r.messages('w', 1_110, 10);
    expect(taught).toEqual([[1111, 1120, false]]);
    // The worker restarted: what it learned is gone, so it's taught again from the start.
    taught.length = 0;
    generation = 2;
    await r.messages('w', 1_150, 5);
    expect(taught[0]).toEqual([0, 499, true]);
    expect(taught.at(-1)).toEqual([1151, 1155, false]);
  });

  it('from the start, teaches nothing extra', async () => {
    const taught: number[] = [];
    const b = backend([summary('w', { websocket: true, messageCount: N })], {
      wsPage: page,
      maskMessages: async (_d, p) => {
        taught.push(p.messages.length);
        return p;
      },
    });
    await new Reader(b).messages('w', -1, 5);
    expect(taught).toEqual([5]);
  });

  it('refuses what isn’t a WebSocket or an event stream', async () => {
    const r = new Reader(backend([summary('a')]));
    await expect(r.messages('a', -1, 5)).rejects.toThrow(/isn’t a WebSocket/);
    await expect(r.events('a', 0)).rejects.toThrow(/isn’t an event stream/);
  });
});
