/**
 * Reading an event stream as it arrives (src/backend/sse-reader.ts): only new bytes each look,
 * Content-Encoding undone as it goes, the newest items kept, and each look limited.
 */
import zlib, { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SSE_ITEMS, SSE_READ_PER_LOOK, SseReader, type SseReaderHost } from '../src/backend/sse-reader';
import type { ExchangeDetail } from '../src/shared/api';

interface Body {
  bytes: Uint8Array;
  receiving: boolean;
  serial: number;
  size?: number;
  decoded?: boolean;
}

let exchanges: Map<string, ExchangeDetail>;
let bodies: Map<string, Body>;
let reads: Array<{ start: number; maxBytes: number }>;
let now = 0;
/** While set, reads wait for it: lets a test act in the middle of a look. */
let pause: Promise<void> | undefined;
/** Only reads of this stream wait for `pause`, when set. */
let pausedId: string | undefined;

const host: SseReaderHost = {
  getExchange: (id) => exchanges.get(id),
  readRange: async (id, _side, start, maxBytes) => {
    reads.push({ start, maxBytes });
    if (pause && (pausedId === undefined || pausedId === id)) await pause;
    const body = bodies.get(id);
    if (!body) return undefined;
    return {
      bytes: body.bytes.slice(start, start + maxBytes),
      stored: body.bytes.length,
      size: body.size ?? body.bytes.length,
      receiving: body.receiving,
      incomplete: false,
      serial: body.serial,
      decoded: body.decoded ?? false,
    };
  },
};

beforeEach(() => {
  exchanges = new Map();
  bodies = new Map();
  reads = [];
  now = 0;
  pause = undefined;
  pausedId = undefined;
});

let next = 0;
/** A stream whose body is `bytes` so far. */
const stream = (
  bytes: Uint8Array,
  headers: Array<[string, string]> = [],
  contentType = 'text/event-stream',
) => {
  const id = `s${++next}`;
  exchanges.set(id, {
    summary: {
      id,
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'api.test',
      path: '/events',
      url: 'https://api.test/events',
      startedAt: 0,
      status: 200,
      contentType,
      responding: true,
    },
    requestHeaders: [],
    responseHeaders: [['content-type', contentType], ...headers],
    timing: { startTimestamp: 0 },
  });
  bodies.set(id, { bytes, receiving: true, serial: 1 });
  return id;
};
const grow = (id: string, more: Uint8Array, receiving = true) => {
  const body = bodies.get(id)!;
  bodies.set(id, { ...body, bytes: Buffer.concat([body.bytes, more]), receiving });
};
const reader = () => new SseReader(host, () => now);
const data = (items: Array<{ kind: string; data?: string }>) => items.map((i) => i.data);

describe('reading an event stream as it arrives', () => {
  it('gives the items after the last one asked about, reading only new bytes', async () => {
    const id = stream(Buffer.from('data: one\n\n'));
    const r = reader();
    const first = (await r.read(id, 0))!;
    expect(first).toMatchObject({ total: 1, receiving: true, serial: 1 });
    expect(data(first.items)).toEqual(['one']);
    grow(id, Buffer.from('data: two\n\ndata: thr'));
    reads.length = 0;
    const second = (await r.read(id, 1))!;
    expect(data(second.items)).toEqual(['two']);
    expect(reads[0]!.start).toBe(11);
    grow(id, Buffer.from('ee\n\n'), false);
    const third = (await r.read(id, 2))!;
    expect(data(third.items)).toEqual(['three']);
    expect(third).toMatchObject({ total: 3, receiving: false });
  });

  it('undoes gzip, deflate and br as the bytes arrive, split anywhere', async () => {
    const text = Buffer.from(Array.from({ length: 50 }, (_, i) => `data: event ${i}\n\n`).join(''));
    for (const [name, packed] of [
      ['gzip', gzipSync(text)],
      ['deflate', deflateSync(text)],
      ['br', brotliCompressSync(text)],
    ] as const) {
      const half = Math.floor(packed.length / 2);
      const id = stream(packed.subarray(0, half), [['content-encoding', name]]);
      const r = reader();
      const first = (await r.read(id, 0))!;
      grow(id, packed.subarray(half), false);
      const rest = (await r.read(id, first.items.at(-1)?.index ?? 0))!;
      const all = [...first.items, ...rest.items];
      expect(data(all), name).toEqual(Array.from({ length: 50 }, (_, i) => `event ${i}`));
      expect(rest.problem).toBeUndefined();
    }
  });

  it('decodes UTF-8 split across reads, and drops a leading BOM', async () => {
    const bytes = Buffer.from('﻿data: héllo ✓\n\n');
    const id = stream(bytes.subarray(0, 12));
    const r = reader();
    await r.read(id, 0);
    grow(id, bytes.subarray(12));
    const view = (await r.read(id, 0))!;
    expect(data(view.items)).toEqual(['héllo ✓']);
  });

  it('keeps only the newest items, and says how many there were', async () => {
    const many = Array.from({ length: MAX_SSE_ITEMS + 30 }, (_, i) => `data: ${i}\n\n`).join('');
    const id = stream(Buffer.from(many), [], 'text/event-stream; charset=utf-8');
    const view = (await reader().read(id, 0))!;
    expect(view.total).toBe(MAX_SSE_ITEMS + 30);
    expect(view.items.length).toBe(MAX_SSE_ITEMS);
    expect(view.items[0]!.index).toBe(31);
  });

  it('catches up with a large stream over a few looks', async () => {
    const event = `data: ${'z'.repeat(1000)}\n\n`;
    const id = stream(Buffer.from(event.repeat(Math.ceil((SSE_READ_PER_LOOK * 1.5) / event.length))));
    const r = reader();
    const first = (await r.read(id, 0))!;
    const second = (await r.read(id, first.items.at(-1)!.index))!;
    expect(second.total).toBeGreaterThan(first.total);
    expect(first.total).toBeLessThan(Math.ceil((SSE_READ_PER_LOOK * 1.5) / event.length));
  });

  it('keeps two looks at the same stream from getting in each other’s way', async () => {
    const id = stream(Buffer.from('data: a\n\n'));
    const r = reader();
    await r.read(id, 0);
    grow(id, Buffer.from('data: b\n\ndata: c\n\n'));
    const [x, y] = await Promise.all([r.read(id, 1), r.read(id, 1)]);
    for (const view of [x!, y!]) {
      expect(view.total).toBe(3);
      expect(data(view.items)).toEqual(['b', 'c']);
    }
  });

  it('starts over when the body is replaced', async () => {
    const id = stream(Buffer.from('data: old\n\n'));
    const r = reader();
    await r.read(id, 0);
    bodies.set(id, { bytes: Buffer.from('data: new\n\n'), receiving: true, serial: 2 });
    const view = (await r.read(id, 0))!;
    expect(view.serial).toBe(2);
    expect(data(view.items)).toEqual(['new']);
  });

  it('takes a body imported from a HAR file as already decoded', async () => {
    const id = stream(Buffer.from('data: plain\n\n'), [['content-encoding', 'gzip']]);
    bodies.set(id, { ...bodies.get(id)!, decoded: true });
    expect(data((await reader().read(id, 0))!.items)).toEqual(['plain']);
  });
});

describe('reading an event stream, within limits', () => {
  it('keeps items within a limit on characters, dropping the oldest, not all but one', async () => {
    const big = `data: ${'d'.repeat(60_000)}\n\n`;
    const id = stream(Buffer.from(big.repeat(100)));
    const r = reader();
    let view = (await r.read(id, 0))!;
    let all = view.items;
    while (view.more) {
      view = (await r.read(id, all.at(-1)!.index))!;
      all = [...all, ...view.items];
    }
    expect(view.total).toBe(100);
    // The newest that fit in 4 million characters: many, not one.
    const kept = (await r.read(id, 0))!.items;
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.length).toBeLessThan(100);
    expect(kept.at(-1)!.index).toBe(100);
  });

  it('reads a stream that compresses well over a few looks, without taking it for a bomb', async () => {
    const text = Buffer.from(
      Array.from({ length: 30_000 }, (_, i) => `data: {"n":${i},"pad":"${'p'.repeat(1000)}"}\n\n`).join(''),
    );
    const id = stream(gzipSync(text), [['content-encoding', 'gzip']]);
    bodies.set(id, { ...bodies.get(id)!, receiving: false });
    const r = reader();
    let view = (await r.read(id, 0))!;
    let looks = 1;
    expect(view.more).toBe(true);
    while (view.more) {
      view = (await r.read(id, view.items.at(-1)?.index ?? 0))!;
      looks++;
    }
    expect(looks).toBeGreaterThan(1);
    expect(view.problem).toBeUndefined();
    expect(view.total).toBe(30_000);
    expect(view.more).toBeUndefined();
  });

  it('undoes x-gzip, raw deflate and zstd too', async () => {
    const text = Buffer.from('data: packed\n\n');
    const packs: Array<[string, Buffer]> = [
      ['x-gzip', gzipSync(text)],
      ['deflate', deflateRawSync(text)],
    ];
    if (typeof zlib.zstdCompressSync === 'function') packs.push(['zstd', zlib.zstdCompressSync(text)]);
    for (const [name, packed] of packs) {
      const id = stream(packed, [['content-encoding', name]]);
      expect(data((await reader().read(id, 0))!.items), name).toEqual(['packed']);
    }
  });

  it('gives nothing, and keeps nothing, for a stream let go of while it was being read', async () => {
    const id = stream(Buffer.from('data: a\n\n'));
    const r = reader();
    await r.read(id, 0);
    grow(id, Buffer.from('data: b\n\n'));
    let resume!: () => void;
    pause = new Promise((resolve) => (resume = resolve));
    reads.length = 0;
    const reading = r.read(id, 1);
    // In the middle of the look: its read of the body is waiting.
    await vi.waitFor(() => expect(reads.length).toBe(1));
    r.delete(id);
    pause = undefined;
    resume();
    expect(await reading).toMatchObject({ items: [], total: 0 });
    reads.length = 0;
    await r.read(id, 0);
    expect(reads[0]!.start).toBe(0);
  });

  it('doesn’t let go of a stream while a look at it is under way, however many others are read', async () => {
    const r = reader();
    const busy = stream(Buffer.from('data: a\n\n'));
    await r.read(busy, 0);
    grow(busy, Buffer.from('data: b\n\n'));
    let resume!: () => void;
    pause = new Promise((resolve) => (resume = resolve));
    pausedId = busy;
    reads.length = 0;
    const reading = r.read(busy, 1);
    await vi.waitFor(() => expect(reads.length).toBe(1));
    for (let i = 0; i < 21; i++) await r.read(stream(Buffer.from('data: x\n\n')), 0);
    pause = undefined;
    resume();
    expect(data((await reading)!.items)).toEqual(['b']);
  });

  it('follows a limited number of streams, letting go of the least recently read', async () => {
    const r = reader();
    const ids = Array.from({ length: 21 }, () => stream(Buffer.from('data: a\n\n')));
    for (const id of ids) await r.read(id, 0);
    reads.length = 0;
    await r.read(ids[0]!, 1);
    expect(reads[0]!.start).toBe(0);
    reads.length = 0;
    await r.read(ids.at(-1)!, 1);
    expect(reads[0]!.start).toBe(9);
  });
});

describe('reading an event stream, when it can’t all be', () => {
  it('says it can’t undo an encoding it doesn’t know, and shows nothing garbled', async () => {
    // Even text that would read as events isn't taken as it is.
    const id = stream(Buffer.from('data: garbled\n\n'), [['content-encoding', 'compress']]);
    const view = (await reader().read(id, 0))!;
    expect(view.problem).toMatch(/compressed with compress/);
    expect(view.items).toEqual([]);
  });

  it('says when the compressed data is broken, keeping what came before', async () => {
    const good = gzipSync(Buffer.from('data: fine\n\n'));
    const id = stream(Buffer.concat([good.subarray(0, 10)]), [['content-encoding', 'gzip']]);
    const r = reader();
    await r.read(id, 0);
    // Not gzip from here on.
    grow(id, Buffer.from('this is not gzip at all, not even close'));
    const view = (await r.read(id, 0))!;
    expect(view.problem).toMatch(/Content-Encoding couldn't be undone/);
  });

  it('stops at data that decompresses to far more than was sent', async () => {
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x61));
    const id = stream(bomb, [['content-encoding', 'gzip']]);
    const view = (await reader().read(id, 0))!;
    expect(view.problem).toMatch(/far more than was sent/);
  });

  it('turns invalid UTF-8 into replacement characters', async () => {
    const id = stream(
      Buffer.concat([Buffer.from('data: a'), Buffer.from([0xff, 0xfe]), Buffer.from('b\n\n')]),
    );
    expect(data((await reader().read(id, 0))!.items)).toEqual(['a��b']);
  });

  it('says when Wirescry kept only the first part of the stream', async () => {
    const id = stream(Buffer.from('data: kept\n\ndata: cut'));
    bodies.set(id, { ...bodies.get(id)!, size: 50_000 });
    const view = (await reader().read(id, 0))!;
    expect(data(view.items)).toEqual(['kept']);
    expect(view.problem).toMatch(/kept only the first/);
  });

  it('gives nothing for an exchange that’s gone or isn’t an event stream, and waits for a body', async () => {
    const r = reader();
    expect(await r.read('nope', 0)).toBeNull();
    expect(await r.read(stream(Buffer.from('data: x\n\n'), [], 'text/plain'), 0)).toBeNull();
    const empty = stream(Buffer.alloc(0));
    bodies.delete(empty);
    expect(await r.read(empty, 0)).toMatchObject({ items: [], total: 0, receiving: true });
  });

  it('forgets a stream it hasn’t been asked about for a minute, and reads it from the start again', async () => {
    const id = stream(Buffer.from('data: a\n\n'));
    const r = reader();
    await r.read(id, 0);
    reads.length = 0;
    await r.read(id, 1);
    expect(reads[0]!.start).toBe(9);
    now += 61_000;
    reads.length = 0;
    await r.read(id, 1);
    expect(reads[0]!.start).toBe(0);
  });
});
