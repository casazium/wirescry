/** A WebSocket connection's messages (src/renderer/src/WebSocketMessagesView.tsx). */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketMessagesView } from '../../src/renderer/src/WebSocketMessagesView';
import type { WebSocketMessages } from '../../src/shared/api';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const message = (index: number, fromClient: boolean, text: string, time = index * 10) => ({
  index,
  fromClient,
  isBinary: false,
  time,
  size: Buffer.byteLength(text),
  base64: b64(text),
});

/** A backend that answers with these messages after the index it's asked for. */
function backend(all: WebSocketMessages['messages'], dropped = 0) {
  return vi.fn(async (command: { command: string; after?: number }) => ({
    messages: all.filter((m) => m.index > (command.after ?? -1)),
    dropped,
    total: all.length,
  }));
}
const rows = () => screen.queryAllByTestId('ws-message').map((r) => r.textContent);
const settle = () => act(async () => undefined);

describe('WebSocketMessagesView', () => {
  const chat = [
    message(0, true, 'hello server'),
    message(1, false, '{"reply":"Hello client"}', 1500),
    message(2, true, 'PING', 12_345),
  ];

  it('lists the messages with their direction, size and time', async () => {
    const send = backend(chat);
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={send} />);
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'getWebSocketMessages', exchangeId: 'ws1', after: -1 });
    expect(screen.getByRole('heading').textContent).toBe('Messages (3)');
    expect(rows()).toEqual([
      '↑hello server12 B+0 ms',
      '↓{"reply":"Hello client"}24 B+1.50 s',
      '↑PING4 B+12.3 s',
    ]);
  });

  it('switches from milliseconds to seconds at one second', async () => {
    const edge = [message(0, true, 'a', 999), message(1, true, 'b', 1000), message(2, true, 'c', 10_000)];
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={backend(edge)} />);
    await settle();
    expect(rows()).toEqual(['↑a1 B+999 ms', '↑b1 B+1.00 s', '↑c1 B+10.0 s']);
  });

  it('shows a binary message by its size, not its bytes', async () => {
    const binary = {
      index: 0,
      fromClient: false,
      isBinary: true,
      time: 5,
      size: 2048,
      base64: b64('\u0000\u0001'),
    };
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={1} send={backend([binary])} />);
    await settle();
    expect(rows()).toEqual(['↓Binary, 2.0 KB2.0 KB+5 ms']);
  });

  it('shows only sent or received messages when asked, and all again', async () => {
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={backend(chat)} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '↑ Sent' }));
    expect(rows().map((r) => r!.slice(0, 5))).toEqual(['↑hell', '↑PING']);
    fireEvent.click(screen.getByRole('button', { name: '↓ Received' }));
    expect(rows().map((r) => r!.slice(0, 5))).toEqual(['↓{"re']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(rows()).toHaveLength(3);
  });

  it('finds messages containing every word searched for, in any case', async () => {
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={backend(chat)} />);
    await settle();
    const search = screen.getByRole('searchbox', { name: 'Search messages' });
    fireEvent.change(search, { target: { value: 'HELLO' } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(search, { target: { value: 'hello  client' } });
    expect(rows()).toEqual(['↓{"reply":"Hello client"}24 B+1.50 s']);
    fireEvent.change(search, { target: { value: 'hello nowhere' } });
    expect(rows()).toEqual([]);
    fireEvent.change(search, { target: { value: '   ' } });
    expect(rows()).toHaveLength(3);
  });

  it('fetches only the new messages when more arrive', async () => {
    const send = backend(chat);
    const { rerender } = render(
      <WebSocketMessagesView exchangeId="ws1" messageCount={2} send={backend(chat.slice(0, 2))} />,
    );
    await settle();
    expect(rows()).toHaveLength(2);
    rerender(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={send} />);
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'getWebSocketMessages', exchangeId: 'ws1', after: 1 });
    expect(rows()).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(1);
    // The same count again: nothing more to fetch.
    send.mockClear();
    rerender(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={send} />);
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it('fetches messages that arrive while it’s still fetching, once that answer is in', async () => {
    const answers: Array<(value: WebSocketMessages) => void> = [];
    const send = vi.fn(() => new Promise<WebSocketMessages>((resolve) => answers.push(resolve)));
    const { rerender } = render(<WebSocketMessagesView exchangeId="ws1" messageCount={1} send={send} />);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    // Two more arrive before the first answer.
    rerender(<WebSocketMessagesView exchangeId="ws1" messageCount={3} send={send} />);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => answers[0]!({ messages: chat.slice(0, 1), dropped: 0, total: 1 }));
    expect(rows()).toHaveLength(1);
    expect(send).toHaveBeenLastCalledWith({ command: 'getWebSocketMessages', exchangeId: 'ws1', after: 0 });
    await act(async () => answers[1]!({ messages: chat.slice(1), dropped: 0, total: 3 }));
    expect(rows()).toHaveLength(3);
    expect(screen.queryByText(/earlier/)).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps fetching new ones once it shows as many as it keeps', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => message(i, i % 2 === 0, `m${i}`));
    const answers: Array<(value: WebSocketMessages) => void> = [];
    const send = vi.fn(() => new Promise<WebSocketMessages>((resolve) => answers.push(resolve)));
    const { rerender } = render(<WebSocketMessagesView exchangeId="ws1" messageCount={2000} send={send} />);
    await settle();
    await act(async () => answers[0]!({ messages: many, dropped: 0, total: 2000 }));
    expect(rows()).toHaveLength(2000);
    rerender(<WebSocketMessagesView exchangeId="ws1" messageCount={2001} send={send} />);
    await settle();
    // One more arrives while that's out; the list is full, so its length doesn't change.
    rerender(<WebSocketMessagesView exchangeId="ws1" messageCount={2002} send={send} />);
    await settle();
    await act(async () =>
      answers[1]!({ messages: [message(2000, true, 'new one')], dropped: 0, total: 2001 }),
    );
    expect(send).toHaveBeenLastCalledWith({
      command: 'getWebSocketMessages',
      exchangeId: 'ws1',
      after: 2000,
    });
    await act(async () =>
      answers[2]!({ messages: [message(2001, true, 'newest')], dropped: 0, total: 2002 }),
    );
    expect(rows()).toHaveLength(2000);
    expect(rows().at(-1)).toContain('newest');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('keeps following the newest message once the list is full', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => message(i, false, `m${i}`));
    const answers: Array<(value: WebSocketMessages) => void> = [];
    const send = vi.fn(() => new Promise<WebSocketMessages>((resolve) => answers.push(resolve)));
    const { rerender, container } = render(
      <WebSocketMessagesView exchangeId="ws1" messageCount={2000} send={send} />,
    );
    await settle();
    await act(async () => answers[0]!({ messages: many, dropped: 0, total: 2000 }));
    const list = container.querySelector('.ws-list') as HTMLElement;
    // jsdom has no layout: a list 100 px high holding 5,000 px of messages.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    list.scrollTop = 4900;
    rerender(<WebSocketMessagesView exchangeId="ws1" messageCount={2001} send={send} />);
    await settle();
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5040 });
    await act(async () => answers[1]!({ messages: [message(2000, false, 'new')], dropped: 0, total: 2001 }));
    // Still 2,000 shown, but the newest changed: it follows.
    expect(rows()).toHaveLength(2000);
    expect(list.scrollTop).toBe(5040);
  });

  it('doesn’t keep asking when an answer has nothing new', async () => {
    const send = vi.fn(async () => ({ messages: [], dropped: 0, total: 2 }));
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={2} send={send} />);
    await settle();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says how many earlier messages aren’t shown', async () => {
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={5} send={backend(chat, 2)} />);
    await settle();
    expect(screen.getByText(/earlier/).textContent).toBe(
      '2 earlier messages aren’t shown, to keep memory use down.',
    );
    const { unmount } = render(
      <WebSocketMessagesView exchangeId="ws2" messageCount={1} send={backend([], 1)} />,
    );
    await settle();
    expect(screen.getByText(/earlier message isn’t/).textContent).toBe(
      '1 earlier message isn’t shown, to keep memory use down.',
    );
    unmount();
  });

  it('says there are no messages yet, without asking the backend', async () => {
    const send = backend([]);
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={0} send={send} />);
    await settle();
    expect(screen.getByText('No messages yet.')).toBeTruthy();
    expect(screen.queryByText(/earlier/)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('shows why messages couldn’t be loaded', async () => {
    const send = vi.fn(async () => {
      throw new Error('That connection is no longer in the list.');
    });
    render(<WebSocketMessagesView exchangeId="ws1" messageCount={2} send={send} />);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('That connection is no longer in the list.');
    expect(rows()).toEqual([]);
  });

  it('shows a message’s content when selected, and hides it when clicked again', async () => {
    const { container } = render(
      <WebSocketMessagesView exchangeId="ws1" messageCount={3} send={backend(chat)} />,
    );
    await settle();
    const second = screen.getAllByTestId('ws-message')[1]!;
    fireEvent.click(second);
    await settle();
    expect(second.className).toContain('selected');
    expect(container.querySelector('.ws-detail')?.textContent).toContain('Hello client');
    fireEvent.click(second);
    expect(second.className).not.toContain('selected');
    expect(container.querySelector('.ws-detail')).toBeNull();
  });
});
