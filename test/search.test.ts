/**
 * The backend's search (src/backend/search.ts): matching the whole query against stored
 * exchanges, among some ids or all, in slices that let the proxy run.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeDetail, Header } from '../src/shared/api';
import { MAX_QUERY_LENGTH } from '../src/shared/query';
import { checkSearchId, matchExchanges, SearchStopped } from '../src/backend/search';
import { InMemoryRequestStore } from '../src/backend/store';

function stored(id: string, request: Header[], response?: Header[], host = 'api.test'): ExchangeDetail {
  return {
    summary: {
      id,
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host,
      path: `/${id}`,
      url: `https://${host}/${id}`,
      startedAt: 0,
      ...(response ? { status: 200 } : {}),
    },
    requestHeaders: request,
    ...(response ? { responseHeaders: response } : {}),
    timing: { startTimestamp: 0 },
  };
}

function storeOf(...exchanges: ExchangeDetail[]): InMemoryRequestStore {
  const store = new InMemoryRequestStore();
  for (const e of exchanges) store.upsert(e);
  return store;
}

const store = storeOf(
  stored('a', [['x-test', '1']], [['x-cache', 'hit']]),
  stored('b', [['x-test', '2']], [['x-cache', 'miss']]),
  stored('c', [['authorization', 'Bearer t']]),
  stored('d', [['x-test', '1']], undefined, 'cdn.test'),
);

describe('matchExchanges', () => {
  it('matches header terms over every exchange', async () => {
    expect(await matchExchanges(store, 'reqheader.x-test=1')).toEqual(['a', 'd']);
    expect(await matchExchanges(store, 'resheader.x-cache=*')).toEqual(['a', 'b']);
    expect(await matchExchanges(store, 'header~bearer')).toEqual(['c']);
    expect(await matchExchanges(store, '-header.x-test=*')).toEqual(['c']);
  });

  it('matches the summary terms too', async () => {
    expect(await matchExchanges(store, 'host=cdn.* header.x-test=1')).toEqual(['d']);
    expect(await matchExchanges(store, 'host=api.* header.x-test=1')).toEqual(['a']);
    expect(await matchExchanges(store, 'header.x-test=1 nothing-matches-this')).toEqual([]);
  });

  it('looks only among the ids given, skipping ones no longer stored', async () => {
    expect(await matchExchanges(store, 'header.x-test=1', ['d', 'gone', 'b'])).toEqual(['d']);
    expect(await matchExchanges(store, 'header.x-test=1', [])).toEqual([]);
  });

  it('refuses a search over the length limit', async () => {
    await expect(matchExchanges(store, 'x'.repeat(MAX_QUERY_LENGTH + 1))).rejects.toThrow('too long');
    await expect(matchExchanges(store, `header~x ${'a'.repeat(MAX_QUERY_LENGTH - 9)}`)).resolves.toEqual([]);
  });

  it('yields between slices of work, and finds the same matches', async () => {
    const many = new InMemoryRequestStore();
    for (let i = 0; i < 50; i++) many.upsert(stored(`e${i}`, [['x-n', String(i % 5)]]));
    let clock = 0;
    let yields = 0;
    const found = await matchExchanges(many, 'header.x-n=3', undefined, {
      sliceMs: 10,
      // Every exchange takes 1 "millisecond", so a slice is 10 of them.
      now: () => clock++,
      yieldNow: async () => {
        yields++;
      },
    });
    expect(found).toEqual(['e3', 'e8', 'e13', 'e18', 'e23', 'e28', 'e33', 'e38', 'e43', 'e48']);
    expect(yields).toBeGreaterThanOrEqual(4);
  });

  it('lets a timer run while a long search is under way', async () => {
    const big = new InMemoryRequestStore();
    const value = 'v'.repeat(32 * 1024);
    for (let i = 0; i < 400; i++) {
      big.upsert(
        stored(
          `e${i}`,
          Array.from({ length: 8 }, (_, j): Header => [`x-h${j}`, value]),
        ),
      );
    }
    let timerRanDuring = false;
    let done = false;
    setTimeout(() => {
      if (!done) timerRanDuring = true;
    }, 0);
    const found = await matchExchanges(big, 'header~not-in-there', undefined, { sliceMs: 1 });
    done = true;
    expect(found).toEqual([]);
    expect(timerRanDuring).toBe(true);
  });

  it('a newly stored exchange is found by the next search', async () => {
    const live = storeOf(stored('a', [['x-test', '1']]));
    expect(await matchExchanges(live, 'header.x-test=1')).toEqual(['a']);
    live.upsert(stored('a', [['x-test', '2']]));
    live.upsert(stored('b', [['x-test', '1']]));
    expect(await matchExchanges(live, 'header.x-test=1')).toEqual(['b']);
  });

  describe('while the store changes during a search', () => {
    /** A search that yields after every exchange, running `during` at the first yield. */
    const search = (target: InMemoryRequestStore, query: string, during: () => void, ids?: string[]) => {
      let first = true;
      let tick = 0;
      return matchExchanges(target, query, ids, {
        sliceMs: 1,
        now: () => tick++,
        yieldNow: async () => {
          if (first) {
            first = false;
            during();
          }
        },
      });
    };
    const fresh = () =>
      storeOf(stored('a', [['x-t', '1']]), stored('b', [['x-t', '1']]), stored('c', [['x-t', '1']]));

    it('skips an exchange deleted before its turn', async () => {
      const live = fresh();
      expect(await search(live, 'header.x-t=1', () => live.delete('c'))).toEqual(['a', 'b']);
    });

    it('returns only what matched before a clear, without throwing', async () => {
      const live = fresh();
      expect(await search(live, 'header.x-t=1', () => live.clear())).toEqual(['a']);
    });

    it('leaves out an exchange added meanwhile (its batch asks about it)', async () => {
      const live = fresh();
      expect(await search(live, 'header.x-t=1', () => live.upsert(stored('d', [['x-t', '1']])))).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('judges an exchange changed before its turn on its latest headers', async () => {
      const live = fresh();
      expect(await search(live, 'header.x-t=1', () => live.upsert(stored('c', [['x-t', '2']])))).toEqual([
        'a',
        'b',
      ]);
      const again = fresh();
      again.upsert(stored('c', [['x-t', '2']]));
      expect(await search(again, 'header.x-t=1', () => again.upsert(stored('c', [['x-t', '1']])))).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  it('doesn’t yield at all for a quick search', async () => {
    let yields = 0;
    await matchExchanges(store, 'header.x-test=1', undefined, {
      yieldNow: async () => {
        yields++;
      },
    });
    expect(yields).toBe(0);
  });

  it('searches a full store of ordinary exchanges in good time', async () => {
    const full = new InMemoryRequestStore();
    const headers: Header[] = Array.from({ length: 20 }, (_, i) => [
      `x-header-${i}`,
      `value ${i} `.repeat(8),
    ]);
    for (let i = 0; i < 10_000; i++) full.upsert(stored(`e${i}`, [...headers, ['x-n', String(i)]], headers));
    const started = performance.now();
    expect(await matchExchanges(full, 'header.x-n=9999')).toEqual(['e9999']);
    expect(await matchExchanges(full, 'header~not-there')).toEqual([]);
    // About 100 ms here; generous for slow CI machines.
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('runs two searches at once, each answering its own question', async () => {
    const many = new InMemoryRequestStore();
    for (let i = 0; i < 40; i++) many.upsert(stored(`e${i}`, [['x-n', String(i % 2)]]));
    let tick = 0;
    const options = { sliceMs: 3, now: () => tick++ };
    const [even, odd] = await Promise.all([
      matchExchanges(many, 'header.x-n=0', undefined, options),
      matchExchanges(many, 'header.x-n=1', undefined, options),
    ]);
    expect(even).toEqual(Array.from({ length: 20 }, (_, i) => `e${i * 2}`));
    expect(odd).toEqual(Array.from({ length: 20 }, (_, i) => `e${i * 2 + 1}`));
  });

  it('answers in the order of the ids given, each once; in store order without them', async () => {
    expect(await matchExchanges(store, 'header.x-test=*', ['d', 'b', 'a'])).toEqual(['d', 'b', 'a']);
    expect(await matchExchanges(store, 'header.x-test=*', ['a', 'a', 'd', 'a'])).toEqual(['a', 'd']);
    expect(await matchExchanges(store, 'header.x-test=*')).toEqual(['a', 'b', 'd']);
  });

  it('matches everything for an empty search, as the list does', async () => {
    expect(await matchExchanges(store, '')).toEqual(['a', 'b', 'c', 'd']);
    // Terms with errors are dropped, as in the list: what's left is empty.
    expect(await matchExchanges(store, 'header=x')).toEqual(['a', 'b', 'c', 'd']);
    expect(await matchExchanges(store, 'header=x host=cdn.*')).toEqual(['d']);
  });

  describe('stopping', () => {
    const many = () => {
      const target = new InMemoryRequestStore();
      for (let i = 0; i < 30; i++) target.upsert(stored(`e${i}`, [['x-n', String(i)]]));
      return target;
    };

    it('throws the reason when stopped before it starts', async () => {
      const controller = new AbortController();
      controller.abort(new SearchStopped('canceled'));
      await expect(
        matchExchanges(store, 'header~x', undefined, { signal: controller.signal }),
      ).rejects.toMatchObject({
        reason: 'canceled',
      });
    });

    it('stops at the next exchange after a yield, with the reason given', async () => {
      const controller = new AbortController();
      let tick = 0;
      let looked = 0;
      const target = many();
      const real = target.get.bind(target);
      target.get = (id) => {
        looked++;
        return real(id);
      };
      const search = matchExchanges(target, 'header.x-n=*', undefined, {
        signal: controller.signal,
        sliceMs: 5,
        now: () => tick++,
        yieldNow: async () => {
          controller.abort(new SearchStopped('cleared'));
        },
      });
      await expect(search).rejects.toBeInstanceOf(SearchStopped);
      await expect(search).rejects.toMatchObject({ reason: 'cleared' });
      // It stopped soon after the first slice, not after reading all 30.
      expect(looked).toBeLessThan(10);
    });

    it('stopped after its last exchange, it still throws rather than answer', async () => {
      const controller = new AbortController();
      let tick = 0;
      const search = matchExchanges(storeOf(stored('a', [['x-t', '1']])), 'header~x', undefined, {
        signal: controller.signal,
        sliceMs: 1,
        now: () => tick++,
        yieldNow: async () => {
          controller.abort(new SearchStopped('closed'));
        },
      });
      await expect(search).rejects.toMatchObject({ reason: 'closed' });
    });

    it('a signal that never aborts changes nothing', async () => {
      const controller = new AbortController();
      expect(await matchExchanges(many(), 'header.x-n=2*', undefined, { signal: controller.signal })).toEqual(
        ['e2', 'e20', 'e21', 'e22', 'e23', 'e24', 'e25', 'e26', 'e27', 'e28', 'e29'],
      );
    });
  });

  it('checkSearchId takes 1 to 64 characters of text, and nothing else', () => {
    expect(() => checkSearchId('a')).not.toThrow();
    expect(() => checkSearchId('x'.repeat(64))).not.toThrow();
    for (const bad of ['', 'x'.repeat(65), 1, null, undefined, {}, ['a']]) {
      expect(() => checkSearchId(bad)).toThrow('searchId must be text of 1 to 64 characters');
    }
  });
});
