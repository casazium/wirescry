import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExchangeSummary } from '../../shared/api';
import { exchangeType } from '../../shared/exchange-type';
import { FAILURE_LABELS } from '../../shared/failure';
import { formatBytes } from './bytes';

const ROW_HEIGHT = 24;
/** Extra rows drawn above and below the visible ones, so fast scrolling doesn't show gaps. */
const OVERSCAN = 10;

function statusClass(exchange: ExchangeSummary): string {
  if (exchange.failure) return 'status error';
  if (exchange.status === undefined) return 'status pending';
  if (exchange.status >= 500) return 'status error';
  if (exchange.status >= 400) return 'status warn';
  if (exchange.status >= 300) return 'status redirect';
  return 'status ok';
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

interface Props {
  rows: ExchangeSummary[];
  selectedId: string | undefined;
  onSelect(id: string | undefined): void;
  onKeyDown(event: React.KeyboardEvent): void;
  empty: React.ReactNode;
}

/** The traffic list. Only rows in view are in the DOM, so it stays fast with thousands of rows. */
export function TrafficList({ rows, selectedId, onSelect, onKeyDown, empty }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  // Follow new traffic while scrolled to the bottom.
  const atBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current && !selectedId) el.scrollTop = el.scrollHeight;
  }, [rows.length, selectedId]);

  // Keep the selected row in view, e.g. when moving with the arrow keys.
  const selectedIndex = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selectedIndex]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  return (
    <div className="traffic" role="grid" aria-rowcount={rows.length + 1}>
      <div className="row header" role="row" aria-rowindex={1}>
        <span role="columnheader">Method</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Host</span>
        <span role="columnheader">Path</span>
        <span role="columnheader" className="num">
          Size
        </span>
        <span role="columnheader" className="num">
          Time
        </span>
      </div>
      <div
        className="traffic-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
        }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {visible.map((e, i) => {
            const index = first + i;
            return (
              <div
                key={e.id}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={e.id === selectedId}
                data-testid="exchange-row"
                className={`row ${index % 2 ? 'odd' : ''} ${e.id === selectedId ? 'selected' : ''}`}
                style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                onClick={() => onSelect(e.id === selectedId ? undefined : e.id)}
              >
                <span role="cell" className="method">
                  {e.method}
                </span>
                <span role="cell" className={statusClass(e)} title={e.failure?.message ?? e.statusMessage}>
                  {e.failure ? FAILURE_LABELS[e.failure.kind] : (e.status ?? '…')}
                </span>
                <span role="cell" className="muted" title={e.contentType}>
                  {e.status !== undefined && !e.failure ? exchangeType(e) : ''}
                </span>
                <span role="cell" title={e.host}>
                  {e.host}
                </span>
                <span role="cell" className="path" title={e.url}>
                  {e.handledBy && (
                    <span className="rule-badge" title={`Handled by the rule "${e.handledBy.label}"`}>
                      Rule
                    </span>
                  )}
                  {e.path}
                </span>
                <span role="cell" className="num">
                  {e.responseSize !== undefined ? formatBytes(e.responseSize) : ''}
                </span>
                <span role="cell" className="num">
                  {formatDuration(e.durationMs)}
                </span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <div className="empty">{empty}</div>}
      </div>
    </div>
  );
}
