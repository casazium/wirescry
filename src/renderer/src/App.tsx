import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { compileFilter, QUICK_FILTERS, type QuickFilter } from '../../shared/filter';
import { DetailPane } from './DetailPane';
import { FilterHelp } from './FilterHelp';
import { PluginView } from './PluginView';
import { uiPlugins } from '@leverframe/pro/ui';
import { PLUGIN_API_VERSION } from '../../plugin-api/version';
import { SetupPage } from './SetupPage';
import { TrafficList } from './TrafficList';
import { useBackend } from './useBackend';

export function App(): React.JSX.Element {
  const { backendState, connected, status, exchanges, paused, send, pluginApi, session, badges } =
    useBackend();
  const [message, setMessage] = useState<string>();
  const [selectedBrowser, setSelectedBrowser] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  // 'traffic', 'setup', or `${plugin}:${viewId}` for a plugin's view.
  const [view, setView] = useState<string>('traffic');
  // A UI plugin built for another API version is left out; its backend half reports why.
  const pluginViews = uiPlugins
    .filter((p) => p.apiVersion === PLUGIN_API_VERSION)
    .flatMap((plugin) =>
      plugin.views.map((v) => ({ key: `${plugin.name}:${v.id}`, plugin: plugin.name, view: v })),
    );
  const searchRef = useRef<HTMLInputElement>(null);

  // Typing stays responsive while a large list is re-filtered.
  const deferredSearch = useDeferredValue(search);
  const [showHelp, setShowHelp] = useState(false);
  const compiled = useMemo(() => compileFilter(deferredSearch, quickFilter), [deferredSearch, quickFilter]);
  const rows = useMemo(() => exchanges.filter((e) => compiled.matches(e)), [exchanges, compiled]);
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
        <nav className="views" aria-label="View">
          <button
            type="button"
            className={`tab ${view === 'traffic' ? 'active' : ''}`}
            aria-current={view === 'traffic' ? 'page' : undefined}
            onClick={() => setView('traffic')}
          >
            Traffic
          </button>
          <button
            type="button"
            className={`tab ${view === 'setup' ? 'active' : ''}`}
            aria-current={view === 'setup' ? 'page' : undefined}
            onClick={() => setView('setup')}
          >
            Setup
          </button>
          {pluginViews.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`tab ${view === p.key ? 'active' : ''}`}
              aria-current={view === p.key ? 'page' : undefined}
              onClick={() => setView(p.key)}
            >
              {p.view.label}
              {badges[p.key] && (
                <span className="tab-badge" aria-label={`${badges[p.key]} waiting`}>
                  {badges[p.key]}
                </span>
              )}
            </button>
          ))}
        </nav>
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
          <button type="button" className="secondary" onClick={() => setView('setup')}>
            Set up traffic
          </button>
        )}
      </header>

      {/* Plugin views stay mounted while hidden, so switching tabs keeps unsaved edits. */}
      {pluginViews.map((p) => (
        <div key={`${p.key}:${session}`} hidden={view !== p.key} className="plugin-view-host">
          <PluginView
            view={p.view}
            status={status?.plugins.find((s) => s.name === p.plugin)}
            api={pluginApi(p.plugin)}
          />
        </div>
      ))}

      {view === 'setup' && status && (
        <SetupPage status={status} connected={connected} send={send} onLaunched={() => setView('traffic')} />
      )}

      {view === 'traffic' && (
        <>
          <div className="filterbar">
            <input
              ref={searchRef}
              type="search"
              className="search"
              placeholder="Search, or filter: status>=400 host=api.*"
              aria-label="Search traffic"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch('');
              }}
            />
            <button
              type="button"
              className="icon help-button"
              aria-label="Search syntax"
              aria-expanded={showHelp}
              onClick={() => setShowHelp((v) => !v)}
            >
              ?
            </button>
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
                : `${exchanges.length.toLocaleString()} ${exchanges.length === 1 ? 'request' : 'requests'}`}
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
          {(compiled.errors.length > 0 || compiled.hints.length > 0) && (
            <div className="filter-notes" role="status">
              {compiled.errors.map((e) => (
                <span key={e} className="error">
                  {e}
                </span>
              ))}
              {compiled.hints.map((h) => (
                <span key={h} className="muted">
                  {h}
                </span>
              ))}
            </div>
          )}
          {showHelp && (
            // Zero-height anchor, so the popup opens just below the toolbar and any notes.
            <div className="filter-help-anchor">
              <FilterHelp
                onPick={(query) => {
                  setSearch(query);
                  setShowHelp(false);
                  searchRef.current?.focus();
                }}
                onClose={() => setShowHelp(false)}
              />
            </div>
          )}
        </>
      )}

      {backendState.state === 'failed' && <div className="banner error">{backendState.message}</div>}
      {message && <div className="banner error">{message}</div>}

      {view === 'traffic' && (
        <div className="main">
          <TrafficList
            rows={rows}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onKeyDown={onListKey}
            empty={
              !connected ? null : exchanges.length === 0 ? (
                <>
                  No traffic yet. Launch a browser, or see{' '}
                  <button type="button" className="link" onClick={() => setView('setup')}>
                    Setup
                  </button>{' '}
                  for other ways to send traffic through 127.0.0.1:{status?.proxyPort}.
                </>
              ) : (
                <>No requests match the current search or filter.</>
              )
            }
          />
          {selected && <DetailPane summary={selected} send={send} onClose={() => setSelectedId(undefined)} />}
        </div>
      )}
    </div>
  );
}
