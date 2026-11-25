/**
 * The backend's known values for the window's View › Hide Secrets (src/backend/window-known.ts):
 * nothing collected while off, catching up in chunks, pages and pushes numbered in order, a Clear,
 * a full set rebuilt under a new epoch, and what it costs.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExchangeDetail, Header } from '../src/shared/api';
import { UpdateBatcher } from '../src/backend/update-batcher';
import { MAX_PAGE_CHARS, WindowKnown, type KnownSource } from '../src/backend/window-known';

// Fake tokens, made at run time so the file holds nothing a secret scanner flags.
const token = (n: number): string => `Zq9x${n}Tk7Lm2Pw4Rt8Vn6Yb3`;

function exchange(id: string, url: string, headers: Header[] = []): ExchangeDetail {
  return {
    summary: {
      id,
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'a.test',
      path: '/',
      url,
      startedAt: 0,
    },
    requestHeaders: headers,
    timing: {},
  } as ExchangeDetail;
}

/** A store of exchanges, each with a bearer token of its own, and counts of what was read. */
function store(count = 0) {
  const map = new Map<string, ExchangeDetail>();
  for (let i = 0; i < count; i++) {
    map.set(`x${i}`, exchange(`x${i}`, `https://a.test/${i}`, [['authorization', `Bearer ${token(i)}`]]));
  }
  let reads = 0;
  const source: KnownSource = {
    ids: () => [...map.keys()],
    get: (id) => {
      reads += 1;
      return map.get(id);
    },
  };
  return { map, source, reads: () => reads };
}

const idle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Pages from 0 until one says done; the last page. */
async function caughtUp(known: WindowKnown, epoch: string) {
  let page = await known.page(epoch, 0);
  while (!page.done) page = await known.page(epoch, page.next);
  return page;
}

/** The fastest of three runs, in ms. */
function fastest(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('WindowKnown: off', () => {
  it('collects nothing and reads nothing while off', async () => {
    const s = store(100);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    for (const e of s.map.values()) known.collect(e);
    expect(known.take()).toBeUndefined();
    await idle();
    expect(s.reads()).toBe(0);
    expect(known.values).toBeUndefined();
    await expect(known.page(undefined, 0)).rejects.toThrow('aren’t being collected');
  });

  it('drops the set when turned off, and a new epoch when on again', async () => {
    const s = store(3);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    const first = known.watch(true);
    expect(known.watch(true)).toBe(first);
    await known.page(first, 0);
    expect(known.watch(false)).toBeUndefined();
    expect(known.values).toBeUndefined();
    const second = known.watch(true);
    expect(second).not.toBe(first);
  });
});

describe('WindowKnown: catching up', () => {
  it('learns every stored exchange in chunks, and pages say done only once it has', async () => {
    const s = store(3_000);
    const known = new WindowKnown(s.source, { flush: () => undefined, chunkMs: 1 });
    const epoch = known.watch(true)!;
    // Nothing read until the pass's first chunk.
    expect(s.reads()).toBe(0);
    const pages: Array<Awaited<ReturnType<WindowKnown['page']>>> = [];
    let after = 0;
    for (;;) {
      const page = await known.page(epoch, after);
      expect(page.epoch).toBe(epoch);
      expect(page.next).toBe(after + page.values.length);
      pages.push(page);
      after = page.next;
      if (page.done) break;
    }
    expect(after).toBe(3_000);
    expect(new Set(pages.flatMap((p) => p.values))).toEqual(
      new Set(Array.from({ length: 3_000 }, (_, i) => token(i))),
    );
    expect(pages.slice(0, -1).every((p) => !p.done)).toBe(true);
  });

  it('says a page isn’t done while the pass is still going, though it has every value so far', async () => {
    const s = store(50);
    // A clock that moves 10 ms each time it's read: one exchange per chunk.
    let t = 0;
    const known = new WindowKnown(s.source, { flush: () => undefined, clock: () => (t += 10) });
    const epoch = known.watch(true)!;
    for (let i = 0; i < 5; i++) await idle();
    const partial = await known.page(epoch, 0);
    expect(partial.values.length).toBeGreaterThan(0);
    expect(partial.values.length).toBeLessThan(50);
    expect(partial.next).toBe(known.values!.size);
    expect(partial.done).toBe(false);
    const rest = await caughtUp(known, epoch);
    expect(rest.done).toBe(true);
    expect(known.values!.size).toBe(50);
  });

  it('keeps each chunk of catching up short, so the proxy isn’t held up', async () => {
    const s = store(10_000);
    // A clock that moves 1 ms on each read: each exchange learned costs one read, so a 5 ms
    // chunk learns at most a handful before giving the event loop back. Real time on a shared
    // runner is too noisy to measure a stall this small.
    let now = 0;
    const known = new WindowKnown(s.source, { flush: () => undefined, chunkMs: 5, clock: () => now++ });
    // Which turn of the event loop each exchange was learned in.
    let turn = 0;
    let ticking = true;
    // Runs once in each turn's check phase, as each chunk does.
    const tick = (): void => {
      turn += 1;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const perTurn = new Map<number, number>();
    const get = s.source.get;
    s.source.get = (id) => {
      perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
      return get(id);
    };
    const epoch = known.watch(true)!;
    await caughtUp(known, epoch);
    ticking = false;
    expect(known.values!.size).toBe(10_000);
    // Thousands of short chunks, none learning more than its 5 ms allows.
    expect(perTurn.size).toBeGreaterThan(1000);
    expect(Math.max(...perTurn.values())).toBeLessThanOrEqual(10);
  });

  it('learns everything even when a chunk’s time runs out at once', async () => {
    const s = store(50);
    const known = new WindowKnown(s.source, { flush: () => undefined, chunkMs: 0 });
    const epoch = known.watch(true)!;
    await caughtUp(known, epoch);
    expect(known.values!.size).toBe(50);
  });

  it('answers a stale or missing epoch from 0 with the current one', async () => {
    const s = store(5);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    const epoch = known.watch(true)!;
    const first = await known.page(epoch, 0);
    const stale = await known.page('old-epoch', 3);
    expect(stale.epoch).toBe(epoch);
    expect(stale.values).toEqual(first.values);
    expect(stale.next).toBe(first.next);
    await expect(known.page(epoch, 99)).rejects.toThrow('past the values');
  });

  it('pages about 1 MB at a time', async () => {
    const s = store(0);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    const epoch = known.watch(true)!;
    await known.page(epoch, 0);
    // 300 long values of 4,000 characters: 1.2 MB.
    for (let i = 0; i < 300; i++) {
      const value = `${'Ab9'.repeat(1333)}${i}`.slice(-3_990);
      s.map.set(`l${i}`, exchange(`l${i}`, 'https://a.test/', [['x-api-key', `${value}Zz${i}`]]));
      known.collect(s.map.get(`l${i}`)!);
    }
    const one = await known.page(epoch, 0);
    expect(one.values.join('').length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
    expect(one.done).toBe(false);
    const two = await known.page(epoch, one.next);
    expect(two.done).toBe(true);
    expect(one.values.length + two.values.length).toBe(known.values!.size);
  });
});

describe('WindowKnown: pushes', () => {
  it('starts pushing only after a page said done, from its next, numbered in order', async () => {
    const s = store(2);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    const epoch = known.watch(true)!;
    s.map.set(
      'n1',
      exchange('n1', `https://a.test/?q=${token(100)}`, [['authorization', `Bearer ${token(101)}`]]),
    );
    known.collect(s.map.get('n1')!);
    // Not yet: no page has said done.
    expect(known.take()).toBeUndefined();
    const page = await caughtUp(known, epoch);
    expect(known.take()).toBeUndefined();
    s.map.set('n2', exchange('n2', 'https://a.test/', [['authorization', `Bearer ${token(102)}`]]));
    known.collect(s.map.get('n2')!);
    expect(known.take()).toEqual({ epoch, from: page.next, values: [token(102)], full: false });
    // Nothing new: nothing to send.
    expect(known.take()).toBeUndefined();
  });

  it('learns each URL and header list once, by identity, so updates cost nothing', () => {
    const s = store(10_000);
    const all = [...s.map.values()];
    // Learning from 10,000 exchanges the first time, each run with a fresh set.
    const first = fastest(() => {
      const fresh = new WindowKnown(s.source, { flush: () => undefined });
      fresh.watch(true);
      for (const e of all) fresh.collect(e);
      fresh.watch(false);
    });
    const known = new WindowKnown(s.source, { flush: () => undefined });
    known.watch(true);
    for (const e of all) known.collect(e);
    // The same lists again, as streaming updates and badges send them: budget 15 ms for 10,000.
    const again = fastest(() => {
      for (const e of all) known.collect({ ...e, summary: { ...e.summary, responseReceived: 5 } });
    });
    expect(again).toBeLessThan(15);
    expect(again * 5).toBeLessThan(first);
    // Not read at all: a list seen before is skipped by identity.
    let reads = 0;
    const counted = new Proxy<Header[]>([['authorization', `Bearer ${token(30_000)}`]], {
      get: (target, key, receiver) => {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const one = exchange('counted', 'https://a.test/', counted);
    const small = new WindowKnown(store().source, { flush: () => undefined });
    small.watch(true);
    small.collect(one);
    const readsOnce = reads;
    expect(readsOnce).toBeGreaterThan(0);
    small.collect({ ...one, summary: { ...one.summary, responseReceived: 9 } });
    expect(reads).toBe(readsOnce);
    // A new list is learned from: its value is one too many for the set.
    expect(known.values!.full).toBe(false);
    const e = all[0]!;
    known.collect({ ...e, responseHeaders: [['x-echo-token', token(20_000)]] });
    expect(known.values!.full).toBe(true);
  });

  it('puts the values ahead of the summaries they came from, in the same message', async () => {
    const s = store(0);
    const sent: unknown[] = [];
    const known: WindowKnown = new WindowKnown(s.source, { flush: () => batcher.flush() });
    const batcher = new UpdateBatcher(
      (message) => sent.push(message),
      10_000,
      (changed) => {
        for (const summary of changed) {
          const e = s.map.get(summary.id);
          if (e) known.collect(e);
        }
        return known.take();
      },
    );
    const epoch = known.watch(true)!;
    await known.page(epoch, 0);
    const e = exchange('p1', `https://a.test/x/${token(7)}`, [['authorization', `Bearer ${token(7)}`]]);
    s.map.set('p1', e);
    batcher.change(e.summary);
    batcher.flush();
    expect(sent).toHaveLength(1);
    const message = sent[0] as Record<string, unknown>;
    expect(Object.keys(message)).toEqual(['type', 'known', 'exchanges', 'removed']);
    expect(message.known).toEqual({ epoch, from: 0, values: [token(7)], full: false });
    // Off: no `known` at all.
    known.watch(false);
    batcher.change(e.summary);
    batcher.flush();
    expect(sent[1]).not.toHaveProperty('known');
  });

  it('flushes the batcher before answering a page, so what was sent is covered', async () => {
    const s = store(0);
    const flush = vi.fn();
    const known = new WindowKnown(s.source, { flush });
    const epoch = known.watch(true)!;
    await known.page(epoch, 0);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe('WindowKnown: Clear and rebuilds', () => {
  it('starts a new, empty epoch on Clear, pushing on from 0', async () => {
    const s = store(3);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    const epoch = known.watch(true)!;
    const page = await caughtUp(known, epoch);
    s.map.clear();
    known.clear();
    // An exchange arriving before the window hears of the Clear brings its values.
    const e = exchange('c1', 'https://a.test/', [['authorization', `Bearer ${token(50)}`]]);
    s.map.set('c1', e);
    known.collect(e);
    const push = known.take()!;
    expect(push).toMatchObject({ from: 0, values: [token(50)], full: false });
    expect(push.epoch).not.toBe(epoch);
    const after = await known.page(epoch, page.next);
    expect(after).toMatchObject({ epoch: push.epoch, values: [token(50)], next: 1, done: true, full: false });
  });

  it('waits for a page before pushing after a Clear if it wasn’t pushing before', async () => {
    const s = store(0);
    const known = new WindowKnown(s.source, { flush: () => undefined });
    known.watch(true);
    known.clear();
    const e = exchange('c2', 'https://a.test/', [['authorization', `Bearer ${token(51)}`]]);
    known.collect(e);
    expect(known.take()).toBeUndefined();
  });

  it('rebuilds a full set from what’s stored under a new epoch, once enough has gone and a minute passed', async () => {
    let now = 0;
    const s = store(10_050);
    const flushes: string[] = [];
    const known: WindowKnown = new WindowKnown(s.source, {
      flush: () => flushes.push(known.take()?.epoch ?? '-'),
      now: () => now,
    });
    const epoch = known.watch(true)!;
    const page = await caughtUp(known, epoch);
    expect(page.full).toBe(true);
    flushes.length = 0;
    // 1,000 leave the store, but it's been under a minute: no rebuild.
    for (let i = 0; i < 1_000; i++) {
      s.map.delete(`x${i}`);
      known.forget(`x${i}`);
    }
    now = 59_000;
    known.take();
    for (let i = 0; i < 50; i++) await idle();
    expect(flushes).toEqual([]);
    // A minute on: rebuilt in the background, then the epoch switches after a flush.
    now = 61_000;
    known.take();
    for (let i = 0; i < 200 && flushes.length < 2; i++) await idle();
    expect(flushes).toHaveLength(2);
    expect(known.take()).toBeUndefined();
    const rebuilt = await known.page(epoch, 0);
    expect(rebuilt.epoch).not.toBe(epoch);
    // The second flush announced it: from the new set's end.
    expect(flushes[1]).toBe(rebuilt.epoch);
    // Built from what's left: the gone exchanges' tokens aren't in it, the rest are.
    expect(known.values!.size).toBe(9_050);
    expect(known.values!.full).toBe(false);
    expect(known.values!.scan(`a ${token(5)} b`)).toEqual([]);
    expect(known.values!.scan(`a ${token(5_000)} b`)).toHaveLength(1);
  });

  it('doesn’t rebuild a full set before 1,000 exchanges have gone, however long it waits', async () => {
    let now = 0;
    const s = store(10_050);
    const flush = vi.fn();
    const known = new WindowKnown(s.source, { flush, now: () => now });
    const epoch = known.watch(true)!;
    const page = await caughtUp(known, epoch);
    expect(page.full).toBe(true);
    for (let i = 0; i < 999; i++) known.forget(`x${i}`);
    now = 10 * 60_000;
    const calls = flush.mock.calls.length;
    known.take();
    for (let i = 0; i < 20; i++) await idle();
    expect(flush.mock.calls.length).toBe(calls);
    expect((await known.page(epoch, page.next)).epoch).toBe(epoch);
  });

  it('doesn’t rebuild a set that isn’t full', async () => {
    let now = 0;
    const s = store(1_500);
    const flush = vi.fn();
    const known = new WindowKnown(s.source, { flush, now: () => now });
    const epoch = known.watch(true)!;
    const page = await caughtUp(known, epoch);
    for (let i = 0; i < 1_200; i++) known.forget(`x${i}`);
    now = 120_000;
    const calls = flush.mock.calls.length;
    known.take();
    for (let i = 0; i < 20; i++) await idle();
    expect(flush.mock.calls.length).toBe(calls);
    expect((await known.page(epoch, page.next)).epoch).toBe(epoch);
  });
});
