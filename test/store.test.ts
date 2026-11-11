/**
 * The exchange store's limit (src/backend/store.ts): the oldest finished exchange goes first, so a
 * long stream or open WebSocket that started early isn't dropped while it's still going.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeDetail, ExchangeSummary } from '../src/shared/api';
import { InMemoryRequestStore, isLive, LIVE_SCAN_LIMIT } from '../src/backend/store';

const exchange = (id: string, summary: Partial<ExchangeSummary> = {}): ExchangeDetail => ({
  summary: {
    id,
    method: 'POST',
    protocol: 'https',
    httpVersion: '2.0',
    host: 'api.test',
    path: `/${id}`,
    url: `https://api.test/${id}`,
    startedAt: 0,
    ...summary,
  },
  requestHeaders: [],
  timing: { startTimestamp: 0 },
});
const finished = (id: string) => exchange(id, { status: 200, durationMs: 5 });
const live = (id: string) => exchange(id, { status: 200 });

describe('which exchanges are still going', () => {
  it('counts a request with no response yet, or one still arriving', () => {
    expect(isLive(exchange('a').summary)).toBe(true);
    expect(isLive(live('a').summary)).toBe(true);
    // Headers in, body still arriving.
    expect(isLive(exchange('r', { status: 200, responding: true, responseReceived: 5 }).summary)).toBe(true);
  });

  it('counts an open WebSocket, not a closed one', () => {
    expect(isLive(exchange('w', { websocket: true, status: 101 }).summary)).toBe(true);
    expect(isLive(exchange('w', { websocket: true, closeCode: 1000 }).summary)).toBe(false);
    // Closed abnormally, with no close code.
    expect(isLive(exchange('w', { websocket: true, status: 101, durationMs: 900 }).summary)).toBe(false);
  });

  it("doesn't count finished, failed or imported exchanges", () => {
    expect(isLive(finished('a').summary)).toBe(false);
    expect(
      isLive(
        exchange('f', { failure: { kind: 'reset', code: 'ECONNRESET', message: 'x' } as never }).summary,
      ),
    ).toBe(false);
    expect(isLive(exchange('i', { imported: true }).summary)).toBe(false);
  });
});

describe('the store when full', () => {
  const ids = (store: InMemoryRequestStore) => store.list().map((s) => s.id);

  it('drops the oldest finished exchange, keeping an older one still going', () => {
    const dropped: string[] = [];
    const store = new InMemoryRequestStore(3, (id) => dropped.push(id));
    store.upsert(live('stream'));
    store.upsert(finished('b'));
    store.upsert(finished('c'));
    store.upsert(finished('d'));
    expect(ids(store)).toEqual(['stream', 'c', 'd']);
    expect(dropped).toEqual(['b']);
  });

  it('drops the oldest as before when it has finished', () => {
    const dropped: string[] = [];
    const store = new InMemoryRequestStore(2, (id) => dropped.push(id));
    store.upsert(finished('a'));
    store.upsert(live('b'));
    store.upsert(live('c'));
    expect(ids(store)).toEqual(['b', 'c']);
    expect(dropped).toEqual(['a']);
  });

  it('drops a stream once it has finished, by its place in the list', () => {
    const store = new InMemoryRequestStore(2);
    store.upsert(live('stream'));
    store.upsert(finished('b'));
    // The stream ends: updating it keeps its place, the oldest.
    store.upsert(finished('stream'));
    store.upsert(finished('c'));
    expect(ids(store)).toEqual(['b', 'c']);
  });

  it('drops the oldest anyway when everything is still going', () => {
    const dropped: string[] = [];
    const store = new InMemoryRequestStore(2, (id) => dropped.push(id));
    store.upsert(live('a'));
    store.upsert(live('b'));
    store.upsert(live('c'));
    expect(ids(store)).toEqual(['b', 'c']);
    expect(dropped).toEqual(['a']);
  });

  it(`looks only ${LIVE_SCAN_LIMIT} back, so many calls that never end can't make it slow`, () => {
    const dropped: string[] = [];
    const store = new InMemoryRequestStore(LIVE_SCAN_LIMIT + 1, (id) => dropped.push(id));
    for (let i = 0; i < LIVE_SCAN_LIMIT; i++) store.upsert(live(`live-${i}`));
    store.upsert(finished('just-past'));
    store.upsert(finished('new'));
    // The finished one is past the scan, so the oldest live one goes.
    expect(dropped).toEqual(['live-0']);
    expect(ids(store)).toContain('just-past');
  });

  it('drops strictly the oldest when asked to (a HAR import counts on it)', () => {
    const dropped: string[] = [];
    const store = new InMemoryRequestStore(2, (id) => dropped.push(id));
    store.upsert(live('stream'));
    store.upsert(finished('b'));
    store.upsert(finished('imported'), { keepLive: false });
    expect(dropped).toEqual(['stream']);
    expect(ids(store)).toEqual(['b', 'imported']);
  });

  it('drops nothing when an exchange is only updated', () => {
    const dropped: string[] = [];
    const store = new InMemoryRequestStore(2, (id) => dropped.push(id));
    store.upsert(finished('a'));
    store.upsert(live('b'));
    store.upsert(finished('b'));
    expect(dropped).toEqual([]);
    expect(store.size).toBe(2);
  });
});
