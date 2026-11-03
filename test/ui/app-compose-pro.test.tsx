import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { status, summary } from './fixtures';

/** Stands in for the WebSocket client; `reply` answers each command by name. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  reply: (() => undefined) as (command: { command: string; [key: string]: unknown }) => unknown,
}));
const beforeSend = vi.hoisted(() => vi.fn((r: { url: string }) => ({ ...r, url: `${r.url}?filled=1` })));
vi.mock('@wirescry/pro/ui', async () => {
  const { PLUGIN_API_VERSION } = await import('../../src/plugin-api/version');
  return {
    uiPlugins: [{ name: 'pro', apiVersion: PLUGIN_API_VERSION, views: [], composer: { beforeSend } }],
  };
});
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string }) => fake.reply(command));
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

let menuChoice: string | undefined;
const client = () => fake.clients.at(-1)!;
const commands = (name: string) =>
  client()
    .send.mock.calls.map(([c]) => c as { command: string; [key: string]: unknown })
    .filter((c) => c.command === name);

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  fake.clients.length = 0;
  menuChoice = undefined;
  fake.reply = () => undefined;
  const ready: BackendState = {
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
      showMenu: async () => menuChoice,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
});

async function started(
  rows = [summary('r1', { method: 'POST', url: 'https://api.test/items' })],
  plugins: unknown[] = [],
) {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    client().onMessage({
      type: 'hello',
      status: { ...status(), plugins },
      exchanges: rows,
      paused: false,
    } as ServerMessage),
  );
}

const compose = () => fireEvent.click(screen.getByRole('button', { name: 'Compose' }));

describe('Send while Pro is starting', () => {
  beforeEach(() => {
    beforeSend.mockClear();
    fake.reply = (c) => (c.command === 'composeSend' ? { exchangeId: 'c9' } : undefined);
  });

  it('waits with a message instead of sending without Pro’s changes', async () => {
    await started([], [{ name: 'pro', active: false, reason: 'Starting…', starting: true }]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Wirescry Pro is still starting. Try again in a moment.',
    );
    expect(commands('composeSend')).toHaveLength(0);
    expect(beforeSend).not.toHaveBeenCalled();
  });

  it('sends through Pro once it’s running', async () => {
    await started([], [{ name: 'pro', active: true }]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(commands('composeSend')[0]?.request).toMatchObject({ url: 'https://api.test/x?filled=1' });
  });

  it('sends as written when Pro isn’t running for another reason, such as no license', async () => {
    await started([], [{ name: 'pro', active: false, reason: 'Pro needs a license.' }]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(commands('composeSend')[0]?.request).toMatchObject({ url: 'https://api.test/x' });
  });
});
