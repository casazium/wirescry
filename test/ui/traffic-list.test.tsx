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
