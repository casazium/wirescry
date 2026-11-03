import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { status, summary } from './fixtures';

/** Stands in for the WebSocket client: records connections, lets the test push messages. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{
    connection: unknown;
    onMessage(message: unknown): void;
    onClose(): void;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async () => undefined);
    close = vi.fn();
    constructor(
      public connection: unknown,
      public onMessage: (message: unknown) => void,
      public onClose: () => void,
    ) {
      fake.clients.push(this);
    }
  },
}));

const { useBackend } = await import('../../src/renderer/src/useBackend');

let changeState: (state: BackendState) => void = () => {};
const ready = (
  generation: number,
  restart?: { at: number; exitCode?: number; byUser?: true },
): BackendState => ({
  state: 'ready',
  connection: { apiUrl: `ws://127.0.0.1:${9000 + generation}/`, token: 't' },
  generation,
  ...(restart ? { restart } : {}),
});
const hello = (ids: string[], paused = false): ServerMessage =>
  ({ type: 'hello', status: status(), exchanges: ids.map((id) => summary(id)), paused }) as ServerMessage;
const latest = () => fake.clients.at(-1)!;

beforeEach(() => {
  fake.clients.length = 0;
  window.wirescry = {
    getBackendState: async () => ({ state: 'starting' }),
    onBackendStateChanged: (callback: (state: BackendState) => void) => {
      changeState = callback;
      return () => undefined;
    },
  } as unknown as WirescryBridge;
});
afterEach(() => vi.useRealTimers());

async function started() {
  const hook = renderHook(() => useBackend(() => undefined));
  // Let the hook's first getBackendState reply ('starting') land before driving the state.
  await act(async () => undefined);
  await act(async () => changeState(ready(1)));
  await act(async () => latest().onMessage(hello(['a', 'b'])));
  return hook;
}

describe('useBackend across backend restarts', () => {
  it('keeps the old rows, apart and without duplicates, and says what happened', async () => {
    const { result } = await started();
    expect(result.current.exchanges.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.restartNotice).toBeUndefined();

    // The backend crashes and a new one starts.
    await act(async () => changeState({ state: 'starting', restart: { at: 1000, exitCode: 9 } }));
    expect(result.current.connected).toBe(true); // Until the client notices the drop.
    await act(async () => changeState(ready(2, { at: 1000, exitCode: 9 })));
    await act(async () => latest().onMessage(hello(['c'])));

    expect(result.current.previous.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.exchanges.map((e) => e.id)).toEqual(['c']);
    expect(result.current.restartNotice).toMatchObject({ at: 1000, crashed: true, kept: 2, dropped: 0 });
    expect(result.current.session).toBe(2);
  });

  it('counts rows kept through earlier restarts, and a restart the user asked for', async () => {
    const { result } = await started();
    await act(async () => changeState(ready(2, { at: 1, exitCode: 9 })));
    await act(async () => latest().onMessage(hello([])));
    await act(async () => changeState(ready(3, { at: 2, byUser: true })));
    await act(async () => latest().onMessage(hello(['d'])));
    expect(result.current.previous.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.restartNotice).toMatchObject({ crashed: false, kept: 2 });
  });

  it('doesn’t treat a reconnect to the same backend as a restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { result } = await started();
    const first = latest();
    await act(async () => first.onClose());
    await act(async () => vi.advanceTimersByTime(1000));
    expect(latest()).not.toBe(first);
    await act(async () => latest().onMessage(hello(['a', 'b', 'c'])));
    expect(result.current.restartNotice).toBeUndefined();
    expect(result.current.previous).toEqual([]);
    expect(result.current.session).toBe(1);
  });

  it('keeps recording paused through a restart', async () => {
    const { result } = await started();
    await act(async () => latest().onMessage({ type: 'paused', paused: true } as ServerMessage));
    await act(async () => changeState(ready(2, { at: 1, exitCode: 9 })));
    await act(async () => latest().onMessage(hello([], false)));
    expect(result.current.paused).toBe(true);
    expect(latest().send).toHaveBeenCalledWith({ command: 'setPaused', paused: true });
  });

  it('counts paused requests a plugin had waiting, but not tags such as PRO', async () => {
    const { result } = await started();
    await act(async () => {
      result.current.pluginApi('pro').setBadge('breakpoints', '2');
      result.current.pluginApi('pro').setBadge('rules', 'PRO', { tag: true });
    });
    await act(async () => changeState(ready(2, { at: 1, exitCode: 9 })));
    await act(async () => latest().onMessage(hello([])));
    expect(result.current.restartNotice?.dropped).toBe(2);
    expect(result.current.badges).toEqual({});
  });

  it('empties the old rows on Clear', async () => {
    const { result } = await started();
    await act(async () => changeState(ready(2, { at: 1, exitCode: 9 })));
    await act(async () => latest().onMessage(hello([])));
    expect(result.current.previous).toHaveLength(2);
    await act(async () => latest().onMessage({ type: 'cleared' } as ServerMessage));
    expect(result.current.previous).toEqual([]);
  });
});
