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
  failWith(message: string): Promise<void>;
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
      failWith: async (message: string) => {
        reply.reject(new Error(message));
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

  it('ignores a batch’s answer that comes after a later full answer', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer([]);
    matcher.onBatch(['x'], []);
    // A big batch with x in it: asked in full.
    matcher.onBatch(['x', ...Array.from({ length: MAX_BATCH_IDS }, (_, i) => `n${i}`)], []);
    expect(asked[2]!.ids).toBeUndefined();
    await asked[2]!.answer(['x']);
    expect(shown().matches).toEqual(['x']);
    // The earlier, smaller question's answer arrives last: the full answer stands.
    await asked[1]!.answer([]);
    expect(shown().matches).toEqual(['x']);
  });

  it('handles a large batch that also removes exchanges', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['old', 'kept']);
    matcher.onBatch(
      Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `n${i}`),
      ['old'],
    );
    expect(shown().matches).toEqual(['kept']);
    // Asked after old was removed, so the backend doesn't list it.
    await asked[1]!.answer(['kept', 'n3']);
    expect(shown().matches).toEqual(['kept', 'n3']);
  });

  it('starts afresh about removed ids with each full request', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1']);
    // Removed with no full request waiting: nothing to remember.
    matcher.onBatch([], ['1']);
    // A later full request may list 1 again (say an exchange came back with that id): it counts.
    matcher.onBatch(
      Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `n${i}`),
      [],
    );
    await asked[1]!.answer(['1']);
    expect(shown().matches).toEqual(['1']);
  });

  it('shows why when the backend refuses a search, instead of waiting for ever', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    await asked[0]!.answer(['1']);
    matcher.setQuery('header~b');
    const reply = asked[1]!;
    await reply.failWith('The search is too long');
    expect(shown()).toEqual({ applied: 'header~b', matches: [] });
    expect(matcher.state().error).toBe('The search is too long');
    // A search that works clears it.
    matcher.setQuery('header~c');
    await asked[2]!.answer(['2']);
    expect(matcher.state().error).toBeUndefined();
    expect(shown()).toEqual({ applied: 'header~c', matches: ['2'] });
  });

  it('asks afresh for a search set again after none, dropping the first answer', async () => {
    const { matcher, asked, shown } = setup();
    matcher.setQuery('header~a');
    matcher.setQuery(undefined);
    matcher.setQuery('header~a');
    expect(asked).toHaveLength(2);
    await asked[0]!.answer(['stale']);
    expect(shown().applied).toBeUndefined();
    await asked[1]!.answer(['fresh']);
    expect(shown()).toEqual({ applied: 'header~a', matches: ['fresh'] });
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
      asked.push({
        query,
        answer: async () => undefined,
        fail: async () => undefined,
        failWith: async () => undefined,
      });
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

  describe('more orderings', () => {
    const big = (prefix: string) => Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `${prefix}${i}`);

    it('a batch ask that fails changes nothing, sets no error, and later batches still work', async () => {
      const { matcher, asked, shown } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.answer(['1']);
      matcher.onBatch(['2'], []);
      await asked[1]!.failWith('Something went wrong');
      expect(shown().matches).toEqual(['1']);
      expect(matcher.state().error).toBeUndefined();
      matcher.onBatch(['3'], []);
      await asked[2]!.answer(['3']);
      expect(shown().matches).toEqual(['1', '3']);
    });

    it('drops an old full answer that arrives after a restart with the same search', async () => {
      const { matcher, asked, shown } = setup();
      matcher.setQuery('header~a');
      matcher.restart();
      await asked[1]!.answer(['new']);
      await asked[0]!.answer(['old']);
      expect(shown().matches).toEqual(['new']);
    });

    it('with two full asks out, only the later one counts, whichever comes first', async () => {
      for (const order of [
        [0, 1],
        [1, 0],
      ]) {
        const { matcher, asked, shown } = setup();
        matcher.setQuery('header~a');
        await asked[0]!.answer([]);
        matcher.onBatch(big('n'), []);
        matcher.onBatch(big('m'), []);
        const answers = [() => asked[1]!.answer(['first']), () => asked[2]!.answer(['second'])];
        for (const i of order) await answers[i]!();
        expect(shown().matches).toEqual(['second']);
      }
    });

    it('a Clear while a batch ask is out: its answer adds nothing', async () => {
      const { matcher, asked, shown } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.answer([]);
      matcher.onBatch(['1'], []);
      matcher.clear();
      await asked[1]!.answer(['1']);
      expect(shown().matches).toEqual([]);
    });

    it('an id removed while its batch ask is out isn’t added back', async () => {
      const { matcher, asked, shown } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.answer([]);
      matcher.onBatch(['1'], []);
      matcher.onBatch([], ['1']);
      await asked[1]!.answer(['1']);
      expect(shown().matches).toEqual([]);
    });

    it('no search any more: answers still out are dropped, and nothing is reported', async () => {
      const { matcher, asked, states, shown } = setup();
      matcher.setQuery('header~a');
      matcher.onBatch(['1'], []);
      matcher.setQuery(undefined);
      const before = states.length;
      await asked[0]!.answer(['1']);
      await asked[1]!.answer(['1']);
      expect(states).toHaveLength(before);
      expect(shown()).toEqual({ applied: undefined, matches: [] });
    });

    it('reports nothing when nothing shown changes', async () => {
      const { matcher, asked, states } = setup();
      matcher.setQuery('header~a');
      // A batch answer before the first full answer: nothing applied yet.
      matcher.onBatch(['1'], []);
      await asked[1]!.answer(['1']);
      matcher.clear();
      matcher.onBatch([], ['1']);
      expect(states).toHaveLength(0);
    });

    it('a batch answer for a pending search doesn’t touch the one shown', async () => {
      const { matcher, asked, shown } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.answer(['1']);
      matcher.setQuery('header~b');
      matcher.onBatch(['2'], []);
      await asked[2]!.answer(['2']);
      expect(shown()).toEqual({ applied: 'header~a', matches: ['1'] });
    });

    it('says it’s pending while a search is asked afresh, and not otherwise', async () => {
      const { matcher, asked } = setup();
      expect(matcher.state().pending).toBe(false);
      matcher.setQuery('header~a');
      expect(matcher.state().pending).toBe(true);
      await asked[0]!.answer([]);
      expect(matcher.state().pending).toBe(false);
      // A big batch asks in full but isn't a new search.
      matcher.onBatch(big('n'), []);
      expect(matcher.state().pending).toBe(false);
      matcher.restart();
      expect(matcher.state().pending).toBe(true);
      await asked[2]!.answer([]);
      expect(matcher.state().pending).toBe(false);
      matcher.setQuery(undefined);
      expect(matcher.state().pending).toBe(false);
    });

    it('tells the UI when a search becomes pending while another is shown', async () => {
      const { matcher, asked, states } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.answer([]);
      matcher.restart();
      expect(states.at(-1)).toMatchObject({ applied: 'header~a', pending: true });
    });
  });

  describe('after the backend refuses a search', () => {
    it('shows no rows beside the error: batch answers are ignored', async () => {
      const { matcher, asked, shown } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.failWith('Something went wrong');
      matcher.onBatch(['1'], []);
      await asked[1]!.answer(['1']);
      expect(shown().matches).toEqual([]);
      expect(matcher.state().error).toBe('Something went wrong');
    });

    it('a later full answer clears the error, from a big batch or a restart', async () => {
      const { matcher, asked } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.failWith('Something went wrong');
      matcher.onBatch(
        Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `n${i}`),
        [],
      );
      await asked[1]!.answer(['n1']);
      expect(matcher.state().error).toBeUndefined();
      expect([...matcher.state().matches]).toEqual(['n1']);

      await (async () => {
        matcher.setQuery('header~b');
        await asked[2]!.failWith('Again');
        matcher.restart();
        await asked[3]!.answer(['r']);
        expect(matcher.state().error).toBeUndefined();
        expect([...matcher.state().matches]).toEqual(['r']);
      })();
    });

    it('a lost connection isn’t shown as an error', async () => {
      const { matcher, asked } = setup();
      matcher.setQuery('header~a');
      await asked[0]!.fail();
      expect(matcher.state().error).toBeUndefined();
      matcher.setQuery('header~b');
      await asked[1]!.failWith('Not connected');
      expect(matcher.state().error).toBeUndefined();
    });
  });

  describe('canceling replaced searches', () => {
    function withCancel() {
      const asked: Array<{
        query: string;
        ids?: string[];
        searchId?: string;
        answer(ids: string[]): Promise<void>;
        fail(message: string): Promise<void>;
      }> = [];
      const canceled: string[] = [];
      const matcher = new DetailMatcher(() => undefined);
      matcher.connect(
        (query, ids, searchId) => {
          const reply = deferred<string[]>();
          asked.push({
            query,
            ...(ids ? { ids } : {}),
            ...(searchId ? { searchId } : {}),
            answer: async (matched) => {
              reply.resolve(matched);
              await Promise.resolve();
              await Promise.resolve();
            },
            fail: async (message) => {
              reply.reject(new Error(message));
              await Promise.resolve();
              await Promise.resolve();
            },
          });
          return reply.promise;
        },
        (searchId) => canceled.push(searchId),
      );
      return { matcher, asked, canceled };
    }
    const big = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `n${i}`);

    it('names every full ask, uniquely, and never a batch ask', () => {
      const { matcher, asked } = withCancel();
      matcher.setQuery('header~a');
      matcher.onBatch(['1'], []);
      matcher.setQuery('header~b');
      expect(asked[0]!.searchId).toMatch(/^[a-z0-9]+-\d+$/);
      expect(asked[1]!.searchId).toBeUndefined();
      expect(asked[2]!.searchId).toMatch(/^[a-z0-9]+-\d+$/);
      expect(asked[2]!.searchId).not.toBe(asked[0]!.searchId);
      // Another window's matcher names its own.
      const other = withCancel();
      other.matcher.setQuery('header~a');
      expect(other.asked[0]!.searchId!.split('-')[0]).not.toBe(asked[0]!.searchId!.split('-')[0]);
    });

    it('cancels the full ask a new search replaces, while it’s unanswered', () => {
      const { matcher, asked, canceled } = withCancel();
      matcher.setQuery('header~a');
      matcher.setQuery('header~b');
      expect(canceled).toEqual([asked[0]!.searchId]);
    });

    it('cancels it when the search is cleared', () => {
      const { matcher, asked, canceled } = withCancel();
      matcher.setQuery('header~a');
      matcher.setQuery(undefined);
      expect(canceled).toEqual([asked[0]!.searchId]);
    });

    it('cancels the first full ask when a big batch starts a second', () => {
      const { matcher, asked, canceled } = withCancel();
      matcher.setQuery('header~a');
      matcher.onBatch(big, []);
      expect(asked[1]!.searchId).toBeDefined();
      expect(canceled).toEqual([asked[0]!.searchId]);
    });

    it('cancels nothing once answered, or for the same search again', async () => {
      const { matcher, asked, canceled } = withCancel();
      matcher.setQuery('header~a');
      await asked[0]!.answer([]);
      matcher.setQuery('header~a');
      matcher.setQuery('header~b');
      matcher.onBatch(['1'], []);
      await asked[1]!.answer([]);
      matcher.onBatch(big, []);
      expect(canceled).toEqual([]);
    });

    it('never shows "Canceled" as an error, and keeps the previous search shown', async () => {
      const { matcher, asked } = withCancel();
      matcher.setQuery('header~a');
      await asked[0]!.answer(['1']);
      matcher.setQuery('header~b');
      await asked[1]!.fail('Canceled');
      expect(matcher.state()).toMatchObject({ applied: 'header~a', pending: true });
      expect(matcher.state().error).toBeUndefined();
      expect([...matcher.state().matches]).toEqual(['1']);
    });

    it('drops a canceled search’s late answer', async () => {
      const { matcher, asked } = withCancel();
      matcher.setQuery('header~a');
      matcher.setQuery('header~b');
      await asked[0]!.answer(['stale']);
      await asked[1]!.answer(['fresh']);
      expect([...matcher.state().matches]).toEqual(['fresh']);
    });

    it('a restart doesn’t cancel by name: the old connection’s searches stopped with it', () => {
      const { matcher, canceled } = withCancel();
      matcher.setQuery('header~a');
      matcher.restart();
      expect(canceled).toEqual([]);
    });

    it('with no connection, there’s nothing to cancel through, and no error', () => {
      const { matcher, canceled } = withCancel();
      matcher.setQuery('header~a');
      matcher.connect(undefined, (id) => canceled.push(id));
      expect(() => matcher.setQuery('header~b')).not.toThrow();
      expect(canceled).toEqual([]);
    });

    it('a cancel that throws doesn’t stop the new search', () => {
      const matcher = new DetailMatcher(() => undefined);
      const asked: string[] = [];
      matcher.connect(
        (query) => {
          asked.push(query);
          return new Promise(() => undefined);
        },
        () => {
          throw new Error('Not connected');
        },
      );
      matcher.setQuery('header~a');
      expect(() => matcher.setQuery('header~b')).not.toThrow();
      expect(asked).toEqual(['header~a', 'header~b']);
    });
  });
});
