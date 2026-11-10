/**
 * The main window's own actions (src/renderer/src/App.tsx): moving through the list with the
 * keyboard, the right-click menu on a request, HAR import and export, the quick-filter chips,
 * the app menu's commands, and launching a browser.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary, ServerMessage } from '../../src/shared/api';
import type { BackendState, MenuCommand, WirescryBridge } from '../../src/shared/ipc';
import { detail, status, summary } from './fixtures';

/** Stands in for the WebSocket client. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  answer: undefined as undefined | ((command: { command: string; exchangeId?: string }) => unknown),
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string; exchangeId?: string }) => {
      if (fake.answer) return fake.answer(command);
      return command.command === 'getExchange' ? detail(summary(command.exchangeId ?? 'x'), 'm') : undefined;
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

afterEach(() => vi.restoreAllMocks());
const client = () => fake.clients.at(-1)!;

let bridge: {
  showMenu: ReturnType<typeof vi.fn>;
  exportHar: ReturnType<typeof vi.fn>;
  importHar: ReturnType<typeof vi.fn>;
  setMenuState: ReturnType<typeof vi.fn>;
  menu?: (command: MenuCommand) => void;
};
let clipboard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  fake.clients.length = 0;
  fake.answer = undefined;
  const ready = {
    state: 'ready',
    connection: { apiUrl: 'ws://127.0.0.1:9001/', token: 't' },
    generation: 1,
  } as BackendState;
  bridge = {
    showMenu: vi.fn(async () => undefined),
    exportHar: vi.fn(async () => ({})),
    importHar: vi.fn(async () => ({})),
    setMenuState: vi.fn(),
  };
  window.wirescry = new Proxy(
    {
      getBackendState: async () => ready,
      onBackendStateChanged: () => () => undefined,
      onMenuCommand: (callback: (command: MenuCommand) => void) => {
        bridge.menu = callback;
        return () => undefined;
      },
      ...bridge,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});

const a = summary('a', { path: '/a', url: 'https://api.test/a' });
const b = summary('b', { path: '/b', url: 'https://api.test/b', contentType: 'text/html' });
const c = summary('c', { path: '/c', url: 'https://api.test/c' });

async function started(rows: ExchangeSummary[] = [a, b, c], extra: Record<string, unknown> = {}) {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    client().onMessage({
      type: 'hello',
      status: { ...status(), ...extra },
      exchanges: rows,
      paused: false,
    } as ServerMessage),
  );
}
const rowsShown = () => screen.queryAllByTestId('exchange-row');
const selected = () => rowsShown().findIndex((r) => r.getAttribute('aria-selected') === 'true');
const list = () => document.querySelector('.traffic-scroll')!;
const press = (el: Element, key: string) => act(async () => void fireEvent.keyDown(el, { key }));
const alertText = () => screen.queryByRole('alert')?.textContent;
const noticeText = () =>
  screen
    .queryAllByRole('status')
    .map((s) => s.textContent ?? '')
    .find((t) => /Exported|Imported/.test(t));

describe('moving through the list with the keyboard', () => {
  it('selects the next and previous request, stops at the ends, and Escape deselects', async () => {
    await started();
    expect(selected()).toBe(-1);
    await press(list(), 'ArrowDown');
    expect(selected()).toBe(0);
    await press(list(), 'ArrowDown');
    await press(list(), 'ArrowDown');
    expect(selected()).toBe(2);
    await press(list(), 'ArrowDown');
    expect(selected()).toBe(2);
    await press(list(), 'ArrowUp');
    expect(selected()).toBe(1);
    await press(list(), 'ArrowUp');
    await press(list(), 'ArrowUp');
    expect(selected()).toBe(0);
    await press(list(), 'Escape');
    expect(selected()).toBe(-1);
  });

  it('starts from the top with Up too, and ignores other keys', async () => {
    await started();
    await press(list(), 'ArrowUp');
    expect(selected()).toBe(0);
    await press(list(), 'a');
    expect(selected()).toBe(0);
  });

  it('does nothing in an empty list', async () => {
    await started([]);
    await press(list(), 'ArrowDown');
    expect(selected()).toBe(-1);
  });
});

describe('the right-click menu on a request', () => {
  const rightClick = (index: number) => act(async () => void fireEvent.contextMenu(rowsShown()[index]!));

  it('offers to copy the URL or a curl command, and selects the request', async () => {
    await started();
    await rightClick(1);
    expect(bridge.showMenu).toHaveBeenCalledWith([
      { id: 'copy-url', label: 'Copy URL' },
      { id: 'copy-curl', label: 'Copy as curl' },
      { separator: true },
      { id: 'wirescry:edit-and-resend', label: 'Edit and resend…' },
    ]);
    expect(selected()).toBe(1);
  });

  it('copies the URL', async () => {
    await started();
    bridge.showMenu.mockResolvedValueOnce('copy-url');
    await rightClick(2);
    expect(clipboard).toHaveBeenCalledWith('https://api.test/c');
  });

  it('copies a curl command for the request', async () => {
    await started();
    bridge.showMenu.mockResolvedValueOnce('copy-curl');
    await rightClick(0);
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(clipboard.mock.calls[0]![0]).toMatch(/^curl /);
    expect(clipboard.mock.calls[0]![0]).toContain('https://api.test/a');
  });

  it('doesn’t offer curl for a WebSocket connection', async () => {
    await started([summary('w', { websocket: true, messageCount: 0 })]);
    await rightClick(0);
    expect(bridge.showMenu).toHaveBeenCalledWith([{ id: 'copy-url', label: 'Copy URL' }]);
  });

  it('does nothing when the menu is closed without a choice', async () => {
    await started();
    await rightClick(0);
    expect(clipboard).not.toHaveBeenCalled();
    expect(alertText()).toBeUndefined();
  });

  it('says why when the menu can’t be shown, or the copy fails', async () => {
    await started();
    bridge.showMenu.mockRejectedValueOnce(new Error('no window'));
    await rightClick(0);
    expect(alertText()).toContain('Couldn’t show the menu: no window'.replace('’', "'"));
    bridge.showMenu.mockResolvedValueOnce('copy-url');
    clipboard.mockRejectedValueOnce(new Error('denied'));
    await rightClick(0);
    expect(alertText()).toContain("Couldn't copy: denied");
  });
});

describe('HAR export', () => {
  const exportButton = () => screen.getByRole('button', { name: 'Export HAR' });

  it('exports the requests shown, in order, and says how many went where', async () => {
    await started();
    bridge.exportHar.mockResolvedValueOnce({ name: 'traffic.har', count: 3 });
    await act(async () => void fireEvent.click(exportButton()));
    expect(bridge.exportHar).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(noticeText()).toContain('Exported 3 requests to traffic.har.');
  });

  it('exports only what the filter shows, and says one request', async () => {
    await started();
    await act(async () => void fireEvent.click(screen.getByRole('radio', { name: 'HTML' })));
    bridge.exportHar.mockResolvedValueOnce({ name: 'one.har', count: 1 });
    await act(async () => void fireEvent.click(exportButton()));
    expect(bridge.exportHar).toHaveBeenCalledWith(['b']);
    expect(noticeText()).toContain('Exported 1 request to one.har.');
  });

  it('says nothing when the save is canceled, and why when it fails', async () => {
    await started();
    await act(async () => void fireEvent.click(exportButton()));
    expect(noticeText()).toBeUndefined();
    expect(alertText()).toBeUndefined();
    bridge.exportHar.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => void fireEvent.click(exportButton()));
    expect(alertText()).toContain("Couldn't export: disk full");
  });

  it('can’t export an empty list', async () => {
    await started([]);
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('HAR import', () => {
  const importButton = () => screen.getByRole('button', { name: 'Import HAR' });

  it('says how many were imported, skipped, and pushed out to make room', async () => {
    await started();
    bridge.importHar.mockResolvedValueOnce({
      name: 'site.har',
      imported: 1200,
      skipped: 2,
      removed: 1,
      problems: ['Two entries had no URL.'],
    });
    await act(async () => void fireEvent.click(importButton()));
    expect(noticeText()).toContain(
      'Imported 1,200 requests from site.har. Skipped 2: Two entries had no URL. To make room, the oldest 1 request left the list.',
    );
  });

  it('says one request, with nothing skipped', async () => {
    await started();
    bridge.importHar.mockResolvedValueOnce({ name: 'one.har', imported: 1 });
    await act(async () => void fireEvent.click(importButton()));
    expect(noticeText()).toBe('Imported 1 request from one.har.×');
  });

  it('says so when there was nothing to import, and why', async () => {
    await started();
    bridge.importHar.mockResolvedValueOnce({
      name: 'empty.har',
      imported: 0,
      problems: ['It has no entries.'],
    });
    await act(async () => void fireEvent.click(importButton()));
    expect(alertText()).toContain('Nothing to import from empty.har. It has no entries.');
    expect(noticeText()).toBeUndefined();
  });

  it('says nothing when canceled, and why when it fails', async () => {
    await started();
    await act(async () => void fireEvent.click(importButton()));
    expect(alertText()).toBeUndefined();
    bridge.importHar.mockRejectedValueOnce(new Error('not a HAR file'));
    await act(async () => void fireEvent.click(importButton()));
    expect(alertText()).toContain("Couldn't import: not a HAR file");
  });
});

describe('the quick-filter chips', () => {
  const chips = () => screen.getAllByRole('radio');
  const checked = () => chips().find((c) => c.getAttribute('aria-checked') === 'true')?.textContent;
  const group = () => screen.getByRole('radiogroup', { name: 'Quick filter' });

  it('move with the arrow keys, wrapping at the ends, and Home and End', async () => {
    await started();
    expect(checked()).toBe('All');
    await press(group(), 'ArrowRight');
    expect(checked()).toBe('JSON');
    expect(document.activeElement?.textContent).toBe('JSON');
    await press(group(), 'ArrowDown');
    expect(checked()).toBe('HTML');
    await press(group(), 'ArrowLeft');
    await press(group(), 'ArrowUp');
    expect(checked()).toBe('All');
    await press(group(), 'ArrowLeft');
    expect(checked()).toBe('Errors');
    await press(group(), 'ArrowRight');
    expect(checked()).toBe('All');
    await press(group(), 'End');
    expect(checked()).toBe('Errors');
    await press(group(), 'Home');
    expect(checked()).toBe('All');
  });

  it('leave other keys alone', async () => {
    await started();
    let notPrevented = false;
    await act(async () => void (notPrevented = fireEvent.keyDown(group(), { key: 'Tab' })));
    expect(notPrevented).toBe(true);
    expect(checked()).toBe('All');
  });

  it('filter the list, and the count says how many of all', async () => {
    await started();
    await act(async () => void fireEvent.click(screen.getByRole('radio', { name: 'HTML' })));
    expect(rowsShown()).toHaveLength(1);
    expect(screen.getByTestId('row-count').textContent).toBe('1 of 3');
  });
});

describe('the app menu’s commands', () => {
  const command = (name: MenuCommand) => act(async () => bridge.menu!(name));

  it('imports and exports HAR files', async () => {
    await started();
    await command('import-har');
    expect(bridge.importHar).toHaveBeenCalledTimes(1);
    await command('export-har');
    expect(bridge.exportHar).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('doesn’t export an empty list', async () => {
    await started([]);
    await command('export-har');
    expect(bridge.exportHar).not.toHaveBeenCalled();
  });

  it('pauses and resumes recording', async () => {
    await started();
    await command('toggle-recording');
    expect(client().send).toHaveBeenCalledWith({ command: 'setPaused', paused: true });
  });

  it('clears the list, but not while typing in a text field', async () => {
    await started();
    const search = screen.getByRole('searchbox');
    search.focus();
    await command('clear');
    expect(rowsShown()).toHaveLength(3);
    search.blur();
    await command('clear');
    expect(rowsShown()).toHaveLength(0);
  });

  it('goes to the search field with Find', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    await started();
    await command('find');
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('tells the menu what’s possible', async () => {
    await started([]);
    expect(bridge.setMenuState).toHaveBeenLastCalledWith({
      connected: true,
      canExport: false,
      paused: false,
    });
    await act(async () =>
      client().onMessage({ type: 'exchanges', exchanges: [a], removed: [] } as unknown as ServerMessage),
    );
    // New traffic reaches the list on the next frame.
    await vi.waitFor(() =>
      expect(bridge.setMenuState).toHaveBeenLastCalledWith({
        connected: true,
        canExport: true,
        paused: false,
      }),
    );
  });
});

describe('launching a browser', () => {
  const chrome = { id: 'chrome', name: 'Google Chrome', kind: 'chromium' };
  const edge = { id: 'edge', name: 'Microsoft Edge', kind: 'chromium' };

  it('launches the one browser by name', async () => {
    await started([a], { browsers: [chrome] });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Launch Google Chrome' })));
    expect(client().send).toHaveBeenCalledWith({ command: 'launchBrowser', browserId: 'chrome' });
  });

  it('launches the one picked when there are several', async () => {
    await started([a], { browsers: [chrome, edge] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Browser' }), { target: { value: 'edge' } });
    await act(
      async () => void fireEvent.click(screen.getByRole('button', { name: 'Launch Microsoft Edge' })),
    );
    expect(client().send).toHaveBeenCalledWith({ command: 'launchBrowser', browserId: 'edge' });
  });

  it('says why when the browser can’t be launched', async () => {
    fake.answer = (c) => {
      if (c.command === 'launchBrowser') throw new Error('Browser not found: chrome');
      return undefined;
    };
    await started([a], { browsers: [chrome] });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Launch Google Chrome' })));
    expect(alertText()).toContain('Browser not found: chrome');
  });

  it('offers Setup instead when there’s no browser', async () => {
    await started([a]);
    expect(screen.getByRole('button', { name: 'Set up traffic' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Launch/ })).toBeNull();
  });

  it('says where the proxy is', async () => {
    await started([a]);
    expect(screen.getAllByText('Proxy on 127.0.0.1:8001').length).toBeGreaterThan(0);
  });
});
