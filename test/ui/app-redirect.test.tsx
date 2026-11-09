/** A redirect's link in Traffic opens the request that followed it (App, DetailPane, redirect.ts). */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeDetail, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { status, summary } from './fixtures';

const redirected = summary('old', { path: '/old', url: 'https://api.test/old', status: 302, startedAt: 10 });
const followed = summary('new', { path: '/new', url: 'https://api.test/new', startedAt: 20 });
const unrelated = summary('other', { path: '/other', url: 'https://api.test/other', startedAt: 15 });

/** Stands in for the WebSocket client: the redirect points to /new. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void }>,
}));
vi.mock('../../src/renderer/src/api-client', async () => {
  const fixtures = await import('./fixtures');
  return {
    ApiClient: class {
      send = vi.fn(
        async (command: { command: string; exchangeId?: string }): Promise<ExchangeDetail | undefined> => {
          if (command.command !== 'getExchange') return undefined;
          const id = command.exchangeId!;
          const base = fixtures.detail(
            fixtures.summary(id, { url: `https://api.test/${id}` }),
            `marker-${id}`,
          );
          return id === 'old' ? { ...base, responseHeaders: [['Location', '/new']] } : base;
        },
      );
      close = vi.fn();
      constructor(
        public connection: unknown,
        public onMessage: (message: unknown) => void,
      ) {
        fake.clients.push(this);
      }
    },
  };
});
vi.mock('@wirescry/pro/ui', () => ({ uiPlugins: [] }));

const { App } = await import('../../src/renderer/src/App');

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  fake.clients.length = 0;
  const ready = {
    state: 'ready',
    connection: { apiUrl: 'ws://127.0.0.1:9001/', token: 't' },
    generation: 1,
  } as BackendState;
  window.wirescry = new Proxy(
    {
      getBackendState: async () => ready,
      onBackendStateChanged: () => () => undefined,
      onMenuCommand: () => () => undefined,
      setMenuState: () => undefined,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
});

async function started() {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    fake.clients.at(-1)!.onMessage({
      type: 'hello',
      status: status(),
      exchanges: [redirected, unrelated, followed],
      paused: false,
    } as ServerMessage),
  );
}
const row = (path: string) =>
  screen.getAllByTestId('exchange-row').find((r) => r.textContent?.includes(path))!;

describe('A redirect in Traffic', () => {
  it('links to the request that followed it, which opens when clicked', async () => {
    await started();
    fireEvent.click(row('/old'));
    await act(async () => undefined);
    expect(screen.getByText('marker-old')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'https://api.test/new' }));
    await act(async () => undefined);
    expect(screen.getByText('marker-new')).toBeTruthy();
    expect(screen.queryByText('marker-old')).toBeNull();
    expect(row('/new').getAttribute('aria-selected')).toBe('true');
    // The link is gone with the redirect's details: keyboard focus goes to the new request's.
    expect(document.activeElement?.textContent).toBe('Overview');
  });

  it('doesn’t link to a request the search hides, which would open with no row', async () => {
    await started();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search traffic' }), {
      target: { value: '-path=/new' },
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.getAllByTestId('exchange-row').some((r) => r.textContent?.includes('/new'))).toBe(false);
    fireEvent.click(row('/old'));
    await act(async () => undefined);
    expect(document.querySelector('dd.redirect')?.textContent).toBe('https://api.test/new');
    expect(screen.queryByRole('button', { name: 'https://api.test/new' })).toBeNull();
  });
});
