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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('useBackend removeExchanges', () => {
  const update = (ids: string[], removed: string[] = []): ServerMessage =>
    ({ type: 'exchanges', exchanges: ids.map((id) => summary(id)), removed }) as ServerMessage;

  it('drops the rows at once, keeps them gone until the backend confirms, and asks for just those', async () => {
    const { result } = await started();
    await act(async () => result.current.removeExchanges(new Set(['a'])));
    expect(result.current.exchanges.map((e) => e.id)).toEqual(['b']);
    expect(latest().send).toHaveBeenCalledWith({ command: 'clear', ids: ['a'] });
    // An update for 'a' that was already on its way doesn't bring it back.
    await act(async () => latest().onMessage(update(['a', 'c'])));
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(result.current.exchanges.map((e) => e.id)).toEqual(['b', 'c']);
    await act(async () => latest().onMessage(update([], ['a'])));
    // Once confirmed, the id is no longer filtered.
    await act(async () => latest().onMessage(update(['a'])));
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(result.current.exchanges.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('asks again after a reconnect if the delete was lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { result } = await started();
    await act(async () => result.current.removeExchanges(new Set(['a'])));
    const first = latest();
    await act(async () => first.onClose());
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => latest().onMessage(hello(['a', 'b'])));
    expect(result.current.exchanges.map((e) => e.id)).toEqual(['b']);
    expect(latest().send).toHaveBeenCalledWith({ command: 'clear', ids: ['a'] });
  });

  it('drops rows from before a restart without asking the new backend', async () => {
    const { result } = await started();
    await act(async () => changeState(ready(2, { at: 1, exitCode: 9 })));
    await act(async () => latest().onMessage(hello(['c'])));
    await act(async () => result.current.removeExchanges(new Set(['a', 'c'])));
    expect(result.current.previous.map((e) => e.id)).toEqual(['b']);
    expect(result.current.exchanges).toEqual([]);
    expect(latest().send).toHaveBeenCalledWith({ command: 'clear', ids: ['c'] });
  });
});

describe('what plugins get from the window', () => {
  const event = (plugin: string, name: string, data: unknown): ServerMessage =>
    ({ type: 'plugin', plugin, event: name, data }) as ServerMessage;

  it('passes a plugin its own events, and only those', async () => {
    const { result } = await started();
    const rules = vi.fn();
    const other = vi.fn();
    result.current.pluginApi('pro').on('rules', rules);
    result.current.pluginApi('other').on('rules', other);
    await act(async () => latest().onMessage(event('pro', 'rules', { count: 2 })));
    expect(rules).toHaveBeenCalledWith({ count: 2 });
    expect(other).not.toHaveBeenCalled();
    // Another event of the same plugin isn't this one.
    await act(async () => latest().onMessage(event('pro', 'license', {})));
    expect(rules).toHaveBeenCalledTimes(1);
  });

  it('keeps calling the other listeners when one throws, and stops a listener that unsubscribed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    const broken = vi.fn(() => {
      throw new Error('listener broke');
    });
    const fine = vi.fn();
    api.on('rules', broken);
    const stop = api.on('rules', fine);
    await act(async () => latest().onMessage(event('pro', 'rules', 1)));
    expect(fine).toHaveBeenCalledWith(1);
    expect(errors).toHaveBeenCalledWith('[wirescry] pro listener for rules failed:', expect.any(Error));
    stop();
    await act(async () => latest().onMessage(event('pro', 'rules', 2)));
    expect(fine).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(2);
  });

  it('gives each plugin one API object for the session', async () => {
    const { result } = await started();
    expect(result.current.pluginApi('pro')).toBe(result.current.pluginApi('pro'));
    expect(result.current.pluginApi('pro')).not.toBe(result.current.pluginApi('other'));
  });

  it('sends a plugin’s calls, and asks for exchanges and bodies on its behalf', async () => {
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    await api.call('rules.list', { a: 1 });
    expect(latest().send).toHaveBeenCalledWith({
      command: 'plugin',
      plugin: 'pro',
      name: 'rules.list',
      args: { a: 1 },
    });
    await api.getExchange('a');
    expect(latest().send).toHaveBeenCalledWith({ command: 'getExchange', exchangeId: 'a' });
    await api.getBody('a', 'request');
    expect(latest().send).toHaveBeenCalledWith({ command: 'getBody', exchangeId: 'a', side: 'request' });
    // Anything but "request" means the response.
    await api.getBody('a', 'other' as never);
    expect(latest().send).toHaveBeenLastCalledWith({ command: 'getBody', exchangeId: 'a', side: 'response' });
  });

  it('refuses a plugin’s calls while not connected', async () => {
    const hook = renderHook(() => useBackend(() => undefined));
    await act(async () => undefined);
    await expect(hook.result.current.pluginApi('pro').call('rules.list')).rejects.toThrow('Not connected');
  });

  it('opens a plugin’s own view by its id', async () => {
    const showView = vi.fn();
    const hook = renderHook(() => useBackend(showView));
    await act(async () => undefined);
    hook.result.current.pluginApi('pro').showView('rules');
    expect(showView).toHaveBeenCalledWith('pro:rules');
  });

  it('keeps a tab badge short, with an optional tag and label, and clears it', async () => {
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    await act(async () => api.setBadge('breakpoints', '1234567890'));
    expect(result.current.badges['pro:breakpoints']).toEqual({ text: '123456', tag: false });
    await act(async () => api.setBadge('apis', 'PRO', { tag: true, label: 'L'.repeat(100) }));
    expect(result.current.badges['pro:apis']).toEqual({ text: 'PRO', tag: true, label: 'L'.repeat(80) });
    // An empty label is left out.
    await act(async () => api.setBadge('apis', 'PRO', { tag: true, label: '' }));
    expect(result.current.badges['pro:apis']).toEqual({ text: 'PRO', tag: true });
    await act(async () => api.setBadge('breakpoints', ''));
    expect(result.current.badges).not.toHaveProperty('pro:breakpoints');
    await act(async () => api.setBadge('apis', undefined as never));
    expect(result.current.badges).toEqual({});
  });

  it('doesn’t change the badges when one is set to what it already is', async () => {
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    await act(async () => api.setBadge('breakpoints', '2'));
    const before = result.current.badges;
    await act(async () => api.setBadge('breakpoints', '2'));
    expect(result.current.badges).toBe(before);
    await act(async () => api.setBadge('breakpoints', '3'));
    expect(result.current.badges).not.toBe(before);
  });

  it('keeps the badges, the API object and its listeners when it reconnects to the same backend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    const listener = vi.fn();
    api.on('rules', listener);
    await act(async () => api.setBadge('breakpoints', '2'));
    await act(async () => latest().onClose());
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => latest().onMessage(hello(['a', 'b'])));
    expect(result.current.badges['pro:breakpoints']).toEqual({ text: '2', tag: false });
    expect(result.current.pluginApi('pro')).toBe(api);
    await act(async () => latest().onMessage(event('pro', 'rules', 'again')));
    expect(listener).toHaveBeenCalledWith('again');
  });

  it('keeps a plugin’s listeners through a restart, so the new backend’s events reach them', async () => {
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    const listener = vi.fn();
    api.on('rules', listener);
    await act(async () => changeState(ready(2, { at: 1, byUser: true })));
    await act(async () => latest().onMessage(hello([])));
    await act(async () => latest().onMessage(event('pro', 'rules', 'from the new one')));
    expect(listener).toHaveBeenCalledWith('from the new one');
    expect(result.current.pluginApi('pro')).toBe(api);
  });

  it('opens the file dialogs for a plugin', async () => {
    const saveTextFile = vi.fn(async () => ({ name: 'a.json' }));
    const openTextFile = vi.fn(async () => ({ name: 'b.json', text: '{}' }));
    const chooseFilePath = vi.fn(async () => ({ path: '/x' }));
    Object.assign(window.wirescry, { saveTextFile, openTextFile, chooseFilePath });
    const { result } = await started();
    const api = result.current.pluginApi('pro');
    const save = { defaultName: 'rules.json', text: '[]' };
    expect(await api.saveFile(save as never)).toEqual({ name: 'a.json' });
    expect(saveTextFile).toHaveBeenCalledWith(save);
    expect(await api.openFile({ extensions: ['json'] })).toEqual({ name: 'b.json', text: '{}' });
    expect(openTextFile).toHaveBeenCalledWith({ extensions: ['json'] });
    expect(await api.chooseFile()).toEqual({ path: '/x' });
    // Without options, the dialog gets an empty set.
    expect(chooseFilePath).toHaveBeenCalledWith({});
  });
});
