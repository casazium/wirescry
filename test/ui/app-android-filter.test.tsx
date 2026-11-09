import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDE_ANDROID_SYSTEM_QUERY } from '../../src/shared/android-system';
import type { ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { status, summary } from './fixtures';

/** Stands in for the WebSocket client. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void }>,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async () => undefined);
    close = vi.fn();
    constructor(
      public connection: unknown,
      public onMessage: (message: unknown) => void,
    ) {
      fake.clients.push(this);
    }
  },
}));
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

const rows = () => screen.getAllByTestId('exchange-row').map((r) => r.textContent ?? '');

describe('Hiding Android’s own traffic from the Setup page', () => {
  it('opens Traffic with a search that hides the system’s requests and keeps the app’s', async () => {
    render(<App />);
    await act(async () => undefined);
    await act(async () =>
      fake.clients.at(-1)!.onMessage({
        type: 'hello',
        status: {
          ...status(),
          certificate: {
            commonName: 'Wirescry CA (1234abcd)',
            spkiFingerprint: 'x',
            sha256: 'AB:CD',
            validTo: '2030-01-01',
            path: '/data/ca.pem',
          },
          android: {
            state: 'ready',
            devices: [
              {
                serial: 'emulator-5554',
                state: 'ready',
                label: 'Pixel 8',
                emulator: true,
                apiLevel: 37,
                id: 'c'.repeat(32),
                capture: { devicePort: 40000, hostPort: 8001, localAccess: false },
              },
            ],
          },
        },
        exchanges: [
          summary('probe', {
            host: 'connectivitycheck.gstatic.com',
            path: '/generate_204',
            url: 'http://connectivitycheck.gstatic.com/generate_204',
            protocol: 'http',
            status: 204,
          }),
          summary('gen', {
            host: 'www.google.com',
            path: '/gen_204',
            url: 'http://www.google.com/gen_204',
            protocol: 'http',
            status: 204,
          }),
          summary('app', { host: 'api.example.test', path: '/v1/items' }),
          summary('search', { host: 'www.google.com', path: '/search' }),
        ],
        paused: false,
      } as ServerMessage),
    );
    expect(rows()).toHaveLength(4);
    const hide = (): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
      fireEvent.click(screen.getByRole('button', { name: 'Hide Android’s background traffic in Traffic' }));
    };
    hide();

    const search = screen.getByRole('searchbox', { name: 'Search traffic' }) as HTMLInputElement;
    expect(search.value).toBe(HIDE_ANDROID_SYSTEM_QUERY);
    const shown = rows();
    expect(shown).toHaveLength(2);
    expect(shown.some((r) => r.includes('/v1/items'))).toBe(true);
    expect(shown.some((r) => r.includes('/search'))).toBe(true);

    // A search the user typed is kept, and a second click adds nothing.
    fireEvent.change(search, { target: { value: 'method=GET' } });
    hide();
    hide();
    expect((screen.getByRole('searchbox', { name: 'Search traffic' }) as HTMLInputElement).value).toBe(
      `method=GET ${HIDE_ANDROID_SYSTEM_QUERY}`,
    );
  });
});
