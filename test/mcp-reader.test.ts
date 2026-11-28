/**
 * What the MCP tools read (src/backend/mcp/reader.ts), against a stand-in backend: only allowed
 * fields, always masked, never the originals when masking fails, and streams read from partway
 * taught everything before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkTaught, Reader, ReadError, StreamLost, type ReaderBackend } from '../src/backend/mcp/reader';
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
    maskFields: async (fields) => ({ fields: fields.map((f) => mask(f.value)), full: false }),
    part: () => ({}),
    body: async () => null,
    wsPage: () => ({ messages: [], dropped: 0, total: 0 }),
    maskMessages: async (_d, page) => page,
    sseRead: async () => null,
    maskEvents: async (_d, view) => view,
    teachMessages: async () => undefined,
    teachEvents: async () => undefined,
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
      handledByRule: true,
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
      'resheader.x-echo=abc',
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

  it('refuses wildcards with = or !=, which could take minutes to match; takes * and ? otherwise', async () => {
    const r = new Reader(backend(list));
    for (const q of ['url=*a*a*a*b', 'path=/a?', 'host=*.test', '-host!=*.test', 'method=G*']) {
      await expect(r.list(q, 50, undefined), q).rejects.toThrow(/Wildcards/);
    }
    // A ? in a URL is just a character with ~, and in plain words.
    expect((await r.list('path~/a?token', 50, undefined)).exchanges.map((e) => e.id)).toEqual(['a']);
    expect((await r.list('host~.test', 50, undefined)).exchanges).toHaveLength(3);
    expect((await r.list('what?', 50, undefined)).exchanges).toEqual([]);
    expect((await r.list('status=500', 50, undefined)).exchanges.map((e) => e.id)).toEqual(['c']);
  });

  it('notes when the list of values seen is full, and not otherwise', async () => {
    const full = new Reader(
      backend(list, { maskFields: async (f) => ({ fields: f.map((x) => mask(x.value)), full: true }) }),
    );
    expect((await full.list(undefined, 50, undefined)).note).toMatch(/may not be hidden/);
    expect((await new Reader(backend(list)).list(undefined, 50, undefined)).note).toBeUndefined();
  });

  it('masks a known value even in the method and a header name', async () => {
    const odd = [summary('m', { method: SECRET })];
    const b = backend(odd, {
      detail: () =>
        ({ summary: odd[0]!, requestHeaders: [[`x-${SECRET}`, 'v']], timing: {} }) as ExchangeDetail,
    });
    const r = new Reader(b);
    expect(JSON.stringify(await r.list(undefined, 50, undefined))).not.toContain(SECRET);
    const detail = await r.get('m');
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(detail.requestHeaders).toEqual([['x-[redacted]', 'v']]);
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
  const message = (i: number, base64 = 'eA==') => ({
    index: i,
    fromClient: false,
    isBinary: false,
    time: i,
    size: (base64.length * 3) / 4,
    base64,
  });
  let all = Array.from({ length: 1_200 }, (_, i) => message(i));
  const page = (_id: string, after: number, limit: number): WebSocketMessages => ({
    messages: all.filter((m) => m.index > after).slice(0, limit),
    dropped: all[0]?.index ?? 0,
    total: (all.at(-1)?.index ?? -1) + 1,
  });
  /** A backend that records what it teaches and what it masks to show. */
  const recording = (more: Partial<ReaderBackend> = {}) => {
    const taught: Array<[number, number, boolean]> = [];
    const masked: Array<[number, number, boolean]> = [];
    const b = backend([summary('w', { websocket: true, messageCount: all.length })], {
      wsPage: page,
      teachMessages: async (_d, p, fresh) => {
        taught.push([p.messages[0]!.index, p.messages.at(-1)!.index, fresh]);
      },
      maskMessages: async (_d, p, fresh) => {
        if (p.messages.length > 0) masked.push([p.messages[0]!.index, p.messages.at(-1)!.index, fresh]);
        return p;
      },
      ...more,
    });
    return { taught, masked, b };
  };
  beforeEach(() => {
    all = Array.from({ length: 1_200 }, (_, i) => message(i));
  });

  it('teaches every kept message first, after the page too, in pages from the start; then only what’s new', async () => {
    let generation = 1;
    const { taught, masked, b } = recording({ generation: () => generation });
    const r = new Reader(b);
    await r.messages('w', 1_100, 10);
    expect(taught).toEqual([
      [0, 499, true],
      [500, 999, false],
      [1000, 1199, false],
    ]);
    expect(masked).toEqual([[1101, 1110, false]]);
    // Already taught to the end: the next page is only shown.
    taught.length = 0;
    masked.length = 0;
    await r.messages('w', 1_110, 10);
    expect(taught).toEqual([]);
    expect(masked).toEqual([[1111, 1120, false]]);
    // An earlier page read again teaches nothing either: reading it doesn't move the mark back.
    await r.messages('w', 10, 5);
    await r.messages('w', 1_150, 5);
    expect(taught).toEqual([]);
    // New messages: only they are taught.
    all.push(...Array.from({ length: 50 }, (_, i) => message(1_200 + i)));
    await r.messages('w', 10, 5);
    expect(taught).toEqual([[1200, 1249, false]]);
    // The worker restarted: what it learned is gone, so it's taught again from the start.
    taught.length = 0;
    generation = 2;
    await r.messages('w', 1_150, 5);
    expect(taught[0]).toEqual([0, 499, true]);
    expect(taught.at(-1)).toEqual([1000, 1249, false]);
  });

  it('from the start, teaches the whole kept stream before showing the first page', async () => {
    const { taught, masked, b } = recording();
    await new Reader(b).messages('w', -1, 5);
    expect(taught).toEqual([
      [0, 499, true],
      [500, 999, false],
      [1000, 1199, false],
    ]);
    expect(masked).toEqual([[0, 4, false]]);
  });

  it('never masks a page to show as a fresh stream', async () => {
    const { masked, b } = recording();
    const r = new Reader(b);
    for (const after of [-1, 0, 600, 1_198]) await r.messages('w', after, 3);
    expect(masked.length).toBeGreaterThan(0);
    expect(masked.every(([, , fresh]) => !fresh)).toBe(true);
  });

  it('starts at the first kept message when older ones were let go', async () => {
    all = Array.from({ length: 50 }, (_, i) => message(100 + i));
    const { taught, masked, b } = recording();
    await new Reader(b).messages('w', -1, 5);
    expect(taught).toEqual([[100, 149, true]]);
    expect(masked).toEqual([[100, 104, false]]);
  });

  it('teaches a few megabytes at a time', async () => {
    // 3 MB each: one message per job, however many fit in a page.
    const big = 'A'.repeat(4 * 1024 * 1024);
    all = Array.from({ length: 3 }, (_, i) => message(i, big));
    const { taught, b } = recording();
    await new Reader(b).messages('w', -1, 1);
    expect(taught).toEqual([
      [0, 0, true],
      [1, 1, false],
      [2, 2, false],
    ]);
    // Small ones go many to a job.
    all = Array.from({ length: 30 }, (_, i) => message(i, 'A'.repeat(400_000)));
    const small = recording();
    await new Reader(small.b).messages('w', -1, 1);
    expect(small.taught).toEqual([
      [0, 12, true],
      [13, 25, false],
      [26, 29, false],
    ]);
  });

  it('teaches it all again from the start when the worker lost the stream, and gives up the second time', async () => {
    let lose = 1;
    const { taught, masked, b } = recording({
      maskMessages: async (_d, p, fresh) => {
        masked.push([p.messages[0]!.index, p.messages.at(-1)!.index, fresh]);
        if (lose > 0) {
          lose -= 1;
          throw new StreamLost();
        }
        return p;
      },
    });
    const r = new Reader(b);
    await r.messages('w', 1_000, 5);
    // The page was lost: everything again, from the start, then the page.
    expect(taught.filter(([, , fresh]) => fresh)).toHaveLength(2);
    expect(masked).toEqual([
      [1001, 1005, false],
      [1001, 1005, false],
    ]);
    const always = new Reader(
      recording({
        maskMessages: async () => {
          throw new StreamLost();
        },
      }).b,
    );
    await expect(always.messages('w', 600, 5)).rejects.toThrow(/Couldn’t check this stream/);
  });

  it('a page lost while being taught is taught again from the start', async () => {
    let lose = 1;
    const { taught, b } = recording({
      teachMessages: async (_d, p, fresh) => {
        taught.push([p.messages[0]!.index, p.messages.at(-1)!.index, fresh]);
        if (!fresh && lose > 0) {
          lose -= 1;
          throw new StreamLost();
        }
      },
    });
    await new Reader(b).messages('w', 5, 5);
    expect(taught).toEqual([
      [0, 499, true],
      [500, 999, false],
      [0, 499, true],
      [500, 999, false],
      [1000, 1199, false],
    ]);
  });

  it('doesn’t count a part it couldn’t teach as taught, and shows nothing', async () => {
    let fail = true;
    const { taught, masked, b } = recording({
      teachMessages: async (_d, p, fresh) => {
        taught.push([p.messages[0]!.index, p.messages.at(-1)!.index, fresh]);
        if (fail && p.messages[0]!.index === 500)
          throw new ReadError('Couldn’t check this stream for secrets.');
      },
    });
    const r = new Reader(b);
    await expect(r.messages('w', 5, 5)).rejects.toThrow(/Couldn’t check this stream/);
    expect(masked).toEqual([]);
    fail = false;
    taught.length = 0;
    await r.messages('w', 5, 5);
    // What was taught before the failure is kept; the part that failed is taught again.
    expect(taught[0]).toEqual([500, 999, false]);
    expect(masked).toEqual([[6, 10, false]]);
  });

  it('counts a teaching job as done only when the worker checked it and still knew the stream', () => {
    expect(() => checkTaught({ failed: 'boom' })).toThrow(ReadError);
    expect(() => checkTaught({ failed: 'boom' })).toThrow(
      'Couldn’t check this stream for secrets. Try again.',
    );
    expect(() => checkTaught({ messages: [], lost: true } as never)).toThrow(StreamLost);
    expect(() => checkTaught({ items: [], lost: true } as never)).toThrow(StreamLost);
    expect(() => checkTaught({ messages: [] } as never)).not.toThrow();
    expect(() => checkTaught({ items: [], lost: false } as never)).not.toThrow();
  });

  it('shows nothing of a stream cleared while it was read', async () => {
    let cleared = false;
    const { taught, masked, b } = recording({
      // The page is read; then the connection's messages are gone.
      wsPage: (id, after, limit) => {
        const out = cleared ? { messages: [], dropped: 0, total: 0 } : page(id, after, limit);
        cleared = true;
        return out;
      },
    });
    const r = new Reader(b);
    await expect(r.messages('w', -1, 5)).rejects.toThrow('That stream changed while it was read. Try again.');
    expect(taught).toEqual([]);
    expect(masked).toEqual([]);
    // Partway taught when it's cleared: the same.
    cleared = false;
    let chunks = 0;
    const partway = recording({
      wsPage: (id, after, limit) =>
        chunks++ >= 2 ? { messages: [], dropped: 0, total: 0 } : page(id, after, limit),
    });
    const r2 = new Reader(partway.b);
    await expect(r2.messages('w', -1, 5)).rejects.toThrow(/changed while it was read/);
    expect(partway.taught).toEqual([[0, 499, true]]);
    expect(partway.masked).toEqual([]);
    // What it was taught is forgotten: a stream there again is taught from the start.
    chunks = -100;
    partway.taught.length = 0;
    await r2.messages('w', -1, 5);
    expect(partway.taught[0]).toEqual([0, 499, true]);
  });

  it('reads one stream one read at a time, and a failed read doesn’t hold up the next', async () => {
    const { taught, masked, b } = recording();
    const r = new Reader(b);
    await Promise.all([r.messages('w', -1, 5), r.messages('w', 199, 5), r.messages('w', 600, 5)]);
    // Taught once, from the start, not three times over each other.
    expect(taught).toEqual([
      [0, 499, true],
      [500, 999, false],
      [1000, 1199, false],
    ]);
    expect(masked).toHaveLength(3);
    let fail = true;
    const failing = recording({
      maskMessages: async (_d, p) => {
        if (fail) {
          fail = false;
          throw new Error('broken');
        }
        return p;
      },
    });
    const f = new Reader(failing.b);
    const [one, two] = await Promise.allSettled([f.messages('w', -1, 5), f.messages('w', 5, 5)]);
    expect(one.status).toBe('rejected');
    expect(two.status).toBe('fulfilled');
  });

  it('refuses what isn’t a WebSocket or an event stream', async () => {
    const r = new Reader(backend([summary('a')]));
    await expect(r.messages('a', -1, 5)).rejects.toThrow(/isn’t a WebSocket/);
    await expect(r.events('a', 0)).rejects.toThrow(/isn’t an event stream/);
  });
});

describe('a search’s pages', () => {
  // 1,200 exchanges, every 100th a 500: the matches are spread across the batches masked at once.
  const many = Array.from({ length: 1_200 }, (_, i) =>
    summary(`e${i}`, i % 100 === 0 ? { status: 500 } : {}),
  );

  it('pages through what matches, across batches, with a cursor until the last', async () => {
    const r = new Reader(backend(many));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await r.list('status=500', 5, cursor);
      seen.push(...page.exchanges.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([
      'e1100',
      'e1000',
      'e900',
      'e800',
      'e700',
      'e600',
      'e500',
      'e400',
      'e300',
      'e200',
      'e100',
      'e0',
    ]);
    expect(pages).toBe(3);
  });

  it('gives no next page when what’s left doesn’t match, or the page took exactly the rest', async () => {
    const r = new Reader(backend(many));
    // 12 matches, 12 asked: nothing after.
    expect((await r.list('status=500', 12, undefined)).nextCursor).toBeUndefined();
    // After e0 there's nothing; after e100, only e0.
    const last = await r.list('status=500', 5, 'e100');
    expect(last.exchanges.map((e) => e.id)).toEqual(['e0']);
    expect(last.nextCursor).toBeUndefined();
    expect((await r.list('status=404', 5, undefined)).exchanges).toEqual([]);
  });
});

describe('event streams read from partway', () => {
  const N = 1_200;
  // Items are numbered from 1; a read gives every kept item after the index asked for.
  const items = Array.from({ length: N }, (_, i) => ({
    kind: 'event' as const,
    index: i + 1,
    type: 'message',
    data: `d${i + 1}`,
  }));
  const read =
    (serial = 1) =>
    async (_id: string, after: number) => ({
      serial,
      items: items.filter((item) => item.index > after),
      total: N,
      receiving: false,
    });
  const stream = [summary('s', { contentType: 'text/event-stream' })];
  const recording = (more: Partial<ReaderBackend> = {}) => {
    const taught: Array<[number, number, boolean]> = [];
    const masked: Array<[number, number, boolean]> = [];
    const b = backend(stream, {
      sseRead: read(),
      teachEvents: async (_d, view, fresh) => {
        taught.push([view.items[0]!.index, view.items.at(-1)!.index, fresh]);
      },
      maskEvents: async (_d, view, fresh) => {
        if (view.items.length > 0) masked.push([view.items[0]!.index, view.items.at(-1)!.index, fresh]);
        return view;
      },
      ...more,
    });
    return { taught, masked, b };
  };

  it('teaches every kept item first, in pages, from the start; then only what’s new', async () => {
    let generation = 1;
    const { taught, masked, b } = recording({ generation: () => generation });
    const r = new Reader(b);
    const out = await r.events('s', 1_100);
    expect(out.items[0]).toMatchObject({ index: 1_101, data: 'd1101' });
    expect(taught).toEqual([
      [1, 500, true],
      [501, 1000, false],
      [1001, 1200, false],
    ]);
    expect(masked).toEqual([[1101, 1200, false]]);
    // Already taught to the end: nothing taught again, whichever part is read.
    taught.length = 0;
    await r.events('s', 1_150);
    await r.events('s', 0);
    expect(taught).toEqual([]);
    // The worker restarted: taught again from the start.
    generation = 2;
    await r.events('s', 1_150);
    expect(taught[0]).toEqual([1, 500, true]);
    expect(taught.at(-1)).toEqual([1001, 1200, false]);
  });

  it('from the start, teaches every kept item, then shows them, never as a fresh stream', async () => {
    const { taught, masked, b } = recording();
    await new Reader(b).events('s', 0);
    expect(taught[0]).toEqual([1, 500, true]);
    expect(taught.at(-1)).toEqual([1001, 1200, false]);
    expect(masked).toEqual([[1, 1200, false]]);
  });

  it('shows nothing of a stream whose body was replaced while it was read, and never teaches the new one’s items', async () => {
    let reads = 0;
    const { taught, masked, b } = recording({
      // The first read is the old body; every later one a new body.
      sseRead: async (id, after) => read(reads++ === 0 ? 1 : 2)(id, after),
    });
    const r = new Reader(b);
    await expect(r.events('s', 600)).rejects.toThrow('That stream changed while it was read. Try again.');
    expect(taught).toEqual([]);
    expect(masked).toEqual([]);
    // Read again: the new body, taught whole.
    await r.events('s', 600);
    expect(taught[0]).toEqual([1, 500, true]);
    expect(masked).toEqual([[601, 1200, false]]);
  });

  it('reads one stream one read at a time', async () => {
    const { taught, masked, b } = recording();
    const r = new Reader(b);
    await Promise.all([r.events('s', 0), r.events('s', 1_100), r.events('s', 600)]);
    // Taught once, not three times over each other.
    expect(taught.filter(([, , fresh]) => fresh)).toHaveLength(1);
    expect(masked).toHaveLength(3);
  });

  it('says so when the stream can’t be read', async () => {
    await expect(new Reader(backend(stream)).events('s', 0)).rejects.toThrow(/can’t be read/);
  });
});

describe('what the reader keeps', () => {
  it('keeps the 4 bodies read most recently, and masks one again once it’s let go', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const body = vi.fn(async () => ({
      base64: '',
      size: 1,
      truncated: false,
      contentType: 'text/plain',
      masked: { text: 'x', ranges: [] },
    }));
    const r = new Reader(
      backend(
        ids.map((id) => summary(id)),
        { body: body as never },
      ),
    );
    for (const id of ids) await r.body(id, 'response', 0, 10);
    expect(body).toHaveBeenCalledTimes(5);
    // b to e are kept; a was let go.
    for (const id of ['b', 'c', 'd', 'e']) await r.body(id, 'response', 0, 10);
    expect(body).toHaveBeenCalledTimes(5);
    await r.body('a', 'response', 0, 10);
    expect(body).toHaveBeenCalledTimes(6);
  });

  it('reads a body again after reading it failed, and never shows why it failed', async () => {
    let fail = true;
    const body = vi.fn(async () => {
      if (fail) throw new Error(`disk said ${SECRET}`);
      return { base64: '', size: 1, truncated: false, masked: { text: 'ok', ranges: [] } };
    });
    const r = new Reader(backend([summary('a')], { body: body as never }));
    const error = await r.body('a', 'request', 0, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReadError);
    expect((error as Error).message).toBe('Couldn’t read that body.');
    fail = false;
    expect(await r.body('a', 'request', 0, 10)).toMatchObject({ kind: 'text', text: 'ok' });
    // A ReadError from the backend is given as it is.
    const said = new Reader(
      backend([summary('a')], {
        body: async () => {
          throw new ReadError('That body is too big.');
        },
      }),
    );
    await expect(said.body('a', 'request', 0, 10)).rejects.toThrow('That body is too big.');
  });

  it('remembers how far the 100 streams read most recently were taught', async () => {
    const N = 30;
    const page = (_id: string, after: number, limit: number): WebSocketMessages => ({
      messages: Array.from({ length: N }, (_, i) => ({
        index: i,
        fromClient: false,
        isBinary: false,
        time: i,
        size: 1,
        base64: 'eA==',
      }))
        .filter((m) => m.index > after)
        .slice(0, limit),
      dropped: 0,
      total: N,
    });
    const ids = Array.from({ length: 101 }, (_, i) => `w${i}`);
    const fresh: string[] = [];
    const b = backend(
      ids.map((id) => summary(id, { websocket: true, messageCount: N })),
      {
        wsPage: page,
        teachMessages: async (d, _p, isFresh) => {
          if (isFresh) fresh.push(d.summary.id);
        },
      },
    );
    const r = new Reader(b);
    for (const id of ids) await r.messages(id, 10, 5);
    expect(fresh).toEqual(ids);
    fresh.length = 0;
    // w1 is still remembered: only what's new. w0 was let go: from the start again.
    await r.messages('w1', 20, 5);
    expect(fresh).toEqual([]);
    await r.messages('w0', 20, 5);
    expect(fresh).toEqual(['w0']);
  });

  it('passes on an error that isn’t a lost stream, without trying again', async () => {
    const maskMessages = vi.fn(async () => {
      throw new Error('broken');
    });
    const r = new Reader(
      backend([summary('w', { websocket: true, messageCount: 1 })], {
        wsPage: () => ({
          messages: [{ index: 0, fromClient: false, isBinary: false, time: 0, size: 1, base64: 'eA==' }],
          dropped: 0,
          total: 1,
        }),
        maskMessages,
      }),
    );
    await expect(r.messages('w', -1, 5)).rejects.toThrow('broken');
    expect(maskMessages).toHaveBeenCalledTimes(1);
  });
});
