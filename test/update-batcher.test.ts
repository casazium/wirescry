import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { InMemoryRequestStore } from '../src/backend/store';
import { UpdateBatcher } from '../src/backend/update-batcher';

const summary = (id: string, status?: number): ExchangeSummary => ({
  id,
  method: 'GET',
  protocol: 'https',
  httpVersion: '2',
  host: 'example.com',
  path: '/',
  url: 'https://example.com/',
  startedAt: 0,
  status,
});

describe('UpdateBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the latest version of each exchange once per batch', () => {
    const sent = vi.fn();
    const batcher = new UpdateBatcher(sent, 50);
    batcher.change(summary('a'));
    batcher.change(summary('b'));
    batcher.change(summary('a', 200));
    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(sent).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith({
      type: 'exchanges',
      exchanges: [summary('a', 200), summary('b')],
      removed: [],
    });
  });

  it('reports removals and drops pending changes for removed exchanges', () => {
    const sent = vi.fn();
    const batcher = new UpdateBatcher(sent, 50);
    batcher.change(summary('a'));
    batcher.remove('a');
    vi.advanceTimersByTime(50);
    expect(sent).toHaveBeenCalledWith({ type: 'exchanges', exchanges: [], removed: ['a'] });
  });

  it('sends nothing after reset', () => {
    const sent = vi.fn();
    const batcher = new UpdateBatcher(sent, 50);
    batcher.change(summary('a'));
    batcher.reset();
    vi.advanceTimersByTime(100);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('InMemoryRequestStore', () => {
  it('evicts the oldest exchange past its limit and reports it', () => {
    const evicted: string[] = [];
    const store = new InMemoryRequestStore(2, (id) => evicted.push(id));
    for (const id of ['a', 'b', 'c']) {
      store.upsert({ summary: summary(id), requestHeaders: [], timing: { startTimestamp: 0 } });
    }
    expect(evicted).toEqual(['a']);
    expect(store.list().map((e) => e.id)).toEqual(['b', 'c']);
  });
});
