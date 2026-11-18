/**
 * Searching by header in the main window (src/renderer/src/App.tsx, useBackend.ts): the backend
 * is asked which rows match, the list shows its answer, and new rows, restarts and Clear with
 * Undo keep the list right.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeDetail, ExchangeSummary, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { compileQuery } from '../../src/shared/query';
import { UNDO_CLEAR_MS } from '../../src/renderer/src/useUndoableClear';
import { status, summary } from './fixtures';

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  /** Each exchange's details, as the backend has them. */
  details: new Map<string, unknown>(),
  /** While set, matchExchanges replies wait here instead of answering. */
  held: undefined as undefined | Array<() => void>,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string; query?: string; ids?: string[] }) => {
      if (command.command !== 'matchExchanges') return undefined;
      const answer = () => {
        const q = compileQuery(command.query!);
        const ids = command.ids ?? [...fake.details.keys()];
        return {
          ids: ids.filter((id) => {
            const d = fake.details.get(id) as ExchangeDetail | undefined;
            return d !== undefined && q.matchesDetail(d);
          }),
        };
      };
      if (!fake.held) return answer();
      await new Promise<void>((resolve) => fake.held!.push(resolve));
      return answer();
    });
    close = vi.fn();
    constructor(
      public connection: unknown,
      public onMessage: (message: unknown) => void,
    ) {
      fake.clients.push(this);
    }
  },
}));

const { App } = await import('../../src/renderer/src/App');
const client = () => fake.clients.at(-1)!;

let changeState: (state: BackendState) => void = () => undefined;
const ready = (generation: number): BackendState =>
  ({
    state: 'ready',
    connection: { apiUrl: `ws://127.0.0.1:${9000 + generation}/`, token: 't' },
    generation,
    ...(generation > 1 ? { restart: { at: 1, byUser: true } } : {}),
  }) as BackendState;

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  fake.clients.length = 0;
  fake.details.clear();
  fake.held = undefined;
  window.wirescry = new Proxy(
    {
      getBackendState: async () => ready(1),
      onBackendStateChanged: (callback: (state: BackendState) => void) => {
        changeState = callback;
        return () => undefined;
      },
      onMenuCommand: () => () => undefined,
      setMenuState: () => undefined,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
});
afterEach(() => vi.restoreAllMocks());

/** An exchange the backend has, with this x-team header. */
function captured(id: string, team: string): ExchangeSummary {
  const s = summary(id, { path: `/${id}` });
  fake.details.set(id, {
    summary: s,
    requestHeaders: [['x-team', team]],
    responseHeaders: [['content-type', 'application/json']],
    timing: { startTimestamp: 0 },
  } satisfies ExchangeDetail);
  return s;
}

const hello = (rows: ExchangeSummary[]): ServerMessage =>
  ({ type: 'hello', status: status(), exchanges: rows, paused: false }) as ServerMessage;

async function started(rows: ExchangeSummary[]) {
  render(<App />);
  await act(async () => undefined);
  await act(async () => client().onMessage(hello(rows)));
}
/** Long enough for the pause after typing, the reply and a frame. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 250)));
async function search(text: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search traffic' }), { target: { value: text } });
  await settle();
}
const shownPaths = () =>
  screen.queryAllByTestId('exchange-row').map((r) => r.textContent?.match(/\/[a-z]+/)?.[0]);
const count = () => screen.getByTestId('row-count').textContent;
const matchCalls = () =>
  client()
    .send.mock.calls.map((c) => c[0] as { command: string; ids?: string[] })
    .filter((c) => c.command === 'matchExchanges');
async function batch(changed: ExchangeSummary[], removed: string[] = []) {
  await act(async () => client().onMessage({ type: 'exchanges', exchanges: changed, removed }));
  await settle();
}

describe('searching by header', () => {
  it('asks the backend and shows only the rows it says match', async () => {
    await started([captured('alpha', 'red'), captured('beta', 'blue'), captured('gamma', 'red')]);
    await search('header.x-team=red');
    expect(shownPaths()).toEqual(['/alpha', '/gamma']);
    expect(count()).toBe('2 of 3');
    expect(matchCalls()).toHaveLength(1);
    expect(matchCalls()[0]!.ids).toBeUndefined();
    // A negative: nothing has that value.
    await search('header.x-team=green');
    expect(shownPaths()).toEqual([]);
  });

  it('combines header terms with the others', async () => {
    await started([captured('alpha', 'red'), captured('beta', 'blue'), captured('gamma', 'red')]);
    await search('path~gam header.x-team=red');
    expect(shownPaths()).toEqual(['/gamma']);
  });

  it('asks nothing for a search without header terms, or for a quick filter', async () => {
    await started([captured('alpha', 'red'), captured('beta', 'blue')]);
    await search('path~alpha');
    expect(shownPaths()).toEqual(['/alpha']);
    await search('header.css');
    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    await settle();
    expect(matchCalls()).toHaveLength(0);
    // With a header search on, changing the quick filter doesn't ask again.
    await search('header.x-team=red');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    await settle();
    expect(matchCalls()).toHaveLength(1);
  });

  it('says it’s searching, and keeps the last results until the answer comes', async () => {
    await started([captured('alpha', 'red'), captured('beta', 'blue')]);
    await search('path~alpha');
    fake.held = [];
    await search('header.x-team=blue');
    expect(count()).toBe('Searching headers…');
    // Still the previous search's rows, not a mix of the two.
    expect(shownPaths()).toEqual(['/alpha']);
    const release = fake.held;
    fake.held = undefined;
    await act(async () => release.forEach((r) => r()));
    await settle();
    expect(shownPaths()).toEqual(['/beta']);
    expect(count()).toBe('1 of 2');
  });

  it('shows a new row only once the backend says it matches', async () => {
    await started([captured('alpha', 'red')]);
    await search('header.x-team=red');
    fake.held = [];
    await batch([captured('delta', 'red'), captured('eps', 'blue')]);
    // Hidden while unanswered.
    expect(shownPaths()).toEqual(['/alpha']);
    const release = fake.held;
    fake.held = undefined;
    await act(async () => release.forEach((r) => r()));
    await settle();
    expect(shownPaths()).toEqual(['/alpha', '/delta']);
    expect(matchCalls().at(-1)!.ids).toEqual(['delta', 'eps']);
  });

  it('drops a row whose headers change so it no longer matches', async () => {
    await started([captured('alpha', 'red'), captured('beta', 'red')]);
    await search('header.x-team=red');
    expect(shownPaths()).toEqual(['/alpha', '/beta']);
    await batch([captured('beta', 'blue')]);
    expect(shownPaths()).toEqual(['/alpha']);
  });

  it('can’t search rows from before a restart, and says so', async () => {
    await started([captured('alpha', 'red')]);
    await search('header.x-team=red');
    expect(shownPaths()).toEqual(['/alpha']);
    fake.details.clear();
    fake.held = [];
    await act(async () => changeState(ready(2)));
    await act(async () => client().onMessage(hello([captured('newer', 'red')])));
    await settle();
    // While the new backend is asked, the old row no longer counts as a match.
    expect(shownPaths()).toEqual([]);
    const release = fake.held;
    fake.held = undefined;
    await act(async () => release.forEach((r) => r()));
    await settle();
    expect(shownPaths()).toEqual(['/newer']);
    expect(document.querySelector('.filter-notes')?.textContent).toContain(
      "1 request from before the restart can't be searched by header.",
    );
    // The new connection was asked in full.
    expect(matchCalls()).toHaveLength(1);
    expect(matchCalls()[0]!.ids).toBeUndefined();
    // No header search, no note; the old row shows again.
    await search('');
    expect(screen.queryByText(/can't be searched by header/)).toBeNull();
    expect(shownPaths()).toContain('/alpha');
  });

  it('asks again on reconnecting to the same backend', async () => {
    await started([captured('alpha', 'red'), captured('beta', 'blue')]);
    await search('header.x-team=red');
    const first = client();
    await act(async () => first.onMessage(hello([captured('alpha', 'red'), captured('beta', 'blue')])));
    await settle();
    expect(shownPaths()).toEqual(['/alpha']);
    expect(
      first.send.mock.calls.filter((c) => (c[0] as { command: string }).command === 'matchExchanges'),
    ).toHaveLength(2);
  });

  it('brings rows back filtered after Clear and Undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('header.x-team=red');
      expect(shownPaths()).toEqual(['/alpha']);
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await settle();
      expect(shownPaths()).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await settle();
      expect(shownPaths()).toEqual(['/alpha']);
      // Clear that goes through: the backend removes them, by id.
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await act(async () => vi.advanceTimersByTime(UNDO_CLEAR_MS));
      await batch([], ['alpha', 'beta']);
      expect(shownPaths()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets its matches when everything is cleared', async () => {
    await started([captured('alpha', 'red')]);
    await search('header.x-team=red');
    expect(shownPaths()).toEqual(['/alpha']);
    await act(async () => client().onMessage({ type: 'cleared' }));
    await settle();
    expect(shownPaths()).toEqual([]);
    // Even an exchange with the same id (ids aren't reused; this checks the wiring) waits for
    // its own answer, which says it no longer matches.
    fake.held = [];
    await batch([captured('alpha', 'blue')]);
    expect(shownPaths()).toEqual([]);
    const release = fake.held;
    fake.held = undefined;
    await act(async () => release.forEach((r) => r()));
    await settle();
    expect(shownPaths()).toEqual([]);
  });

  it('shows the error for a bad header term and asks nothing', async () => {
    await started([captured('alpha', 'red')]);
    await search('header=red');
    expect(document.querySelector('.filter-notes')?.textContent).toContain('header= needs a header name');
    expect(matchCalls()).toHaveLength(0);
    expect(shownPaths()).toEqual(['/alpha']);
  });
});
