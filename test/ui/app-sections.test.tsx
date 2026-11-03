import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { detail, status, summary } from './fixtures';

/** Stands in for the WebSocket client. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
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

/** A plugin with three sections: one for badged exchanges, one for all, and one that breaks. */
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
            appliesTo: (e: ExchangeSummary) => !!e.annotations?.some((a) => a.plugin === 'pro'),
            component: ({ exchange }: { exchange: ExchangeSummary }) => (
              <p>Spec result for {exchange.path}</p>
            ),
          },
          {
            id: 'broken',
            label: 'Broken section',
            appliesTo: (e: ExchangeSummary) => e.path === '/break',
            component: () => {
              throw new Error('section broke');
            },
          },
          {
            id: 'picky',
            label: 'Picky section',
            appliesTo: () => {
              throw new Error('appliesTo broke');
            },
            component: () => <p>never shown</p>,
          },
        ],
      },
    ],
  };
});

const { App } = await import('../../src/renderer/src/App');
const client = () => fake.clients.at(-1)!;

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

const badged = summary('a', {
  path: '/users/1',
  annotations: [{ plugin: 'pro', label: 'Spec', tone: 'ok' }],
});
const plain = summary('b', { path: '/plain' });
const breaking = summary('c', { path: '/break' });

async function started(proActive: boolean, rows: ExchangeSummary[] = [badged, plain, breaking]) {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    client().onMessage({
      type: 'hello',
      status: {
        ...status(),
        plugins: [
          { name: 'pro', active: proActive, ...(proActive ? {} : { reason: 'Pro needs a license.' }) },
        ],
      },
      exchanges: rows,
      paused: false,
    } as ServerMessage),
  );
}

const open = async (path: string) => {
  const row = screen.getAllByTestId('exchange-row').find((r) => r.textContent?.includes(path))!;
  await act(async () => {
    fireEvent.click(row);
  });
};

describe('Plugin sections in the detail pane', () => {
  it('shows a section only where it applies', async () => {
    await started(true);
    await open('/users/1');
    expect(screen.getByText('API spec')).toBeTruthy();
    expect(screen.getByText('Spec result for /users/1')).toBeTruthy();
    await open('/plain');
    expect(screen.queryByText('API spec')).toBeNull();
  });

  it('leaves out a section whose appliesTo throws', async () => {
    await started(true);
    await open('/users/1');
    expect(screen.queryByText('Picky section')).toBeNull();
  });

  it('keeps a crashing section from taking the detail pane down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await started(true);
    await open('/break');
    expect(screen.getByText(/This view stopped working: section broke/)).toBeTruthy();
    // The rest of the pane is still there.
    expect(screen.getByText('Request headers')).toBeTruthy();
  });

  it('shows a section once its badge arrives, while the exchange is open', async () => {
    await started(true, [plain]);
    await open('/plain');
    expect(screen.queryByText('API spec')).toBeNull();
    await act(async () =>
      client().onMessage({
        type: 'exchanges',
        exchanges: [{ ...plain, annotations: [{ plugin: 'pro', label: 'Spec', tone: 'ok' }] }],
        removed: [],
      } as ServerMessage),
    );
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(screen.getByText('API spec')).toBeTruthy();
    expect(screen.getByText('Spec result for /plain')).toBeTruthy();
  });

  it('shows no sections while the plugin isn’t running', async () => {
    await started(false);
    await open('/users/1');
    expect(screen.queryByText('API spec')).toBeNull();
    // The badge from before is still in the list.
    expect(document.querySelector('.plugin-badge')?.textContent).toBe('Spec');
  });
});
