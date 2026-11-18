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
  /** Bodies, by exchange id: a body term matches when its text is in one. */
  bodies: new Map<string, { request?: string; response?: string; partial?: boolean }>(),
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string; query?: string; ids?: string[] }) => {
      if (command.command !== 'matchExchanges') return undefined;
      if (command.query!.includes('refuse-me')) throw new Error('Something went wrong');
      const answer = () => {
        const q = compileQuery(command.query!);
        const ids = command.ids ?? [...fake.details.keys()];
        const partial: string[] = [];
        const bodiesMatch = (id: string): boolean =>
          q.bodyTerms.every((term) => {
            const body = fake.bodies.get(id) ?? {};
            const text = [
              term.side !== 'response' ? body.request : '',
              term.side !== 'request' ? body.response : '',
            ]
              .join(' ')
              .toLowerCase();
            const found = text.includes(term.needle);
            if (!found && body.partial) partial.push(id);
            return term.negated !== found;
          });
        const matched = ids.filter((id) => {
          const d = fake.details.get(id) as ExchangeDetail | undefined;
          return d !== undefined && q.matchesDetail(d) && bodiesMatch(id);
        });
        return partial.length > 0 ? { ids: matched, partial: [...new Set(partial)] } : { ids: matched };
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
let exportHar: ReturnType<typeof vi.fn>;
let setMenuState: ReturnType<typeof vi.fn>;
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
  fake.bodies.clear();
  fake.held = undefined;
  exportHar = vi.fn(async () => ({}));
  setMenuState = vi.fn();
  window.wirescry = new Proxy(
    {
      getBackendState: async () => ready(1),
      onBackendStateChanged: (callback: (state: BackendState) => void) => {
        changeState = callback;
        return () => undefined;
      },
      onMenuCommand: () => () => undefined,
      setMenuState,
      exportHar,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
});
afterEach(() => vi.restoreAllMocks());

/** An exchange the backend has, with this x-team header. */
function captured(id: string, team: string, overrides: Partial<ExchangeSummary> = {}): ExchangeSummary {
  const s = summary(id, { path: `/${id}`, ...overrides });
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
    .send.mock.calls.map((c) => c[0] as { command: string; query?: string; ids?: string[] })
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
      "1 request from before the restart can't be searched by header or body.",
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

  it('says so when the backend can’t search, instead of searching for ever', async () => {
    await started([captured('alpha', 'red')]);
    await search('header~refuse-me');
    expect(count()).not.toBe('Searching headers…');
    expect(shownPaths()).toEqual([]);
    expect(document.querySelector('.filter-notes')?.textContent).toContain(
      "Couldn't search headers: Something went wrong",
    );
    // A search that works clears it.
    await search('header.x-team=red');
    expect(shownPaths()).toEqual(['/alpha']);
    expect(document.querySelector('.filter-notes')).toBeNull();
  });

  it('counts only the rows still listed from before a restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await started([captured('alpha', 'red'), captured('beta', 'red')]);
      fake.details.clear();
      await act(async () => changeState(ready(2)));
      await act(async () => client().onMessage(hello([])));
      await settle();
      await search('header.x-team=red');
      expect(document.querySelector('.filter-notes')?.textContent).toContain('2 requests from before');
      // Clear hides them while Undo is offered: they aren't counted.
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await settle();
      expect(document.querySelector('.filter-notes')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the error for a bad header term and asks nothing', async () => {
    await started([captured('alpha', 'red')]);
    await search('header=red');
    expect(document.querySelector('.filter-notes')?.textContent).toContain('header= needs a header name');
    expect(matchCalls()).toHaveLength(0);
    expect(shownPaths()).toEqual(['/alpha']);
  });

  describe('switching searches', () => {
    const release = async () => {
      const held = fake.held ?? [];
      fake.held = undefined;
      await act(async () => held.forEach((r) => r()));
      await settle();
    };

    it('keeps one header search’s rows, its own terms and all, while the next is answered', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue'), captured('gamma', 'red')]);
      await search('path~alp header.x-team=red');
      expect(shownPaths()).toEqual(['/alpha']);
      fake.held = [];
      await search('path~bet header.x-team=blue');
      expect(count()).toBe('Searching headers…');
      expect(shownPaths()).toEqual(['/alpha']);
      await release();
      expect(shownPaths()).toEqual(['/beta']);
    });

    it('switches to a plain search at once, without asking', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('header.x-team=red');
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search traffic' }), {
        target: { value: 'path~bet' },
      });
      await act(async () => undefined);
      expect(shownPaths()).toEqual(['/beta']);
      expect(count()).toBe('1 of 2');
      await settle();
      expect(matchCalls()).toHaveLength(1);
    });

    it('back to an earlier header search: shows the plain search’s rows until asked again', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('header.x-team=red');
      await search('path~bet');
      fake.held = [];
      await search('header.x-team=red');
      expect(shownPaths()).toEqual(['/beta']);
      expect(count()).toBe('Searching headers…');
      expect(matchCalls()).toHaveLength(2);
      await release();
      expect(shownPaths()).toEqual(['/alpha']);
    });

    it('applies a quick filter at once while a header answer is awaited, asking nothing more', async () => {
      await started([
        captured('alpha', 'red'),
        captured('beta', 'red', { contentType: 'text/html', url: 'https://api.test/beta' }),
      ]);
      await search('header.x-team=red');
      expect(shownPaths()).toEqual(['/alpha', '/beta']);
      fake.held = [];
      await search('header.x-team=red path~a');
      fireEvent.click(screen.getByRole('radio', { name: 'HTML' }));
      await act(async () => undefined);
      expect(shownPaths()).toEqual(['/beta']);
      await release();
      expect(shownPaths()).toEqual(['/beta']);
      expect(matchCalls()).toHaveLength(2);
    });

    it('narrows by both the quick filter and the header search', async () => {
      await started([
        captured('alpha', 'red'),
        captured('beta', 'red', { contentType: 'text/html' }),
        captured('gamma', 'blue'),
      ]);
      fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
      await search('header.x-team=red');
      expect(shownPaths()).toEqual(['/alpha']);
    });

    it('says it’s searching in the empty list too, while the last search showed nothing', async () => {
      await started([captured('alpha', 'red')]);
      await search('header.x-team=green');
      expect(screen.getByText('No requests match the current search or filter.')).toBeTruthy();
      fake.held = [];
      await search('header.x-team=red');
      expect(screen.queryByText('No requests match the current search or filter.')).toBeNull();
      expect(document.querySelector('.traffic-scroll')?.textContent).toContain('Searching headers…');
      await release();
      expect(shownPaths()).toEqual(['/alpha']);
    });
  });

  describe('typing', () => {
    const type = (text: string) =>
      act(async () => {
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search traffic' }), {
          target: { value: text },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
      });

    it('asks once, for the final text, after a pause', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await type('header.x-team=r');
      await type('header.x-team=re');
      await type('header.x-team=red');
      await settle();
      expect(matchCalls().map((c) => c.query)).toEqual(['header.x-team=red']);
      expect(shownPaths()).toEqual(['/alpha']);
    });

    it('asks nothing when a header search turns plain within the pause', async () => {
      await started([captured('alpha', 'red')]);
      await type('header.x-team=red');
      await type('alpha');
      await settle();
      expect(matchCalls()).toHaveLength(0);
      expect(shownPaths()).toEqual(['/alpha']);
    });

    it('asks nothing while the term is unfinished, and shows why', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('header.x-team=');
      expect(matchCalls()).toHaveLength(0);
      expect(document.querySelector('.filter-notes')?.textContent).toContain('header.x-team= needs a value');
      expect(shownPaths()).toEqual(['/alpha', '/beta']);
    });

    it('drops header terms from a pasted search over the limit, and says so', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('header.x-team=red');
      expect(shownPaths()).toEqual(['/alpha']);
      await search(`header.x-team=red path~a ${'x'.repeat(4096)}`);
      expect(document.querySelector('.filter-notes')?.textContent).toContain(
        'too long for header and body terms',
      );
      expect(matchCalls()).toHaveLength(1);
      // The other terms still filter: nothing has that long text.
      expect(shownPaths()).toEqual([]);
    });
  });

  describe('plain searches, unchanged', () => {
    it('filter in the window, count, clear with Escape, and never ask the backend', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('alpha');
      expect(shownPaths()).toEqual(['/alpha']);
      expect(count()).toBe('1 of 2');
      await search('nothing-like-it');
      expect(shownPaths()).toEqual([]);
      expect(count()).toBe('0 of 2');
      expect(screen.getByText('No requests match the current search or filter.')).toBeTruthy();
      const box = screen.getByRole('searchbox', { name: 'Search traffic' });
      fireEvent.keyDown(box, { key: 'Escape' });
      await settle();
      expect(shownPaths()).toEqual(['/alpha', '/beta']);
      expect(count()).toBe('2 requests');
      expect(screen.queryByText('Searching headers…')).toBeNull();
      expect(matchCalls()).toHaveLength(0);
    });
  });

  describe('HAR export of a header search', () => {
    const exportButton = () => screen.getByRole('button', { name: 'Export HAR' });

    it('exports only the matching rows, in list order', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue'), captured('gamma', 'red')]);
      await search('header.x-team=red');
      await act(async () => void fireEvent.click(exportButton()));
      expect(exportHar).toHaveBeenCalledWith(['alpha', 'gamma']);
    });

    it('exports what’s still shown while a new header search is answered', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      await search('header.x-team=red');
      fake.held = [];
      await search('header.x-team=blue');
      await act(async () => void fireEvent.click(exportButton()));
      expect(exportHar).toHaveBeenCalledWith(['alpha']);
    });

    it('offers no export when nothing matches', async () => {
      await started([captured('alpha', 'red')]);
      await search('header.x-team=green');
      expect((exportButton() as HTMLButtonElement).disabled).toBe(true);
      expect(setMenuState.mock.calls.at(-1)![0]).toMatchObject({ canExport: false });
    });

    it('after a restart, exports only new matches and counts nothing as left out', async () => {
      await started([captured('alpha', 'red')]);
      fake.details.clear();
      await act(async () => changeState(ready(2)));
      await act(async () => client().onMessage(hello([captured('newer', 'red')])));
      await settle();
      await search('header.x-team=red');
      exportHar.mockResolvedValueOnce({ name: 'red.har', count: 1 });
      await act(async () => void fireEvent.click(exportButton()));
      expect(exportHar).toHaveBeenCalledWith(['newer']);
      expect(screen.getByText(/Exported 1 request to red\.har\./).textContent).not.toContain(
        'before the proxy',
      );
    });
  });

  describe('selection', () => {
    const list = () => document.querySelector('.traffic-scroll')!;
    const press = (key: string) => act(async () => void fireEvent.keyDown(list(), { key }));
    const selectedPath = () =>
      screen
        .queryAllByTestId('exchange-row')
        .find((r) => r.getAttribute('aria-selected') === 'true')
        ?.textContent?.match(/\/[a-z]+/)?.[0];

    it('arrow keys move only among the matching rows', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue'), captured('gamma', 'red')]);
      await search('header.x-team=red');
      await press('ArrowDown');
      expect(selectedPath()).toBe('/alpha');
      await press('ArrowDown');
      expect(selectedPath()).toBe('/gamma');
      await press('ArrowUp');
      expect(selectedPath()).toBe('/alpha');
    });

    it('a selected row that stops matching leaves the list; the next arrow starts from the top', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'red')]);
      await search('header.x-team=red');
      await press('ArrowDown');
      await press('ArrowDown');
      expect(selectedPath()).toBe('/beta');
      await batch([captured('beta', 'blue')]);
      expect(shownPaths()).toEqual(['/alpha']);
      await press('ArrowDown');
      expect(selectedPath()).toBe('/alpha');
    });
  });

  describe('more on restarts', () => {
    it('says it’s searching while the new backend is asked, then counts', async () => {
      await started([captured('alpha', 'red')]);
      await search('header.x-team=red');
      fake.details.clear();
      fake.held = [];
      await act(async () => changeState(ready(2)));
      await act(async () => client().onMessage(hello([captured('newer', 'red')])));
      await settle();
      expect(count()).toBe('Searching headers…');
      const held = fake.held;
      fake.held = undefined;
      await act(async () => held.forEach((r) => r()));
      await settle();
      expect(count()).toBe('1 of 2');
    });

    it('a negated header term doesn’t match rows from before the restart either', async () => {
      await started([captured('alpha', 'red')]);
      fake.details.clear();
      await act(async () => changeState(ready(2)));
      await act(async () => client().onMessage(hello([captured('newer', 'red')])));
      await settle();
      await search('-header.nope=*');
      expect(shownPaths()).toEqual(['/newer']);
      expect(document.querySelector('.filter-notes')?.textContent).toContain(
        "1 request from before the restart can't be searched by header or body.",
      );
    });
  });

  describe('the help', () => {
    it('picking a header example fills the box, closes the help, and searches', async () => {
      await started([captured('alpha', 'red')]);
      fireEvent.click(screen.getByRole('button', { name: 'Search syntax' }));
      fireEvent.click(screen.getByRole('button', { name: 'header~bearer' }));
      await settle();
      expect((screen.getByRole('searchbox', { name: 'Search traffic' }) as HTMLInputElement).value).toBe(
        'header~bearer',
      );
      expect(screen.queryByRole('dialog', { name: 'Search syntax' })).toBeNull();
      expect(matchCalls().map((c) => c.query)).toEqual(['header~bearer']);
      expect(shownPaths()).toEqual([]);
    });
  });

  describe('canceling', () => {
    const calls = () =>
      client().send.mock.calls.map((c) => c[0] as { command: string; query?: string; searchId?: string });

    it('cancels a header search it replaces before the answer, by its name', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'blue')]);
      fake.held = [];
      await search('header.x-team=red');
      await search('header.x-team=blue');
      const asks = calls().filter((c) => c.command === 'matchExchanges');
      expect(asks.map((c) => c.query)).toEqual(['header.x-team=red', 'header.x-team=blue']);
      expect(asks[0]!.searchId).toBeTruthy();
      expect(calls().filter((c) => c.command === 'cancelMatch')).toEqual([
        { command: 'cancelMatch', searchId: asks[0]!.searchId },
      ]);
      const held = fake.held;
      fake.held = undefined;
      await act(async () => held.forEach((r) => r()));
      await settle();
      expect(shownPaths()).toEqual(['/beta']);
    });

    it('cancels it when the search box is cleared', async () => {
      await started([captured('alpha', 'red')]);
      fake.held = [];
      await search('header.x-team=red');
      await search('');
      expect(calls().filter((c) => c.command === 'cancelMatch')).toHaveLength(1);
      expect(shownPaths()).toEqual(['/alpha']);
    });

    it('cancels nothing once a search is answered', async () => {
      await started([captured('alpha', 'red')]);
      await search('header.x-team=red');
      await search('header.x-team=blue');
      await search('');
      expect(calls().filter((c) => c.command === 'cancelMatch')).toEqual([]);
    });
  });

  describe('searching bodies', () => {
    const notes = () => document.querySelector('.filter-notes')?.textContent ?? '';
    const release = async () => {
      const held = fake.held ?? [];
      fake.held = undefined;
      await act(async () => held.forEach((r) => r()));
      await settle();
    };

    it('finds rows by body, says it’s searching bodies, and shows progress', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'red')]);
      fake.bodies.set('alpha', { response: '{"error":"nope"}' });
      fake.bodies.set('beta', { response: '{"ok":true}' });
      fake.held = [];
      await search('resbody~error');
      expect(count()).toBe('Searching bodies…');
      const ask = matchCalls().at(-1)!;
      await act(async () =>
        client().onMessage({
          type: 'matchProgress',
          searchId: (ask as { searchId?: string }).searchId,
          done: 1,
          total: 2,
        }),
      );
      expect(count()).toBe('Searching bodies… 1 of 2');
      // Another search's progress doesn't show.
      await act(async () =>
        client().onMessage({ type: 'matchProgress', searchId: 'other', done: 2, total: 2 }),
      );
      expect(count()).toBe('Searching bodies… 1 of 2');
      await release();
      expect(shownPaths()).toEqual(['/alpha']);
      expect(count()).toBe('1 of 2');
    });

    it('a header-only search still says "Searching headers…"', async () => {
      await started([captured('alpha', 'red')]);
      fake.held = [];
      await search('header.x-team=red');
      expect(count()).toBe('Searching headers…');
      await release();
    });

    it('says how many requests weren’t fully searched', async () => {
      await started([captured('alpha', 'red'), captured('beta', 'red'), captured('gamma', 'red')]);
      fake.bodies.set('alpha', { response: 'short', partial: true });
      fake.bodies.set('beta', { response: 'also short', partial: true });
      fake.bodies.set('gamma', { response: 'has the word' });
      await search('resbody~word');
      expect(shownPaths()).toEqual(['/gamma']);
      expect(notes()).toContain(
        "2 requests weren’t fully searched: their bodies are over 64 MB decoded, weren't kept in full, or couldn't be decoded.",
      );
      fake.bodies.set('gamma', { response: 'nothing', partial: true });
      await search('resbody~zebra');
      expect(notes()).toContain('3 requests weren’t fully searched');
      // A search without body terms has no such note.
      await search('header.x-team=red');
      expect(notes()).not.toContain('fully searched');
    });

    it('the singular reads right', async () => {
      await started([captured('alpha', 'red')]);
      fake.bodies.set('alpha', { response: 'x', partial: true });
      await search('body~zebra');
      expect(notes()).toContain('1 request wasn’t fully searched');
    });

    it('rows from before a restart can’t be searched by body either', async () => {
      await started([captured('alpha', 'red')]);
      fake.bodies.set('alpha', { response: 'error' });
      fake.details.clear();
      await act(async () => changeState(ready(2)));
      await act(async () => client().onMessage(hello([captured('newer', 'red')])));
      await settle();
      fake.bodies.set('newer', { response: 'error' });
      await search('resbody~error');
      expect(shownPaths()).toEqual(['/newer']);
      expect(notes()).toContain("1 request from before the restart can't be searched by header or body.");
    });

    it('shows the error for a body term that isn’t ~, and asks nothing', async () => {
      await started([captured('alpha', 'red')]);
      await search('body=x');
      expect(notes()).toContain("body= isn't supported: body terms take only ~, as in body~text");
      expect(matchCalls()).toHaveLength(0);
    });

    it('the help’s body example searches bodies', async () => {
      await started([captured('alpha', 'red')]);
      fake.bodies.set('alpha', { response: 'an error here' });
      fireEvent.click(screen.getByRole('button', { name: 'Search syntax' }));
      fireEvent.click(screen.getByRole('button', { name: 'resbody~error' }));
      await settle();
      expect(matchCalls().map((c) => c.query)).toEqual(['resbody~error']);
      expect(shownPaths()).toEqual(['/alpha']);
    });
  });
});
