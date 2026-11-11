import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { detail, status, summary } from './fixtures';

/** Stands in for the WebSocket client; `reply` answers each command by name. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  reply: (() => undefined) as (command: { command: string; [key: string]: unknown }) => unknown,
}));
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
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

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

async function started(rows = [summary('r1', { method: 'POST', url: 'https://api.test/items' })]) {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    client().onMessage({ type: 'hello', status: status(), exchanges: rows, paused: false } as ServerMessage),
  );
}

const compose = () => fireEvent.click(screen.getByRole('button', { name: 'Compose' }));
const traffic = () => fireEvent.click(screen.getByRole('button', { name: 'Traffic' }));

describe('Edit and resend', () => {
  beforeEach(() => {
    fake.reply = (c) => {
      if (c.command === 'getExchange') {
        return {
          ...detail(summary('r1', { method: 'POST', url: 'https://api.test/items' }), 'x'),
          requestHeaders: [
            [':method', 'POST'],
            ['content-type', 'application/json'],
            ['content-length', '7'],
          ],
          requestBody: { size: 7, stored: 7 },
        };
      }
      if (c.command === 'getBody') {
        return { base64: Buffer.from('{"a":1}').toString('base64'), size: 7, truncated: false };
      }
      return undefined;
    };
  });

  it('opens a captured request in Compose from the row menu', async () => {
    await started();
    menuChoice = 'wirescry:edit-and-resend';
    await act(async () => {
      fireEvent.contextMenu(screen.getAllByTestId('exchange-row')[0]!);
    });
    await act(async () => undefined);
    expect((screen.getByLabelText('Method') as HTMLInputElement).value).toBe('POST');
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.test/items');
    expect((screen.getByLabelText('Headers') as HTMLTextAreaElement).value).toBe(
      'content-type: application/json',
    );
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('{"a":1}');
    expect(screen.queryByText(/Replaced the request/)).toBeNull();
  });

  it('replaces unsent edits with a way to undo, and only then', async () => {
    await started();
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mine.test/draft' } });
    traffic();
    menuChoice = 'wirescry:edit-and-resend';
    await act(async () => {
      fireEvent.contextMenu(screen.getAllByTestId('exchange-row')[0]!);
    });
    await act(async () => undefined);
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.test/items');
    expect(screen.getByText(/Replaced the request you were writing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://mine.test/draft');
    expect(screen.queryByText(/Replaced the request/)).toBeNull();
  });

  it('isn’t offered for a WebSocket', async () => {
    await started([summary('ws', { websocket: true })]);
    const showMenu = vi.spyOn(window.wirescry, 'showMenu');
    await act(async () => {
      fireEvent.contextMenu(screen.getAllByTestId('exchange-row')[0]!);
    });
    const choices = showMenu.mock.calls[0]?.[0] ?? [];
    expect(choices.some((c) => 'id' in c && c.id === 'wirescry:edit-and-resend')).toBe(false);
  });
});

describe('Send and Cancel', () => {
  it('sends, shows Cancel while the response is on its way, and Send once it has arrived', async () => {
    fake.reply = (c) =>
      c.command === 'composeSend'
        ? { exchangeId: 'c1' }
        : c.command === 'composeCancel'
          ? true
          : c.command === 'getExchange'
            ? detail(summary('c1', { composed: true }), 'x')
            : undefined;
    await started([]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/new' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(commands('composeSend')[0]?.request).toEqual({
      method: 'GET',
      url: 'https://api.test/new',
      headers: [],
      body: '',
    });
    // The row arrives, still waiting for its response.
    const pending = summary('c1', { composed: true, status: undefined, durationMs: undefined });
    await act(async () =>
      client().onMessage({ type: 'exchanges', exchanges: [pending], removed: [] } as ServerMessage),
    );
    await frame();
    await frame();
    expect(screen.getByText('Waiting for the response…')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(commands('composeCancel')).toEqual([expect.objectContaining({ exchangeId: 'c1' })]);
    // Cancel has done its job even before the row shows the failure.
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('shows Send, not Cancel, once the response is complete, and announces it', async () => {
    fake.reply = (c) =>
      c.command === 'composeSend'
        ? { exchangeId: 'c2' }
        : c.command === 'getExchange'
          ? detail(summary('c2', { composed: true }), 'x')
          : undefined;
    await started([]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/done' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    await act(async () =>
      client().onMessage({
        type: 'exchanges',
        exchanges: [summary('c2', { composed: true, status: 201, statusMessage: 'Created' })],
        removed: [],
      } as ServerMessage),
    );
    await frame();
    await frame();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('Response: 201 Created')).toBeTruthy();
  });

  it('says a response is still arriving, keeps Cancel, then announces it finished', async () => {
    fake.reply = (c) =>
      c.command === 'composeSend'
        ? { exchangeId: 'c9' }
        : c.command === 'getExchange'
          ? detail(summary('c9', { composed: true }), 'x')
          : undefined;
    await started([]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/stream' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    const arriving = summary('c9', {
      composed: true,
      status: 200,
      statusMessage: 'OK',
      responding: true,
      responseReceived: 10,
      responseSize: undefined,
      durationMs: undefined,
    });
    await act(async () =>
      client().onMessage({ type: 'exchanges', exchanges: [arriving], removed: [] } as ServerMessage),
    );
    await frame();
    await frame();
    expect(screen.getByText('Response: 200 OK, still receiving')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await act(async () =>
      client().onMessage({
        type: 'exchanges',
        exchanges: [summary('c9', { composed: true, status: 200, statusMessage: 'OK' })],
        removed: [],
      } as ServerMessage),
    );
    await frame();
    await frame();
    expect(screen.getByText('Response: 200 OK')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows the response before the request it sent, unlike Traffic', async () => {
    fake.reply = (c) =>
      c.command === 'composeSend'
        ? { exchangeId: 'c3' }
        : c.command === 'getExchange'
          ? { ...detail(summary('c3', { composed: true }), 'x'), responseBody: { size: 10, stored: 10 } }
          : undefined;
    await started([]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/first' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    await act(async () =>
      client().onMessage({
        type: 'exchanges',
        exchanges: [summary('c3', { composed: true, status: 200 })],
        removed: [],
      } as ServerMessage),
    );
    await frame();
    await frame();
    const headings = [...document.querySelectorAll('.composer-response h2, .composer-response summary')].map(
      (e) => e.textContent,
    );
    expect(headings.indexOf('Response body')).toBeGreaterThan(-1);
    expect(headings.indexOf('Response body')).toBeLessThan(headings.indexOf('Request headers'));
  });

  it('shows the backend’s reason when a send is refused, and sends nothing more', async () => {
    fake.reply = (c) => {
      if (c.command === 'composeSend')
        throw new Error('Enter a full URL, starting with http:// or https://.');
      return undefined;
    };
    await started([]);
    compose();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a full URL');
    expect(commands('composeSend')).toHaveLength(1);
  });
});
