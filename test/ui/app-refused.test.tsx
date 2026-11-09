/** The Traffic bar for connections that refused Wirescry’s certificate (App.tsx, refused-text.ts). */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary, ProxyStatus, RefusedConnections, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { UNDO_CLEAR_MS } from '../../src/renderer/src/useUndoableClear';
import { status, summary } from './fixtures';

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void }>,
  /** The commands the window sent. */
  sent: [] as Array<{ command: string; seen?: unknown }>,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string }) => void fake.sent.push(command));
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
  fake.sent.length = 0;
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

const withRefused = (refused?: RefusedConnections): ProxyStatus => ({
  ...status(),
  // The Setup page shows the certificate.
  certificate: {
    commonName: 'Wirescry CA (1234abcd)',
    spkiFingerprint: 'x',
    sha256: 'AB:CD',
    validTo: '2030-01-01',
    path: '/data/ca.pem',
  },
  ...(refused ? { refused } : {}),
});
const github = (count: number, epoch = 1): RefusedConnections => ({
  count,
  hosts: [{ host: 'api.github.com', count }],
  epoch,
});
/** The names of the commands sent. */
const sentNames = () => fake.sent.map((c) => c.command);
/** What the screen reader is told, once, when the bar appears. */
const announced = () =>
  [...document.querySelectorAll('.visually-hidden[role=status]')].map((e) => e.textContent).join('');

async function started(refused?: RefusedConnections, exchanges: ExchangeSummary[] = []) {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    fake.clients.at(-1)!.onMessage({
      type: 'hello',
      status: withRefused(refused),
      exchanges,
      paused: false,
    } as ServerMessage),
  );
}
const sendStatus = (refused?: RefusedConnections) =>
  act(async () =>
    fake.clients.at(-1)!.onMessage({ type: 'status', status: withRefused(refused) } as ServerMessage),
  );
const bar = () => document.querySelector('.refused-notice');

describe('The refused-certificate bar in Traffic', () => {
  it('says how many connections refused the certificate, from where, why, and how to fix it', async () => {
    await started({
      count: 3,
      hosts: [
        { host: 'api.github.com', count: 2 },
        { host: 'registry.npmjs.org', count: 1 },
      ],
    });
    expect(bar()?.textContent).toContain(
      '3 connections refused Wirescry’s certificate: api.github.com, registry.npmjs.org. The programs that made them don’t trust the certificate, so those connections aren’t listed.',
    );
    const link = screen.getByRole('link', { name: 'How to fix this' });
    expect(link.getAttribute('href')).toBe(
      'https://docs.casazium.com/docs/wirescry/troubleshooting#certificate-error',
    );
    // Opened by the app in the system browser, never in the window.
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('isn’t there without refusals', async () => {
    await started();
    expect(bar()).toBeNull();
  });

  it('shows in Traffic only', async () => {
    await started(github(2));
    expect(bar()).not.toBeNull();
    // The tabs, not the empty list's own link to Setup.
    const tabs = within(document.querySelector<HTMLElement>('.views')!);
    fireEvent.click(tabs.getByRole('button', { name: 'Setup' }));
    expect(bar()).toBeNull();
    fireEvent.click(tabs.getByRole('button', { name: 'Traffic' }));
    expect(bar()).not.toBeNull();
  });

  it('appears when refusals arrive, and goes when they’re cleared', async () => {
    await started();
    await sendStatus(github(1));
    expect(bar()?.textContent).toContain('1 connection refused');
    expect(bar()?.textContent).toContain('The program that made it doesn’t trust the certificate');
    await sendStatus(undefined);
    expect(bar()).toBeNull();
  });

  it('stays dismissed while the same hosts refuse again, and comes back for a new host', async () => {
    await started(github(2));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(bar()).toBeNull();
    // A program retrying the same host: still dismissed, however many times.
    await sendStatus(github(3));
    await sendStatus(github(40));
    expect(bar()).toBeNull();
    await sendStatus({
      count: 41,
      hosts: [
        { host: 'api.github.com', count: 40 },
        { host: 'pypi.org', count: 1 },
      ],
      epoch: 1,
    });
    expect(bar()?.textContent).toContain(
      '41 connections refused Wirescry’s certificate: api.github.com, pypi.org.',
    );
  });

  it('comes back once refusals start over, even for the same host and count', async () => {
    await started(github(5));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await sendStatus(undefined);
    await sendStatus(github(1, 2));
    expect(bar()?.textContent).toContain('1 connection refused');
    // A reconnect that brings the same count under a new epoch, never seen at zero, too.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await sendStatus(github(1, 3));
    expect(bar()).not.toBeNull();
  });

  it('comes back when more hosts refuse than it can name', async () => {
    const many = (moreHosts: boolean): RefusedConnections => ({
      count: 60,
      hosts: Array.from({ length: 50 }, (_, i) => ({ host: `h${i}.test`, count: 1 })),
      ...(moreHosts ? { moreHosts: true as const } : {}),
      epoch: 1,
    });
    await started(many(false));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await sendStatus(many(true));
    expect(bar()?.textContent).toContain('h0.test, h1.test, h2.test, and others.');
  });

  it('tells a screen reader once when it appears, not each time its count changes', async () => {
    await started();
    expect(announced()).toBe('');
    await sendStatus(github(1));
    expect(announced()).toBe('Some HTTPS connections refused Wirescry’s certificate.');
    await sendStatus(github(7));
    expect(announced()).toBe('Some HTTPS connections refused Wirescry’s certificate.');
    // The bar itself isn't a live region: its changing count would be read out each time.
    expect(bar()?.getAttribute('role')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(announced()).toBe('');
  });

  describe('and Clear', () => {
    afterEach(() => vi.useRealTimers());

    it('hides it with the cleared list, brings it back on Undo, and forgets nothing', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await started(github(2), [summary('a')]);
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(bar()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(bar()).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(UNDO_CLEAR_MS * 2));
      expect(sentNames()).not.toContain('clearRefused');
      expect(sentNames()).not.toContain('clear');
    });

    it('has the backend forget them once the Clear goes through', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await started(github(2), [summary('a')]);
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await act(async () => vi.advanceTimersByTime(UNDO_CLEAR_MS - 1));
      expect(sentNames()).not.toContain('clearRefused');
      await act(async () => vi.advanceTimersByTime(1));
      expect(sentNames()).toContain('clear');
      // Only what was shown when Clear was clicked.
      expect(fake.sent.find((c) => c.command === 'clearRefused')).toEqual({
        command: 'clearRefused',
        seen: github(2),
      });
      // The backend then sends a status without them.
      await sendStatus(undefined);
      expect(bar()).toBeNull();
    });

    it('shows, once it goes through, refusals that came while Undo was offered', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await started(github(2), [summary('a')]);
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await sendStatus(github(3));
      expect(bar()).toBeNull();
      await act(async () => vi.advanceTimersByTime(UNDO_CLEAR_MS));
      // What the backend keeps after taking off what was shown: the one that came since.
      expect(fake.sent.find((c) => c.command === 'clearRefused')?.seen).toEqual(github(2));
      await sendStatus(github(1, 2));
      expect(bar()?.textContent).toContain('1 connection refused');
    });

    it('forgets them at once when the list was already empty: there’s nothing to undo', async () => {
      await started(github(2));
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(fake.sent).toContainEqual({ command: 'clearRefused', seen: github(2) });
    });

    it('sends nothing about them when there were none', async () => {
      await started();
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(sentNames()).not.toContain('clearRefused');
    });
  });
});
