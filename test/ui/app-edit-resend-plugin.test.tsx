/** Edit and resend with a plugin that fills in what the app can't (src/renderer/src/App.tsx). */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerRequest, ExchangeSummary, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { detail, status, summary } from './fixtures';

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  /** What the plugin was given, per call. */
  seen: [] as Array<{ path: string; request: ComposerRequest }>,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string; exchangeId?: string }) => {
      if (command.command === 'getExchange') {
        const id = command.exchangeId ?? 'x';
        return {
          ...detail(summary(id, { method: 'POST', url: `https://api.test/${id}` }), 'x'),
          requestHeaders: [
            [':method', 'POST'],
            ['content-type', id === 'grpc' ? 'application/grpc' : 'application/json'],
            ['content-length', '7'],
          ],
          requestBody: { size: 7, stored: 7 },
        };
      }
      if (command.command === 'getBody') {
        // A gRPC frame isn't text: the app leaves it out.
        return command.exchangeId === 'grpc'
          ? { base64: Buffer.from([0, 0, 0, 0, 2, 0x0a, 0]).toString('base64'), size: 7, truncated: false }
          : { base64: Buffer.from('{"a":1}').toString('base64'), size: 7, truncated: false };
      }
      return undefined;
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

/** Fills in a gRPC call's message as JSON; leaves everything else to the app. */
vi.mock('@wirescry/pro/ui', async () => {
  const { PLUGIN_API_VERSION } = await import('../../src/plugin-api/version');
  return {
    uiPlugins: [
      {
        name: 'pro',
        apiVersion: PLUGIN_API_VERSION,
        views: [],
        composer: {
          fromExchange: async (exchange: ExchangeSummary, request: ComposerRequest) => {
            fake.seen.push({ path: exchange.path, request });
            if (exchange.path === '/broken') throw new Error('plugin broke');
            if (exchange.path !== '/grpc') return undefined;
            return { request: { ...request, body: '{\n  "id": ""\n}' }, note: 'Read with shop.binpb.' };
          },
        },
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
  fake.seen.length = 0;
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
      showMenu: async () => 'wirescry:edit-and-resend',
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
});

async function editAndResend(id: string, active = true) {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    client().onMessage({
      type: 'hello',
      status: { ...status(), plugins: [{ name: 'pro', active }] },
      exchanges: [summary(id, { method: 'POST', url: `https://api.test/${id}` })],
      paused: false,
    } as ServerMessage),
  );
  await act(async () => {
    fireEvent.contextMenu(screen.getAllByTestId('exchange-row')[0]!);
  });
  await act(async () => undefined);
}

const body = () => (screen.getByLabelText('Body') as HTMLTextAreaElement).value;

describe('Edit and resend with a plugin', () => {
  it('opens what the plugin made of it, with its note, given the app’s own request', async () => {
    await editAndResend('grpc');
    expect(body()).toBe('{\n  "id": ""\n}');
    expect(screen.getByText('Read with shop.binpb.')).toBeTruthy();
    // The plugin got the app's request: headers Wirescry sets left out, the body left out.
    expect(fake.seen).toEqual([
      {
        path: '/grpc',
        request: {
          method: 'POST',
          url: 'https://api.test/grpc',
          headers: [['content-type', 'application/grpc']],
          body: '',
        },
      },
    ]);
    expect(screen.queryByText(/isn’t text/)).toBeNull();
  });

  it('keeps the app’s request when the plugin doesn’t answer, or throws', async () => {
    await editAndResend('items');
    expect(body()).toBe('{"a":1}');
    expect(fake.seen.map((s) => s.path)).toEqual(['/items']);
  });

  it('keeps the app’s request, and its note, when the plugin throws', async () => {
    await editAndResend('broken');
    expect(body()).toBe('{"a":1}');
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.test/broken');
  });

  it('doesn’t ask a plugin that isn’t running', async () => {
    await editAndResend('grpc', false);
    expect(fake.seen).toEqual([]);
    expect(body()).toBe('');
    expect(screen.getByText(/The body isn’t text, so it was left out/)).toBeTruthy();
  });
});
