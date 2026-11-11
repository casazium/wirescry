/** A Server-Sent Events stream's events in the details (src/renderer/src/SseEventsView.tsx). */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailPane } from '../../src/renderer/src/DetailPane';
import { SseEventsView } from '../../src/renderer/src/SseEventsView';
import type { SseEventsView as View } from '../../src/shared/api';
import type { SseItem } from '../../src/shared/sse';
import { detail, summary } from './fixtures';

const event = (index: number, data: string, extra: Partial<SseItem> = {}): SseItem =>
  ({ kind: 'event', index, type: 'message', data, ...extra }) as SseItem;
const view = (over: Partial<View> = {}): View => ({
  serial: 1,
  items: [],
  total: 0,
  receiving: true,
  ...over,
});
const settle = () => act(async () => undefined);

/** A backend whose stream so far is `items`; answers with those after the index asked for. */
function backend(state: { items: SseItem[]; receiving?: boolean; serial?: number; problem?: string }) {
  return vi.fn(async (command: { command: string; after?: number }) =>
    view({
      serial: state.serial ?? 1,
      items: state.items.filter((i) => i.index > (command.after ?? 0)),
      total: state.items.length,
      receiving: state.receiving ?? true,
      ...(state.problem ? { problem: state.problem } : {}),
    }),
  );
}
const asked = (send: ReturnType<typeof backend>) => send.mock.calls.map(([c]) => c.after);

afterEach(() => {
  vi.useRealTimers();
});

describe('the Events section', () => {
  it('shows events, comments and retry times, asking only for what came after the last it has', async () => {
    const state = {
      items: [
        { kind: 'comment', index: 1, text: 'hello' },
        { kind: 'retry', index: 2, ms: 2000 },
        event(3, '{"price":1}', { type: 'tick', id: '9' }),
      ] as SseItem[],
    };
    const send = backend(state);
    const ui = (received: number) => (
      <SseEventsView exchangeId="s" responding received={received} size={undefined} send={send} />
    );
    const { rerender } = render(ui(10));
    await settle();
    expect(screen.getByText('3 items so far')).toBeTruthy();
    expect(screen.getByTestId('sse-comment').textContent).toBe('Comment: hello');
    expect(screen.getByTestId('sse-retry').textContent).toBe('Retry after 2,000 ms if the connection drops');
    expect(screen.getByTestId('sse-event').textContent).toContain('tick');
    expect(screen.getByTestId('sse-event').textContent).toContain('id 9');
    expect(screen.getByTestId('sse-event').textContent).toContain('{"price":1}');

    state.items.push(event(4, 'next'));
    rerender(ui(20));
    await settle();
    expect(asked(send).at(-1)).toBe(3);
    expect(screen.getAllByTestId('sse-event')).toHaveLength(2);
  });

  it('says how many earlier items aren’t shown, and what stopped the reading', async () => {
    const send = backend({ items: [event(41, 'late')], problem: 'Wirescry kept only the first 512 MB.' });
    render(<SseEventsView exchangeId="s" responding received={1} size={undefined} send={send} />);
    await settle();
    expect(screen.getByText(/40 earlier items aren’t shown/)).toBeTruthy();
    expect(screen.getByText('Wirescry kept only the first 512 MB.')).toBeTruthy();
  });

  it('says there are no events yet while it’s going, and none once it has ended', async () => {
    const state: { items: SseItem[]; receiving: boolean } = { items: [], receiving: true };
    const send = backend(state);
    const { rerender } = render(
      <SseEventsView exchangeId="s" responding received={0} size={undefined} send={send} />,
    );
    await settle();
    expect(screen.getByText('No events yet.')).toBeTruthy();
    state.receiving = false;
    rerender(<SseEventsView exchangeId="s" responding={false} received={undefined} size={0} send={send} />);
    await settle();
    expect(screen.getByText('No events.')).toBeTruthy();
    expect(screen.getByText('0 items')).toBeTruthy();
  });

  it('starts over when the body is replaced', async () => {
    const state = { items: [event(1, 'old'), event(2, 'old too')], serial: 1 };
    const send = backend(state);
    const ui = (received: number) => (
      <SseEventsView exchangeId="s" responding received={received} size={undefined} send={send} />
    );
    const { rerender } = render(ui(1));
    await settle();
    state.items = [event(1, 'new')];
    state.serial = 2;
    rerender(ui(2));
    await settle();
    expect(screen.getAllByTestId('sse-event').map((e) => e.textContent)).toEqual(['messagenew']);
  });

  it('looks every second while the stream is going, and stops once it has ended', async () => {
    vi.useFakeTimers();
    const send = backend({ items: [] });
    const { rerender, unmount } = render(
      <SseEventsView exchangeId="s" responding received={0} size={undefined} send={send} />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(send.mock.calls.length).toBe(4);
    rerender(<SseEventsView exchangeId="s" responding={false} received={undefined} size={5} send={send} />);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    // One look as it ended, none after.
    expect(send.mock.calls.length).toBe(5);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads on at once while the backend says there’s more, as for a large finished stream', async () => {
    let looks = 0;
    const send = vi.fn(async (command: { command: string; after?: number }) => {
      looks++;
      const after = command.after ?? 0;
      // Three looks' worth: two events a look.
      const all = Array.from({ length: 6 }, (_, i) => event(i + 1, `e${i + 1}`));
      const items = all.filter((e) => e.index > after).slice(0, 2);
      return view({
        items,
        total: items.at(-1)?.index ?? after,
        receiving: false,
        ...(items.at(-1)!.index < 6 ? { more: true as const } : {}),
      });
    });
    render(<SseEventsView exchangeId="s" responding={false} received={undefined} size={100} send={send} />);
    await settle();
    await settle();
    await settle();
    expect(looks).toBe(3);
    expect(screen.getAllByTestId('sse-event')).toHaveLength(6);
  });

  it('shows the start of long data, and all of it when asked', async () => {
    const long = 'x'.repeat(5000);
    const send = backend({ items: [event(1, long, { cut: true })] });
    render(<SseEventsView exchangeId="s" responding received={1} size={undefined} send={send} />);
    await settle();
    const data = () => screen.getByTestId('sse-event').querySelector('pre')!.textContent!;
    expect(data().length).toBe(4097);
    expect(screen.getByText('Only the first 65,536 characters of its data were kept.')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Show all 5,000 characters' }).click());
    expect(data().length).toBe(5000);
    act(() => screen.getByRole('button', { name: 'Show less' }).click());
    expect(data().length).toBe(4097);
  });

  it('follows new items while scrolled to the end, and stays put when scrolled up', async () => {
    const state = { items: [event(1, 'a')] as SseItem[] };
    const send = backend(state);
    const ui = (received: number) => (
      <SseEventsView exchangeId="s" responding received={received} size={undefined} send={send} />
    );
    const { rerender, container } = render(ui(1));
    await settle();
    const list = container.querySelector('.sse-list') as HTMLElement;
    // jsdom has no layout: a list 100 px high holding 1,000 px of items.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    state.items.push(event(2, 'b'));
    rerender(ui(2));
    await settle();
    expect(list.scrollTop).toBe(1000);

    // Scrolled up to read: new items don't move it.
    list.scrollTop = 0;
    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });
    state.items.push(event(3, 'c'));
    rerender(ui(3));
    await settle();
    expect(list.scrollTop).toBe(0);

    // Back at the end: it follows again.
    list.scrollTop = 900;
    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });
    state.items.push(event(4, 'd'));
    rerender(ui(4));
    await settle();
    expect(list.scrollTop).toBe(1000);
  });

  it('stays on an item someone opens, and follows a replaced body from its end', async () => {
    const state = { items: [event(1, 'x'.repeat(5000))] as SseItem[], serial: 1 };
    const send = backend(state);
    const ui = (received: number) => (
      <SseEventsView exchangeId="s" responding received={received} size={undefined} send={send} />
    );
    const { rerender, container } = render(ui(1));
    await settle();
    const list = container.querySelector('.sse-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    list.scrollTop = 900;
    // Opening the long item makes the list taller, with no scroll: new items mustn't jump past it.
    act(() => screen.getByRole('button', { name: /Show all/ }).click());
    state.items.push(event(2, 'next'));
    rerender(ui(2));
    await settle();
    expect(list.scrollTop).toBe(900);

    // The body is replaced: new content, followed from its end.
    state.items = [event(1, 'fresh'), event(2, 'fresher')];
    state.serial = 2;
    rerender(ui(3));
    await settle();
    expect(list.scrollTop).toBe(1000);
  });

  it('shows an error from the backend', async () => {
    const send = vi.fn(async () => {
      throw new Error('Exchange not found');
    });
    render(<SseEventsView exchangeId="s" responding received={0} size={undefined} send={send} />);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Exchange not found');
  });
});

describe('the details of an event stream', () => {
  const pane = (s: ReturnType<typeof summary>, stale = false) => {
    const send = vi.fn(async (command: { command: string }) =>
      command.command === 'getExchange'
        ? detail(s, 'x')
        : command.command === 'getSseEvents'
          ? view({ items: [event(1, 'hi')], total: 1 })
          : null,
    );
    render(<DetailPane summary={s} send={send} onClose={() => undefined} actions={[]} stale={stale} />);
    return send;
  };

  it('has an Events section for text/event-stream, and none for other types or old exchanges', async () => {
    const send = pane(summary('e', { contentType: 'text/event-stream', responding: true }));
    await settle();
    expect(screen.getByRole('region', { name: 'Events' })).toBeTruthy();
    expect(send.mock.calls.some(([c]) => c.command === 'getSseEvents')).toBe(true);
  });

  it('has none for a response that isn’t an event stream', async () => {
    const send = pane(summary('j', { contentType: 'application/json' }));
    await settle();
    expect(screen.queryByRole('region', { name: 'Events' })).toBeNull();
    expect(send.mock.calls.some(([c]) => c.command === 'getSseEvents')).toBe(false);
  });

  it('has none for an exchange from before a restart', async () => {
    const send = pane(summary('o', { contentType: 'text/event-stream' }), true);
    await settle();
    expect(screen.queryByRole('region', { name: 'Events' })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
