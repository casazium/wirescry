/**
 * Requests from before the proxy restarted, and plugins' actions on a request, in the main
 * window (src/renderer/src/App.tsx): what the right-click menu offers and runs, and what a HAR
 * export says it left out.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { detail, status, summary } from './fixtures';

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  /** What the plugin's actions did, for the test to check. */
  ran: [] as Array<{ action: string; id: string; hasApi: boolean }>,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string; exchangeId?: string }) =>
      command.command === 'getExchange' ? detail(summary(command.exchangeId ?? 'x'), 'm') : undefined,
    );
    close = vi.fn();
    constructor(
      public connection: unknown,
      public onMessage: (message: unknown) => void,
    ) {
      fake.clients.push(this);
    }
  },
}));

/** A plugin with actions: one for every request, one for POSTs only, and two that fail. */
vi.mock('@wirescry/pro/ui', async () => {
  const { PLUGIN_API_VERSION } = await import('../../src/plugin-api/version');
  return {
    uiPlugins: [
      {
        name: 'pro',
        apiVersion: PLUGIN_API_VERSION,
        views: [],
        exchangeSections: [
          {
            id: 'spec',
            label: 'API spec',
            component: ({ exchange }: { exchange: ExchangeSummary }) => (
              <p>Spec result for {exchange.path}</p>
            ),
          },
        ],
        exchangeActions: [
          {
            id: 'mock',
            label: 'Mock…',
            run: (e: ExchangeSummary, api: unknown) =>
              void fake.ran.push({ action: 'mock', id: e.id, hasApi: !!api }),
          },
          {
            id: 'posts',
            label: 'Replay POST',
            appliesTo: (e: ExchangeSummary) => e.method === 'POST',
            run: () => undefined,
          },
          {
            id: 'rejects',
            label: 'Breakpoint…',
            run: async () => {
              throw new Error('Pro needs a license.');
            },
          },
          {
            id: 'picky',
            label: 'Never offered',
            appliesTo: () => {
              throw new Error('appliesTo broke');
            },
            run: () => undefined,
          },
        ],
      },
    ],
  };
});

const { App } = await import('../../src/renderer/src/App');
const client = () => fake.clients.at(-1)!;

let changeState: (state: BackendState) => void = () => undefined;
let showMenu: ReturnType<typeof vi.fn>;
let exportHar: ReturnType<typeof vi.fn>;
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
  fake.ran.length = 0;
  showMenu = vi.fn(async () => undefined);
  exportHar = vi.fn(async () => ({}));
  window.wirescry = new Proxy(
    {
      getBackendState: async () => ready(1),
      onBackendStateChanged: (callback: (state: BackendState) => void) => {
        changeState = callback;
        return () => undefined;
      },
      onMenuCommand: () => () => undefined,
      setMenuState: () => undefined,
      showMenu,
      exportHar,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
});
afterEach(() => vi.restoreAllMocks());

const hello = (rows: ExchangeSummary[], proActive = true): ServerMessage =>
  ({
    type: 'hello',
    status: { ...status(), plugins: [{ name: 'pro', active: proActive }] },
    exchanges: rows,
    paused: false,
  }) as ServerMessage;

async function started(rows: ExchangeSummary[], proActive = true) {
  render(<App />);
  await act(async () => undefined);
  await act(async () => client().onMessage(hello(rows, proActive)));
}
/** The proxy restarts: what was listed stays, from before the restart, and these arrive new. */
async function restarted(rows: ExchangeSummary[]) {
  await act(async () => changeState(ready(2)));
  await act(async () => client().onMessage(hello(rows)));
}
const row = (path: string) =>
  screen.getAllByTestId('exchange-row').find((r) => r.textContent?.includes(path))!;
const rightClick = (path: string) => act(async () => void fireEvent.contextMenu(row(path)));
const offered = () =>
  (showMenu.mock.calls.at(-1)![0] as Array<{ id?: string; label?: string }>).map((c) => c.label ?? '—');

const get = summary('g', { path: '/get' });
const post = summary('p', { path: '/post', method: 'POST' });

describe('plugin actions in the right-click menu', () => {
  it('offers the actions that apply, after Wirescry’s own, leaving out one whose check throws', async () => {
    await started([get, post]);
    await rightClick('/get');
    expect(offered()).toEqual(['Copy URL', 'Copy as curl', '—', 'Edit and resend…', 'Mock…', 'Breakpoint…']);
    await rightClick('/post');
    expect(offered()).toEqual([
      'Copy URL',
      'Copy as curl',
      '—',
      'Edit and resend…',
      'Mock…',
      'Replay POST',
      'Breakpoint…',
    ]);
  });

  it('runs the one chosen, with the request and the plugin’s API', async () => {
    await started([get]);
    showMenu.mockResolvedValueOnce('pro:mock');
    await rightClick('/get');
    expect(fake.ran).toEqual([{ action: 'mock', id: 'g', hasApi: true }]);
  });

  it('shows why an action didn’t work, without its ellipsis', async () => {
    await started([get]);
    showMenu.mockResolvedValueOnce('pro:rejects');
    await rightClick('/get');
    await act(async () => undefined);
    expect(screen.getByRole('alert').textContent).toContain("Breakpoint didn't work: Pro needs a license.");
  });

  it('offers none of a plugin’s actions while it isn’t running', async () => {
    await started([get], false);
    await rightClick('/get');
    expect(offered()).toEqual(['Copy URL', 'Copy as curl', '—', 'Edit and resend…']);
  });
});

describe('requests from before the proxy restarted', () => {
  it('offer only Copy URL: their details and actions are gone', async () => {
    await started([get]);
    await restarted([post]);
    expect(row('/get').className).toContain('stale');
    await rightClick('/get');
    expect(offered()).toEqual(['Copy URL']);
    // New requests still get everything.
    await rightClick('/post');
    expect(offered()).toContain('Copy as curl');
    expect(offered()).toContain('Mock…');
  });

  it('still copy their URL', async () => {
    const clipboard = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    await started([get]);
    await restarted([]);
    showMenu.mockResolvedValueOnce('copy-url');
    await rightClick('/get');
    expect(clipboard).toHaveBeenCalledWith(get.url);
  });

  it('show no plugin sections in their details', async () => {
    await started([get]);
    await act(async () => void fireEvent.click(row('/get')));
    expect(screen.getByText('Spec result for /get')).toBeTruthy();
    await restarted([post]);
    // A new request still has them.
    await act(async () => void fireEvent.click(row('/post')));
    expect(screen.getByText('Spec result for /post')).toBeTruthy();
    // The old one, selected again (a second click on a selected row would close it), doesn't.
    await act(async () => void fireEvent.click(row('/get')));
    expect(screen.getByText('https://api.test/g')).toBeTruthy();
    expect(screen.queryByText('Spec result for /get')).toBeNull();
  });

  it('aren’t exported, and the notice says how many were left out', async () => {
    await started([get, summary('g2', { path: '/get2' })]);
    await restarted([post]);
    exportHar.mockResolvedValueOnce({ name: 'now.har', count: 1 });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Export HAR' })));
    expect(exportHar).toHaveBeenCalledWith(['p']);
    expect(
      screen.getByText(
        'Exported 1 request to now.har. 2 from before the proxy restarted weren’t included: their details were lost.',
      ),
    ).toBeTruthy();
  });

  it('says one wasn’t included', async () => {
    await started([get]);
    await restarted([post]);
    exportHar.mockResolvedValueOnce({ name: 'now.har', count: 1 });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Export HAR' })));
    expect(
      screen.getByText(
        'Exported 1 request to now.har. 1 from before the proxy restarted wasn’t included: its details were lost.',
      ),
    ).toBeTruthy();
  });

  it('can’t be exported on their own', async () => {
    await started([get]);
    await restarted([]);
    expect((screen.getByRole('button', { name: 'Export HAR' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
