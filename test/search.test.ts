/**
 * The backend's search (src/backend/search.ts): matching the whole query against stored
 * exchanges, among some ids or all, in slices that let the proxy run.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeDetail, Header } from '../src/shared/api';
import { MAX_QUERY_LENGTH } from '../src/shared/query';
import { matchExchanges } from '../src/backend/search';
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
});
