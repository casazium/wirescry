import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { matchesFilter, QUICK_FILTERS, type QuickFilter } from '../../shared/filter';
import { DetailPane } from './DetailPane';
import { TrafficList } from './TrafficList';
import { useBackend } from './useBackend';

export function App(): React.JSX.Element {
  const { backendState, connected, status, exchanges, paused, send } = useBackend();
  const [message, setMessage] = useState<string>();
  const [selectedBrowser, setSelectedBrowser] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const searchRef = useRef<HTMLInputElement>(null);

  // Typing stays responsive while a large list is re-filtered.
  const deferredSearch = useDeferredValue(search);
  const rows = useMemo(
    () => exchanges.filter((e) => matchesFilter(e, deferredSearch, quickFilter)),
    [exchanges, deferredSearch, quickFilter],
  );
  const selected = selectedId ? exchanges.find((e) => e.id === selectedId) : undefined;

  const browsers = status?.browsers ?? [];
  const browserId = selectedBrowser || browsers[0]?.id || '';

  // Cmd/Ctrl+F focuses the search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onListKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setSelectedId(undefined);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const current = selectedId ? rows.findIndex((e) => e.id === selectedId) : -1;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = rows[Math.min(rows.length - 1, Math.max(0, current + step))];
    if (next) setSelectedId(next.id);
  };

  const launch = async (): Promise<void> => {
    setMessage(undefined);
    try {
      await send({ command: 'launchBrowser', browserId });
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  let stateLabel: string;
  if (backendState.state === 'failed') stateLabel = 'Backend failed';
  else if (!connected) stateLabel = 'Connecting…';
  else stateLabel = `Proxy on 127.0.0.1:${status?.proxyPort}`;

  const filtered = search.trim() !== '' || quickFilter !== 'all';

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Leverframe</h1>
        <span className={`pill ${connected ? 'live' : ''}`} data-testid="proxy-status">
          {stateLabel}
        </span>
        {paused && <span className="pill paused">Recording paused</span>}
        <div className="spacer" />
        {browsers.length > 0 ? (
          <>
            {browsers.length > 1 && (
              <select
                aria-label="Browser"
                value={browserId}
                onChange={(e) => setSelectedBrowser(e.target.value)}
              >
                {browsers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" onClick={launch} disabled={!connected}>
              Launch {browsers.find((b) => b.id === browserId)?.name ?? 'browser'}
            </button>
          </>
        ) : (
          <span className="muted">No Chrome-family browser found</span>
        )}
      </header>

      <div className="filterbar">
        <input
          ref={searchRef}
          type="search"
          className="search"
          placeholder="Search URL, method, status…"
          aria-label="Search traffic"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSearch('');
          }}
        />
        <div className="chips" role="radiogroup" aria-label="Quick filter">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={quickFilter === f.id}
              className={`chip ${quickFilter === f.id ? 'active' : ''}`}
              onClick={() => setQuickFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <span className="muted count" data-testid="row-count">
          {filtered
            ? `${rows.length.toLocaleString()} of ${exchanges.length.toLocaleString()}`
            : `${exchanges.length.toLocaleString()} requests`}
        </span>
        <button
          type="button"
          className="secondary"
          aria-pressed={paused}
          onClick={() => void send({ command: 'setPaused', paused: !paused })}
          disabled={!connected}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setSelectedId(undefined);
            void send({ command: 'clear' });
          }}
          disabled={!connected}
        >
          Clear
        </button>
      </div>

      {backendState.state === 'failed' && <div className="banner error">{backendState.message}</div>}
      {message && <div className="banner error">{message}</div>}

      <div className="main">
        <TrafficList
          rows={rows}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onKeyDown={onListKey}
          empty={
            !connected ? null : exchanges.length === 0 ? (
              <>No traffic yet. Launch a browser, or send requests through 127.0.0.1:{status?.proxyPort}.</>
            ) : (
              <>No requests match the current search or filter.</>
            )
          }
        />
        {selected && <DetailPane summary={selected} send={send} onClose={() => setSelectedId(undefined)} />}
      </div>
    </div>
  );
}
