/**
 * Remembering what bodies held (src/backend/body-memo.ts) and how searches use it
 * (src/backend/search.ts): finished bodies read once, arriving ones read again only when they've
 * grown and their throttle allows, with a nudge so a quiet tail is still searched; nothing
 * remembered from a body that went, or for an exchange gone since.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBuffer } from 'http-encoding';
import {
  BodyMemo,
  isNewer,
  MAX_KEYS_PER_EXCHANGE,
  memoKey,
  Nudger,
  type MemoValue,
} from '../src/backend/body-memo';
import type { StoredRange } from '../src/backend/body-store';
import { matchExchanges, MIN_RESCAN_MS, RESCAN_COST_FACTOR, type BodyAccess } from '../src/backend/search';
import { InMemoryRequestStore } from '../src/backend/store';
import type { BodySide, ExchangeDetail } from '../src/shared/api';

const done = (over: Partial<MemoValue> = {}): MemoValue =>
  ({ kind: 'done', serial: 1, encoding: '', found: [], partial: false, ...over }) as MemoValue;
const sofar = (over: Partial<MemoValue> = {}): MemoValue =>
  ({
    kind: 'sofar',
    serial: 1,
    encoding: '',
    found: [],
    stored: 10,
    final: false,
    partial: false,
    scannedAt: 0,
    costMs: 1,
    ...over,
  }) as MemoValue;

describe('BodyMemo', () => {
  it('keys a side’s needles as a set, in any order', () => {
    expect(memoKey('response', ['b', 'a', 'a'])).toBe(memoKey('response', ['a', 'b']));
    expect(memoKey('response', ['a'])).not.toBe(memoKey('response', ['ab']));
    expect(memoKey('response', ['a'])).not.toBe(memoKey('request', ['a']));
    // Needles can hold any character, including the separators a joined string would use.
    expect(memoKey('response', ['a,b'])).not.toBe(memoKey('response', ['a', 'b']));
  });

  it('replaces a value only with a newer or more complete one about the same body', () => {
    expect(isNewer(sofar(), undefined)).toBe(true);
    expect(isNewer(done(), sofar())).toBe(true);
    expect(isNewer(sofar(), done())).toBe(false);
    expect(isNewer(done(), done())).toBe(false);
    expect(isNewer(sofar({ scannedAt: 5 }), sofar({ scannedAt: 4 }))).toBe(true);
    expect(isNewer(sofar({ scannedAt: 4 }), sofar({ scannedAt: 5 }))).toBe(false);
    // Another body (replaced), or another encoding: always replaced.
    expect(isNewer(sofar({ serial: 2 }), done())).toBe(true);
    expect(isNewer(sofar({ encoding: 'gzip' }), done())).toBe(true);
  });

  it('compares with the value there when it writes, not when its search began', () => {
    const memo = new BodyMemo();
    const key = memoKey('response', ['x']);
    memo.offer('a', key, sofar({ scannedAt: 1 }));
    memo.offer('a', key, done());
    // A slower search that began earlier finishes last.
    memo.offer('a', key, sofar({ scannedAt: 2 }));
    expect(memo.get('a', key)?.kind).toBe('done');
  });

  it('forgets an exchange, clears all, and keeps at most its limit of exchanges', () => {
    const memo = new BodyMemo(2);
    const key = memoKey('response', ['x']);
    memo.offer('a', key, done());
    memo.offer('b', key, done());
    memo.offer('c', key, done());
    expect(memo.get('a', key)).toBeUndefined();
    expect(memo.size).toBe(2);
    memo.forget('b');
    expect(memo.get('b', key)).toBeUndefined();
    memo.clear();
    expect(memo.size).toBe(0);
  });
});

describe('BodyMemo, after code review', () => {
  it('keeps at most a few needle sets per exchange, dropping its oldest', () => {
    const memo = new BodyMemo();
    const keys = Array.from({ length: MAX_KEYS_PER_EXCHANGE + 1 }, (_, i) => memoKey('response', [`n${i}`]));
    for (const key of keys) memo.offer('a', key, done());
    expect(memo.get('a', keys[0]!)).toBeUndefined();
    expect(memo.get('a', keys[1]!)).toBeDefined();
    expect(memo.get('a', keys.at(-1)!)).toBeDefined();
    // Replacing one already there drops nothing.
    memo.offer('a', keys[1]!, sofar({ serial: 2 }));
    expect(memo.get('a', keys[2]!)).toBeDefined();
  });

  it('won’t let an answer about an older body replace one about a newer', () => {
    expect(isNewer(sofar({ serial: 1, scannedAt: 9 }), done({ serial: 2 }))).toBe(false);
    expect(isNewer(done({ serial: 1 }), sofar({ serial: 2 }))).toBe(false);
    expect(isNewer(done({ serial: 3 }), done({ serial: 2 }))).toBe(true);
  });
});

describe('Nudger', () => {
  afterEach(() => vi.useRealTimers());

  it('fires once for an exchange at the time asked, ignoring a second ask meanwhile', () => {
    vi.useFakeTimers();
    let clock = 1000;
    const fired: string[] = [];
    const nudger = new Nudger(
      (id) => fired.push(id),
      () => clock,
    );
    nudger.schedule('a', 1100);
    nudger.schedule('a', 1050);
    nudger.schedule('b', 1200);
    expect(nudger.size).toBe(2);
    vi.advanceTimersByTime(99);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['a']);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['a', 'b']);
    expect(nudger.size).toBe(0);
    // A time already past fires at once.
    clock = 5000;
    nudger.schedule('c', 10);
    vi.advanceTimersByTime(0);
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('fires nothing for an exchange forgotten, after clear, or after stop', () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const nudger = new Nudger(
      (id) => fired.push(id),
      () => 0,
    );
    nudger.schedule('a', 10);
    nudger.schedule('keep', 10);
    nudger.forget('a');
    vi.advanceTimersByTime(100);
    // Only the one not forgotten.
    expect(fired).toEqual(['keep']);
    fired.length = 0;
    nudger.schedule('b', 10);
    nudger.clear();
    vi.advanceTimersByTime(100);
    expect(fired).toEqual([]);
    // Cleared, it can wait again.
    nudger.schedule('c', 10);
    nudger.stop();
    nudger.schedule('d', 10);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual([]);
    expect(nudger.size).toBe(0);
  });
});

describe('searching with the memo', () => {
  function stored(id: string): ExchangeDetail {
    return {
      summary: {
        id,
        method: 'GET',
        protocol: 'https',
        httpVersion: '1.1',
        host: 'api.test',
        path: `/${id}`,
        url: `https://api.test/${id}`,
        startedAt: 0,
      },
      requestHeaders: [],
      timing: { startTimestamp: 0 },
    };
  }

  /** A response body that can grow, finish, be replaced, or fail to read. */
  function body(initial: string, options: { encoding?: string } = {}) {
    const b = {
      bytes: Buffer.from(initial),
      serial: 1,
      receiving: true,
      size: undefined as number | undefined,
      failNext: false,
      reads: 0,
      grow(more: string) {
        b.bytes = Buffer.concat([b.bytes, Buffer.from(more)]);
      },
      state() {
        return {
          serial: b.serial,
          stored: b.bytes.length,
          size: b.size ?? b.bytes.length,
          receiving: b.receiving,
          incomplete: false,
        };
      },
    };
    const access: BodyAccess = {
      source: (_detail, side: BodySide) =>
        side !== 'response'
          ? undefined
          : {
              encoding: options.encoding,
              serial: b.serial,
              state: b.state(),
              read: async (start, max): Promise<StoredRange | undefined> => {
                b.reads++;
                if (b.failNext) {
                  b.failNext = false;
                  return undefined;
                }
                return { bytes: b.bytes.subarray(start, start + max), ...b.state() };
              },
            },
    };
    return { b, access };
  }

  /** Access to an existing body object, as body() builds it. */
  async function bodyAccessFor(b: ReturnType<typeof body>['b'], encoding?: string): Promise<BodyAccess> {
    return {
      source: (_detail, side: BodySide) =>
        side !== 'response'
          ? undefined
          : {
              encoding,
              serial: b.serial,
              state: b.state(),
              read: async (start, max): Promise<StoredRange | undefined> => {
                b.reads++;
                return { bytes: b.bytes.subarray(start, start + max), ...b.state() };
              },
            },
    };
  }

  function setup(initial: string, options: { encoding?: string } = {}) {
    const store = new InMemoryRequestStore();
    store.upsert(stored('a'));
    const { b, access } = body(initial, options);
    const memo = new BodyMemo();
    let clock = 0;
    const nudges: Array<[string, number]> = [];
    const run = (query: string) =>
      matchExchanges(store, query, ['a'], {
        bodies: access,
        memo,
        now: () => clock,
        nudge: (id, at) => nudges.push([id, at]),
      });
    return { store, b, memo, nudges, run, advance: (ms: number) => (clock += ms) };
  }

  it('reads a finished body once, then answers from the memo', async () => {
    const { b, run } = setup('finished body with a word');
    b.receiving = false;
    expect(await run('resbody~word')).toEqual(['a']);
    const reads = b.reads;
    expect(await run('resbody~word')).toEqual(['a']);
    expect(await run('resbody~word')).toEqual(['a']);
    expect(b.reads).toBe(reads);
    // Another needle is another search.
    expect(await run('resbody~other')).toEqual([]);
    expect(b.reads).toBeGreaterThan(reads);
  });

  it('answers an arriving body from the memo until it grows, and finds what arrives later', async () => {
    const { b, run, advance } = setup('first part');
    expect(await run('resbody~later')).toEqual([]);
    const reads = b.reads;
    advance(1000);
    expect(await run('resbody~later')).toEqual([]);
    expect(b.reads).toBe(reads);
    b.grow(' and later part');
    expect(await run('resbody~later')).toEqual(['a']);
  });

  it('once every needle is found, an arriving body isn’t read again', async () => {
    const { b, run, advance } = setup('has it');
    expect(await run('resbody~has')).toEqual(['a']);
    const reads = b.reads;
    b.grow(' more');
    advance(1000);
    expect(await run('resbody~has')).toEqual(['a']);
    expect(b.reads).toBe(reads);
  });

  it('waits its throttle before reading a grown body again, and asks for a nudge at the deadline', async () => {
    const { b, run, advance, nudges } = setup('first');
    await run('resbody~later');
    const reads = b.reads;
    b.grow(' later');
    // Searching cost 0 ms of the fake clock, so the least wait applies.
    advance(MIN_RESCAN_MS - 1);
    expect(await run('resbody~later')).toEqual([]);
    expect(b.reads).toBe(reads);
    expect(nudges).toEqual([['a', MIN_RESCAN_MS]]);
    advance(1);
    expect(await run('resbody~later')).toEqual(['a']);
    expect(RESCAN_COST_FACTOR).toBe(10);
  });

  it('the throttle grows with how long the last search took', async () => {
    const store = new InMemoryRequestStore();
    store.upsert(stored('a'));
    const { b, access } = body('first');
    const memo = new BodyMemo();
    let clock = 0;
    const nudges: number[] = [];
    // Every read takes 50 ms of the clock.
    const slow: BodyAccess = {
      source: (detail, side) => {
        const s = access.source(detail, side)!;
        return {
          ...s,
          read: async (start, max) => {
            clock += 50;
            return s.read(start, max);
          },
        };
      },
    };
    const run = () =>
      matchExchanges(store, 'resbody~later', ['a'], {
        bodies: slow,
        memo,
        now: () => clock,
        nudge: (_id, at) => nudges.push(at),
      });
    await run();
    const cost = clock;
    b.grow(' later');
    expect(await run()).toEqual([]);
    expect(nudges).toEqual([RESCAN_COST_FACTOR * cost]);
    clock = RESCAN_COST_FACTOR * cost;
    expect(await run()).toEqual(['a']);
  });

  it('a plain body finishing with nothing new is done without reading it again', async () => {
    const { b, run, memo } = setup('all there');
    expect(await run('resbody~missing')).toEqual([]);
    const reads = b.reads;
    b.receiving = false;
    expect(await run('resbody~missing')).toEqual([]);
    expect(b.reads).toBe(reads);
    expect(memo.get('a', memoKey('response', ['missing']))?.kind).toBe('done');
  });

  it('a compressed body finishing is read again: cut off it decoded so far, finished it may not decode', async () => {
    const encoded = await encodeBuffer(Buffer.from('compressed words'), 'gzip');
    const { b, run, advance } = setup('', { encoding: 'gzip' });
    b.bytes = Buffer.from(encoded.subarray(0, 8));
    expect(await run('resbody~words')).toEqual([]);
    b.bytes = Buffer.from(encoded);
    b.receiving = false;
    advance(1000);
    expect(await run('resbody~words')).toEqual(['a']);
  });

  it('a compressed body cut off, then finished with the same bytes, is read again: it no longer decodes', async () => {
    const encoded = await encodeBuffer(Buffer.from('x'.repeat(2000)), 'gzip');
    const { b, store, memo } = setup('', { encoding: 'gzip' });
    b.bytes = Buffer.from(encoded.subarray(0, Math.floor(encoded.length / 2)));
    const gz = await bodyAccessFor(b, 'gzip');
    const ask = async () => {
      const partial = new Set<string>();
      const found = await matchExchanges(store, 'resbody~absent', ['a'], {
        bodies: gz,
        memo,
        partial,
        now: () => 0,
      });
      return { found, partial: [...partial] };
    };
    // Arriving: decoded as far as it goes, not partly searched.
    expect(await ask()).toEqual({ found: [], partial: [] });
    // Finished with the same bytes: cut off for good, so it can't be decoded: partly searched.
    b.receiving = false;
    expect(await ask()).toEqual({ found: [], partial: ['a'] });
  });

  it('a body that couldn’t be read isn’t remembered: the next ask reads it again', async () => {
    const { b, run, memo } = setup('text');
    b.receiving = false;
    b.failNext = true;
    expect(await run('resbody~text')).toEqual([]);
    expect(memo.size).toBe(0);
    expect(await run('resbody~text')).toEqual(['a']);
  });

  it('a replaced body, or one whose encoding turned out different, is read again', async () => {
    const { b, run } = setup('old text');
    b.receiving = false;
    expect(await run('resbody~new')).toEqual([]);
    b.bytes = Buffer.from('new text');
    b.serial = 2;
    expect(await run('resbody~new')).toEqual(['a']);

    const encoded = await encodeBuffer(Buffer.from('decoded only'), 'gzip');
    const plain = setup('');
    plain.b.bytes = Buffer.from(encoded);
    plain.b.receiving = false;
    expect(await plain.run('resbody~decoded')).toEqual([]);
    const gz = body('', { encoding: 'gzip' });
    gz.b.bytes = Buffer.from(encoded);
    gz.b.receiving = false;
    expect(
      await matchExchanges(plain.store, 'resbody~decoded', ['a'], { bodies: gz.access, memo: plain.memo }),
    ).toEqual(['a']);
  });

  it('partly searched comes from the body now, not from the memo', async () => {
    const { b, store, memo } = setup('kept part');
    const ask = async () => {
      const partial = new Set<string>();
      const found = await matchExchanges(store, 'resbody~missing', ['a'], {
        bodies: await bodyAccessFor(b),
        memo,
        partial,
        now: () => 0,
      });
      return { found, partial: [...partial] };
    };
    expect(await ask()).toEqual({ found: [], partial: [] });
    const reads = b.reads;
    // The store stops keeping its bytes: more arrive than are kept, and nothing new is stored.
    b.size = 10_000;
    expect(await ask()).toEqual({ found: [], partial: ['a'] });
    // Answered from the memo: nothing read.
    expect(b.reads).toBe(reads);
  });

  it('doesn’t remember for an exchange deleted while its body was read', async () => {
    const store = new InMemoryRequestStore();
    store.upsert(stored('a'));
    const { b, access } = body('text');
    b.receiving = false;
    const deleting: BodyAccess = {
      source: (detail, side) => {
        const s = access.source(detail, side)!;
        return {
          ...s,
          read: async (start, max) => {
            store.delete('a');
            return s.read(start, max);
          },
        };
      },
    };
    const memo = new BodyMemo();
    await matchExchanges(store, 'resbody~text', ['a'], { bodies: deleting, memo });
    expect(memo.size).toBe(0);
  });

  it('a stopped search remembers nothing', async () => {
    const { b, memo } = setup('text');
    b.receiving = false;
    const store = new InMemoryRequestStore();
    store.upsert(stored('a'));
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(
      matchExchanges(store, 'resbody~text', ['a'], {
        bodies: body('text').access,
        memo,
        signal: controller.signal,
      }),
    ).rejects.toThrow('stopped');
    expect(memo.size).toBe(0);
  });

  it('two asks about one body at once make one search, and both get its answer', async () => {
    const store = new InMemoryRequestStore();
    store.upsert(stored('a'));
    const { b, access } = body('arriving text with a word');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let passes = 0;
    const slow: BodyAccess = {
      source: (detail, side) => {
        const s = access.source(detail, side)!;
        return {
          ...s,
          read: async (start, max) => {
            if (start === 0) {
              passes++;
              await gate;
            }
            return s.read(start, max);
          },
        };
      },
    };
    const memo = new BodyMemo();
    const ask = () => matchExchanges(store, 'resbody~word', ['a'], { bodies: slow, memo });
    const first = ask();
    const second = ask();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect(await Promise.all([first, second])).toEqual([['a'], ['a']]);
    expect(passes).toBe(1);
    void b;
  });

  it('if the search it waited for stops, the second ask searches for itself', async () => {
    const store = new InMemoryRequestStore();
    store.upsert(stored('a'));
    const { access } = body('text with a word');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let passes = 0;
    const slow: BodyAccess = {
      source: (detail, side) => {
        const s = access.source(detail, side)!;
        return {
          ...s,
          read: async (start, max) => {
            if (start === 0 && ++passes === 1) await gate;
            return s.read(start, max);
          },
        };
      },
    };
    const memo = new BodyMemo();
    const controller = new AbortController();
    const first = matchExchanges(store, 'resbody~word', ['a'], {
      bodies: slow,
      memo,
      signal: controller.signal,
      sliceMs: 0,
    });
    const second = matchExchanges(store, 'resbody~word', ['a'], { bodies: slow, memo });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('stopped'));
    release();
    await expect(first).rejects.toThrow('stopped');
    expect(await second).toEqual(['a']);
    expect(passes).toBe(2);
  });

  it('an arriving body it can’t decode stays partly searched when answered from the memo', async () => {
    const { b, store, memo } = setup('raw bytes', { encoding: 'x-made-up' });
    const access = await bodyAccessFor(b, 'x-made-up');
    const ask = async () => {
      const partial = new Set<string>();
      await matchExchanges(store, 'resbody~absent', ['a'], { bodies: access, memo, partial, now: () => 0 });
      return [...partial];
    };
    expect(await ask()).toEqual(['a']);
    const reads = b.reads;
    expect(await ask()).toEqual(['a']);
    expect(b.reads).toBe(reads);
  });
});
