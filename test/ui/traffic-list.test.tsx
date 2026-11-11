import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrafficList } from '../../src/renderer/src/TrafficList';
import { summary } from './fixtures';

const list = (overrides: Partial<Parameters<typeof TrafficList>[0]> = {}) => {
  const props = {
    rows: [
      summary('a'),
      summary('b', { status: 404 }),
      summary('c', { failure: { kind: 'dns', code: 'ENOTFOUND', message: 'x' } as never, status: 502 }),
    ],
    staleIds: new Set<string>(),
    selectedId: undefined,
    onSelect: vi.fn(),
    onKeyDown: vi.fn(),
    onContextMenu: vi.fn(),
    empty: 'Nothing here',
    ...overrides,
  };
  render(<TrafficList {...props} />);
  return props;
};

// jsdom has no layout, so the list renders the rows its overscan allows from height 0.
describe('TrafficList', () => {
  it('shows each exchange, with failures by name', () => {
    list();
    const rows = screen.getAllByTestId('exchange-row');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('404');
    expect(rows[2]!.textContent).toContain('DNS');
  });

  it("shows a failed gRPC call's status by name instead of HTTP's 200, colored as an error", () => {
    const grpc = { grpc: true as const, contentType: 'application/grpc' };
    list({
      rows: [
        summary('missing', { ...grpc, grpcStatus: 5, grpcMessage: 'order 42 not found' }),
        summary('fine', { ...grpc, grpcStatus: 0 }),
        summary('gave-up', { ...grpc, grpcStatus: 1 }),
        summary('odd', { ...grpc, grpcStatus: 42 }),
        summary('dropped', {
          ...grpc,
          grpcStatus: 14,
          failure: { kind: 'reset', code: 'ECONNRESET', message: 'reset' } as never,
        }),
      ],
    });
    const statusOf = (row: Element) => row.querySelector('[role="cell"]:nth-child(2)')!;
    const [missing, fine, gaveUp, odd, dropped] = screen.getAllByTestId('exchange-row');
    // A short label fits the narrow column; the tooltip has the full name.
    expect(statusOf(missing!).textContent).toBe('Not found');
    expect(statusOf(missing!).className).toBe('status error');
    expect(statusOf(missing!).getAttribute('title')).toBe('gRPC NOT_FOUND (5): order 42 not found');
    // OK shows HTTP's status as for any request.
    expect(statusOf(fine!).textContent).toBe('200');
    expect(statusOf(fine!).className).toBe('status ok');
    // The client gave up: not an error.
    expect(statusOf(gaveUp!).textContent).toBe('Canceled');
    expect(statusOf(gaveUp!).className).toBe('status warn');
    expect(statusOf(odd!).textContent).toBe('gRPC 42');
    expect(statusOf(odd!).getAttribute('title')).toBe('gRPC code 42 (42)');
    // A failure still says what failed.
    expect(statusOf(dropped!).textContent).toBe('Reset');
    // The type column says gRPC.
    expect(missing!.querySelector('.col-type')?.textContent).toBe('grpc');
  });

  it('shows a gRPC call its client canceled as Canceled, in amber; other closed requests as before', () => {
    const closed = {
      kind: 'client-closed',
      code: 'CLIENT_CLOSED',
      message: 'The client closed it.',
    } as never;
    list({
      rows: [
        summary('stream', { grpc: true, contentType: 'application/grpc', failure: closed }),
        summary('page', { failure: closed }),
        summary('late', {
          grpc: true,
          contentType: 'application/grpc',
          grpcDeadlineExceeded: true,
          failure: { kind: 'client-closed', code: 'CLIENT_CLOSED', message: 'The client gave up.' } as never,
        }),
      ],
    });
    const statusOf = (row: Element) => row.querySelector('[role="cell"]:nth-child(2)')!;
    const [stream, page, late] = screen.getAllByTestId('exchange-row');
    // Its deadline passed: an error, said as the client says it.
    expect(statusOf(late!).textContent).toBe('Deadline');
    expect(statusOf(late!).className).toBe('status error');
    expect(statusOf(late!).getAttribute('title')).toBe('The client gave up.');
    expect(statusOf(stream!).textContent).toBe('Canceled');
    expect(statusOf(stream!).className).toBe('status warn');
    expect(statusOf(stream!).getAttribute('title')).toBe('The client canceled the call.');
    expect(statusOf(page!).textContent).toBe('Closed');
    expect(statusOf(page!).className).toBe('status error');
    expect(statusOf(page!).getAttribute('title')).toBe('The client closed it.');
  });

  it("shows the device a request came from, and nothing for this computer's", () => {
    list({
      rows: [
        summary('a', { source: { kind: 'android', id: 'p', label: 'Pixel 8' } }),
        summary('b'),
        summary('c', { source: { kind: 'android', id: 'g', label: 'Samsung Galaxy Tab S9 FE+' } }),
      ],
    });
    const [phone, mac, tablet] = screen.getAllByTestId('exchange-row');
    const badge = phone!.querySelector('.device-badge')!;
    expect(badge.getAttribute('title')).toBe('From Pixel 8');
    // Screen readers get the full name; the visible, possibly shortened one is hidden from them.
    expect(badge.querySelector('.visually-hidden')?.textContent).toBe('From Pixel 8');
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe('Pixel 8');
    expect(mac!.querySelector('.device-badge')).toBeNull();
    // A long name is shortened, keeping the path in view; the full name is in the title.
    const long = tablet!.querySelector('.device-badge')!;
    expect(long.querySelector('[aria-hidden="true"]')?.textContent).toBe('Samsung Galaxy…');
    expect(long.querySelector('.visually-hidden')?.textContent).toBe('From Samsung Galaxy Tab S9 FE+');
    expect(long.getAttribute('title')).toBe('From Samsung Galaxy Tab S9 FE+');
  });

  it('selects on click, and clears the selection on a second click', () => {
    const props = list({ selectedId: 'a' });
    fireEvent.click(screen.getAllByTestId('exchange-row')[1]!);
    expect(props.onSelect).toHaveBeenLastCalledWith('b');
    fireEvent.click(screen.getAllByTestId('exchange-row')[0]!);
    expect(props.onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it('opens its own menu on right-click instead of the window’s', () => {
    const props = list();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getAllByTestId('exchange-row')[0]!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(props.onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('marks rows from before a restart, for screen readers too', () => {
    list({ staleIds: new Set(['b']) });
    const rows = screen.getAllByTestId('exchange-row');
    expect(rows[1]!.className).toContain('stale');
    expect(rows[1]!.textContent).toContain('from before the proxy restarted');
    expect(rows[0]!.className).not.toContain('stale');
  });

  it('says why it’s empty', () => {
    list({ rows: [] });
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});

describe('TrafficList plugin badges', () => {
  const badge = (label: string) =>
    [...document.querySelectorAll('.plugin-badge')].find((b) => b.firstChild?.textContent === label)!;

  it('shows each plugin’s badge with its tone, and its title to the mouse and to screen readers', () => {
    list({
      rows: [
        summary('a', {
          annotations: [
            { plugin: 'pro', label: 'Spec', tone: 'warn', title: 'Response 200 is missing "email"' },
            { plugin: 'other', label: 'Seen', tone: 'info' },
          ],
        }),
        summary('b'),
      ],
    });
    const [, second] = screen.getAllByTestId('exchange-row');
    const spec = badge('Spec');
    expect(spec.className).toContain('tone-warn');
    expect(spec.getAttribute('title')).toBe('Response 200 is missing "email"');
    expect(spec.querySelector('.visually-hidden')!.textContent).toBe(': Response 200 is missing "email".');
    // No title: no tooltip, and nothing extra read out.
    const seen = badge('Seen');
    expect(seen.className).toContain('tone-info');
    expect(seen.hasAttribute('title')).toBe(false);
    expect(seen.querySelector('.visually-hidden')).toBeNull();
    expect(second!.querySelector('.plugin-badge')).toBeNull();
  });

  it('doesn’t double the full stop of a title that has one', () => {
    list({
      rows: [
        summary('a', {
          annotations: [{ plugin: 'pro', label: 'Spec', tone: 'ok', title: 'Matches getPet.' }],
        }),
      ],
    });
    expect(document.querySelector('.plugin-badge .visually-hidden')!.textContent).toBe(': Matches getPet.');
  });

  it('shows at most three badges on a row, so the path stays visible', () => {
    list({
      rows: [
        summary('a', {
          annotations: ['p1', 'p2', 'p3', 'p4', 'p5'].map((plugin) => ({
            plugin,
            label: plugin,
            tone: 'ok' as const,
          })),
        }),
      ],
    });
    // The first three, in the order they came.
    expect([...document.querySelectorAll('.plugin-badge')].map((b) => b.textContent)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });
});
