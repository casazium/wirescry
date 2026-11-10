import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BodyContent, FormattedBody, WebSocketMessage, WebSocketMessages } from '../../shared/api';
import type { Command } from './api-client';
import { BodyView } from './BodyView';
import { base64ToBytes, bytesToText, formatBytes } from './bytes';

/** The UI keeps at most this many messages per connection; older ones are still in the backend. */
const MAX_SHOWN = 2000;

type Message = WebSocketMessage & { base64: string; text?: string };
type Direction = 'all' | 'sent' | 'received';

interface Props {
  exchangeId: string;
  /** Messages the backend has seen; a change means there are new ones to fetch. */
  messageCount: number;
  send(command: Command): Promise<unknown>;
}

function formatTime(ms: number): string {
  return ms < 1000 ? `+${ms} ms` : `+${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const NOT_FORMATTED: () => Promise<FormattedBody> = () =>
  Promise.resolve({ ok: false, reason: 'not available for WebSocket messages' });

/** Live list of a WebSocket connection's messages, with the selected message's content. */
export function WebSocketMessagesView({ exchangeId, messageCount, send }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string>();
  const [direction, setDirection] = useState<Direction>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number>();
  const [fetches, setFetches] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastIndex = useRef(-1);
  const loading = useRef(false);

  // Fetch messages newer than the last one we have whenever the count goes up. A count that
  // rises while a fetch is out is fetched once that one's messages are in. (DetailPane gives
  // each connection its own view, so an answer is never for another connection.)
  useEffect(() => {
    if (loading.current || messageCount <= lastIndex.current + 1) return;
    loading.current = true;
    send({ command: 'getWebSocketMessages', exchangeId, after: lastIndex.current }).then(
      (value) => {
        loading.current = false;
        const result = value as WebSocketMessages;
        const added: Message[] = result.messages.map((m) => {
          const text = m.isBinary ? undefined : bytesToText(base64ToBytes(m.base64));
          return { ...m, text };
        });
        const last = added.at(-1);
        if (last) lastIndex.current = last.index;
        setDropped(result.dropped);
        setMessages((current) => [...current, ...added].slice(-MAX_SHOWN));
        // Look again, for any that arrived meanwhile; only after new ones, so it can't loop.
        if (added.length > 0) setFetches((n) => n + 1);
      },
      (e: Error) => {
        loading.current = false;
        setError(e.message);
      },
    );
  }, [exchangeId, messageCount, send, fetches]);

  const shown = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return messages.filter((m) => {
      if (direction === 'sent' && !m.fromClient) return false;
      if (direction === 'received' && m.fromClient) return false;
      if (words.length === 0) return true;
      const text = (m.text ?? '').toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [messages, direction, search]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const current = messages.find((m) => m.index === selected);
  const content: BodyContent | undefined = current && {
    base64: current.base64,
    size: current.size,
    contentType: current.isBinary
      ? 'application/octet-stream'
      : current.text !== undefined && /^\s*[[{]/.test(current.text)
        ? 'application/json'
        : 'text/plain',
    truncated: base64ToBytes(current.base64).length < current.size,
  };
  const hidden = dropped + Math.max(0, messageCount - dropped - messages.length);

  return (
    <section className="ws">
      <h2>Messages ({messageCount.toLocaleString()})</h2>
      <div className="ws-controls">
        {(['all', 'sent', 'received'] as const).map((d) => (
          <button
            key={d}
            type="button"
            className={`chip ${direction === d ? 'active' : ''}`}
            onClick={() => setDirection(d)}
          >
            {d === 'all' ? 'All' : d === 'sent' ? '↑ Sent' : '↓ Received'}
          </button>
        ))}
        <input
          type="search"
          className="search small"
          placeholder="Search messages"
          aria-label="Search messages"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      {hidden > 0 && (
        <p className="note">
          {hidden.toLocaleString()} earlier {hidden === 1 ? 'message isn’t' : 'messages aren’t'} shown, to
          keep memory use down.
        </p>
      )}
      <div
        className="ws-list"
        ref={listRef}
        role="list"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {shown.map((m) => (
          <div
            key={m.index}
            role="listitem"
            data-testid="ws-message"
            className={`ws-row ${m.fromClient ? 'sent' : 'received'} ${m.index === selected ? 'selected' : ''}`}
            onClick={() => setSelected(m.index === selected ? undefined : m.index)}
          >
            <span className="ws-dir" title={m.fromClient ? 'Sent by the client' : 'Received from the server'}>
              {m.fromClient ? '↑' : '↓'}
            </span>
            <span className="ws-preview">
              {m.isBinary || m.text === undefined ? `Binary, ${formatBytes(m.size)}` : m.text.slice(0, 200)}
            </span>
            <span className="ws-size">{formatBytes(m.size)}</span>
            <span className="ws-time">{formatTime(m.time)}</span>
          </div>
        ))}
        {messageCount === 0 && <p className="muted">No messages yet.</p>}
      </div>
      {content && (
        <div className="ws-detail">
          <BodyView key={current!.index} content={content} format={NOT_FORMATTED} />
        </div>
      )}
    </section>
  );
}
