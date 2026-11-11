import { memo, useEffect, useId, useRef, useState } from 'react';
import type { SseEventsView as View } from '../../shared/api';
import type { SseItem } from '../../shared/sse';
import type { Command } from './api-client';

/** Items kept in view: the newest. */
const MAX_SHOWN = 2000;
/** How often to look for more while the stream is going. */
const EVERY_MS = 1000;
/** Characters of an event's data shown at first; the rest with Show all. */
const PREVIEW_CHARS = 4096;

interface Props {
  exchangeId: string;
  /** Still arriving: look for more as it grows, and every second. */
  responding: boolean;
  /** Bytes so far; a change means there may be new events. */
  received: number | undefined;
  /** The finished body's size; a change means it has ended (look once more). */
  size: number | undefined;
  send(command: Command): Promise<unknown>;
}

/** A Server-Sent Events stream's events, as they arrive and after it ends. Mount one per exchange (key it by id). */
export function SseEventsView({ exchangeId, responding, received, size, send }: Props): React.JSX.Element {
  const [shown, setShown] = useState<{ view: View; items: SseItem[] } | undefined>();
  const [error, setError] = useState<string>();
  const poll = useRef<() => void>(() => undefined);

  useEffect(() => {
    let active = true;
    let busy = false;
    let again = false;
    let serial: number | undefined;
    let items: SseItem[] = [];
    let last: View | undefined;
    let restarted = false;
    const read = async (): Promise<void> => {
      const view = (await send({
        command: 'getSseEvents',
        exchangeId,
        after: items.at(-1)?.index ?? 0,
      })) as View | null;
      if (!active || !view) return;
      if (serial !== undefined && view.serial !== serial && items.length > 0 && !restarted) {
        // The body was replaced: what's shown belongs to the old one (start over once per look).
        restarted = true;
        serial = view.serial;
        items = [];
        return read();
      }
      restarted = false;
      serial = view.serial;
      // Nothing new: leave the list as it is rather than draw it again.
      const same =
        last !== undefined &&
        view.items.length === 0 &&
        view.total === last.total &&
        view.receiving === last.receiving &&
        view.problem === last.problem;
      last = view;
      if (!same) {
        items = [...items, ...view.items].slice(-MAX_SHOWN);
        setShown({ view, items });
        setError(undefined);
      }
      // Stopped at its limits before the end of what has arrived: read on now.
      if (view.more) again = true;
    };
    poll.current = () => {
      if (!active) return;
      // One look at a time; one asked for meanwhile runs after it.
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      read()
        .catch((e: Error) => active && setError(e.message))
        .finally(() => {
          busy = false;
          if (again) {
            again = false;
            poll.current();
          }
        });
    };
    return () => {
      active = false;
    };
  }, [exchangeId, send]);

  // The first look, then again whenever more arrived or it ended.
  useEffect(() => poll.current(), [received, size]);
  // While it's going, look every second too: a stream can catch up over a few looks.
  useEffect(() => {
    if (!responding) return;
    const timer = setInterval(() => poll.current(), EVERY_MS);
    return () => clearInterval(timer);
  }, [responding]);

  const view = shown?.view;
  const items = shown?.items ?? [];
  const count = view?.total ?? 0;
  const headingId = useId();
  const earlier = (items[0]?.index ?? 1) - 1;
  return (
    <section className="sse" aria-labelledby={headingId}>
      <h2 id={headingId}>Events</h2>
      {view && (
        <p className="muted">
          {count.toLocaleString()} {count === 1 ? 'item' : 'items'}
          {view.receiving ? ' so far' : ''}
        </p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      {earlier > 0 && (
        <p className="note">
          {earlier.toLocaleString()} earlier {earlier === 1 ? 'item isn’t' : 'items aren’t'} shown, to keep
          memory use down.
        </p>
      )}
      <ol className="sse-list">
        {items.map((item) => (
          <Item key={item.index} item={item} />
        ))}
      </ol>
      {view && items.length === 0 && !view.problem && (
        <p className="muted">{view.receiving ? 'No events yet.' : 'No events.'}</p>
      )}
      {view?.problem && <p className="note">{view.problem}</p>}
    </section>
  );
}

/** One item, drawn again only if it changes. */
const Item = memo(function Item({ item }: { item: SseItem }): React.JSX.Element {
  const [all, setAll] = useState(false);
  if (item.kind === 'comment') {
    return (
      <li className="sse-comment muted" data-testid="sse-comment">
        Comment: {item.text}
      </li>
    );
  }
  if (item.kind === 'retry') {
    return (
      <li className="sse-retry muted" data-testid="sse-retry">
        Retry after {item.ms.toLocaleString()} ms if the connection drops
      </li>
    );
  }
  const long = item.data.length > PREVIEW_CHARS;
  return (
    <li className="sse-event" data-testid="sse-event">
      <div className="sse-meta">
        <span className="sse-type">{item.type}</span>
        {item.id !== undefined && <span className="muted">id {item.id}</span>}
      </div>
      <pre className="sse-data">{long && !all ? `${item.data.slice(0, PREVIEW_CHARS)}…` : item.data}</pre>
      {long && (
        <button type="button" className="link" onClick={() => setAll((a) => !a)}>
          {all ? 'Show less' : `Show all ${item.data.length.toLocaleString()} characters`}
        </button>
      )}
      {item.cut && <p className="muted">Only the first 65,536 characters of its data were kept.</p>}
    </li>
  );
});
