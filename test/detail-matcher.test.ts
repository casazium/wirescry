/**
 * The UI's record of which exchanges match a search's header terms
 * (src/renderer/src/detail-matcher.ts): full answers, answers for batches, answers that come
 * back out of order, and starting over.
 */
import { describe, expect, it } from 'vitest';
import { DetailMatcher, MAX_BATCH_IDS, type DetailMatchState } from '../src/renderer/src/detail-matcher';
import { deferred } from './ui/fixtures';

interface Asked {
  query: string;
  ids?: string[];
  answer(ids: string[]): Promise<void>;
  fail(): Promise<void>;
}

function setup() {
  const asked: Asked[] = [];
  const states: DetailMatchState[] = [];
  const matcher = new DetailMatcher((state) => states.push(state));
  matcher.connect((query, ids) => {
    const reply = deferred<string[]>();
    asked.push({
      query,
      ...(ids ? { ids } : {}),
      answer: async (matched) => {
        reply.resolve(matched);
        await Promise.resolve();
        await Promise.resolve();
      },
      fail: async () => {
        reply.reject(new Error('Disconnected'));
        await Promise.resolve();
        await Promise.resolve();
      },
    });
    return reply.promise;
  });
  const shown = (): { applied?: string; matches: string[] } => {
    const s = matcher.state();
    return { applied: s.applied, matches: [...s.matches].sort() };
  };
  return { matcher, asked, states, shown };
}

describe('DetailMatcher', () => {
  it('asks for every exchange when a search is set, and applies the answer', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ query: 'header~a' });
    expect(asked[0]!.ids).toBeUndefined();
    // Nothing applied until it answers.
    expect(shown()).toEqual({ applied: undefined, matches: [] });
    await asked[0]!.answer(['1', '2']);
    expect(shown()).toEqual({ applied: 'header~a', matches: ['1', '2'] });
  });

  it('keeps the previous search in force until the new one is answered', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1']);
    matcher.setQuery('header~b');
    expect(shown()).toEqual({ applied: 'header~a', matches: ['1'] });
    await asked[1]!.answer(['2']);
    expect(shown()).toEqual({ applied: 'header~b', matches: ['2'] });
  });

  it('drops the answer to a search that has since changed', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.setQuery('header~b');
    await asked[1]!.answer(['2']);
    await asked[0]!.answer(['1']);
    expect(shown()).toEqual({ applied: 'header~b', matches: ['2'] });
  });

  it('does nothing for the same search again, and clears for none', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.setQuery('header~a');
    expect(asked).toHaveLength(1);
    await asked[0]!.answer(['1']);
    matcher.setQuery(undefined);
    expect(shown()).toEqual({ applied: undefined, matches: [] });
    // A batch with no search asks nothing.
    matcher.onBatch(['3'], []);
    expect(asked).toHaveLength(1);
  });

  it('asks about a batch’s ids, adding and removing by the answer', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1', '2']);
    matcher.onBatch(['2', '3', '4'], []);
    expect(asked[1]).toMatchObject({ query: 'header~a', ids: ['2', '3', '4'] });
    // Until answered: 2 stays (already matching), 3 and 4 stay hidden.
    expect(shown().matches).toEqual(['1', '2']);
    await asked[1]!.answer(['3']);
    // Applied as a change, not a replacement: 1 wasn't asked about and stays.
    expect(shown().matches).toEqual(['1', '3']);
  });

  it('lets only the latest question about an exchange decide', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer([]);
    matcher.onBatch(['1'], []);
    matcher.onBatch(['1'], []);
    // The later question is answered first; the earlier, stale answer must not undo it.
    await asked[2]!.answer(['1']);
    await asked[1]!.answer([]);
    expect(shown().matches).toEqual(['1']);
  });

  it('keeps a batch’s answer that came before the full answer it overlaps', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.onBatch(['5'], []);
    // The batch's answer first, then the full one, computed before 5 changed.
    await asked[1]!.answer(['5']);
    await asked[0]!.answer(['1']);
    expect(shown().matches).toEqual(['1', '5']);
  });

  it('lets a batch’s later answer override the full answer about the same exchange', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.onBatch(['1'], []);
    await asked[0]!.answer(['1', '2']);
    // 1 waits for its own answer.
    expect(shown().matches).toEqual(['2']);
    await asked[1]!.answer([]);
    expect(shown().matches).toEqual(['2']);
  });

  it('takes removed ids out at once', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1', '2']);
    matcher.onBatch([], ['1']);
    expect(asked).toHaveLength(1);
    expect(shown().matches).toEqual(['2']);
  });

  it('leaves out of a full answer the exchanges removed while it was worked out', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.onBatch([], ['1']);
    // Worked out before 1 was removed, so it still lists it.
    await asked[0]!.answer(['1', '2']);
    expect(shown().matches).toEqual(['2']);
    // A later full ask starts afresh: 1 isn't remembered as gone for ever.
    matcher.setQuery('header~b');
    await asked[1]!.answer(['1']);
    expect(shown().matches).toEqual(['1']);
  });

  it('leaves out every exchange of a full answer worked out before a Clear', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.clear();
    // New after the Clear: asked about by id.
    matcher.onBatch(['3'], []);
    await asked[0]!.answer(['1', '2', '3']);
    expect(shown()).toEqual({ applied: 'header~a', matches: [] });
    await asked[1]!.answer(['3']);
    expect(shown().matches).toEqual(['3']);
  });

  it('takes removed ids out of a search still waiting for its answer', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer([]);
    matcher.setQuery('header~b');
    matcher.onBatch(['5'], []);
    await asked[2]!.answer(['5']);
    matcher.onBatch([], ['5']);
    await asked[1]!.answer([]);
    expect(shown()).toEqual({ applied: 'header~b', matches: [] });
  });

  it('takes removed ids out of the search still shown while a new one is answered', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1', '2']);
    matcher.setQuery('header~b');
    matcher.onBatch([], ['1']);
    expect(shown()).toEqual({ applied: 'header~a', matches: ['2'] });
  });

  it('asks in full instead for a very large batch', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1']);
    matcher.onBatch(
      Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `n${i}`),
      [],
    );
    expect(asked[1]!.ids).toBeUndefined();
    await asked[1]!.answer(['1', 'n7']);
    expect(shown().matches).toEqual(['1', 'n7']);
    // A batch just at the limit still asks by id.
    matcher.onBatch(
      Array.from({ length: MAX_BATCH_IDS }, (_, i) => `m${i}`),
      [],
    );
    expect(asked[2]!.ids).toHaveLength(MAX_BATCH_IDS);
  });

  it('empties on Clear', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1']);
    matcher.clear();
    expect(shown()).toEqual({ applied: 'header~a', matches: [] });
  });

  it('asks again in full on a new connection, keeping the old answer until then', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['old-1']);
    matcher.onBatch(['old-2'], []);
    // The connection drops: what was asked on it fails.
    await asked[1]!.fail();
    matcher.restart();
    expect(asked[2]).toMatchObject({ query: 'header~a' });
    expect(asked[2]!.ids).toBeUndefined();
    expect(shown().matches).toEqual(['old-1']);
    await asked[2]!.answer(['new-1']);
    // Rows from before (old-1) don't match any more: the new backend didn't list them.
    expect(shown()).toEqual({ applied: 'header~a', matches: ['new-1'] });
  });

  it('a failed full ask leaves the previous state, and a new connection asks again', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.fail();
    expect(shown()).toEqual({ applied: undefined, matches: [] });
    matcher.restart();
    await asked[1]!.answer(['1']);
    expect(shown()).toEqual({ applied: 'header~a', matches: ['1'] });
  });

  it('refuses to ask with no connection, and recovers on restart', async () => {
    const { matcher, asked, shown } = setup();
    matcher.connect(undefined);
    matcher.setQuery('header~a');
    await Promise.resolve();
    expect(asked).toHaveLength(0);
    expect(shown().applied).toBeUndefined();
    matcher.connect((query) => {
      asked.push({ query, answer: async () => undefined, fail: async () => undefined });
      return Promise.resolve(['9']);
    });
    matcher.restart();
    await Promise.resolve();
    await Promise.resolve();
    expect(shown()).toEqual({ applied: 'header~a', matches: ['9'] });
  });

  it('a restart with no search asks nothing', () => {
    const { matcher, asked } = setup();
    matcher.restart();
    expect(asked).toHaveLength(0);
  });

  it('tells the UI each time what it shows changes', async () => {
    const { matcher, asked, states } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1']);
    matcher.onBatch(['2'], []);
    await asked[1]!.answer(['2']);
    expect(states.map((s) => s.version)).toEqual([1, 2]);
    expect([...states[1]!.matches].sort()).toEqual(['1', '2']);
  });
});
