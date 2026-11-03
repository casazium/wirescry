import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { compileFilter, QUICK_FILTERS, type QuickFilter } from '../../shared/filter';
import type { ExchangeSummary } from '../../shared/api';
import type { MenuChoice, MenuCommand } from '../../shared/ipc';
import { fetchCurlCommand } from './curl-command';
import { DetailPane, type ExchangeActionButton } from './DetailPane';
import { FilterHelp } from './FilterHelp';
import { PluginView } from './PluginView';
import { uiPlugins } from '@wirescry/pro/ui';
import { PLUGIN_API_VERSION } from '../../plugin-api/version';
import { SetupPage } from './SetupPage';
import { loadDetailSize, saveDetailSize, useStacked } from './detail-size';
import { Splitter } from './Splitter';
import { TrafficList } from './TrafficList';
import { useBackend } from './useBackend';

// A UI plugin built for another API version is left out; its backend half reports why.
const compatiblePlugins = uiPlugins.filter((p) => p.apiVersion === PLUGIN_API_VERSION);
const pluginViews = compatiblePlugins.flatMap((plugin) =>
  plugin.views.map((v) => ({ key: `${plugin.name}:${v.id}`, plugin: plugin.name, view: v })),
);
const exchangeActions = compatiblePlugins.flatMap((plugin) =>
  (plugin.exchangeActions ?? []).map((action) => ({ plugin: plugin.name, action })),
);

export function App(): React.JSX.Element {
  // 'traffic', 'setup', or `${plugin}:${viewId}` for a plugin's view.
  const [view, setView] = useState<string>('traffic');
  const {
    backendState,
    connected,
    status,
    exchanges,
    paused,
    send,
    pluginApi,
    session,
    badges,
    previous,
    restartNotice,
    dismissRestartNotice,
  } = useBackend((key) => {
    if (pluginViews.some((p) => p.key === key)) setView(key);
  });
  const [message, setMessage] = useState<string>();
  /** The last HAR import or export, until dismissed. */
  const [notice, setNotice] = useState<string>();
  const [pillCopied, setPillCopied] = useState(false);
  const [harBusy, setHarBusy] = useState(false);
  const [selectedBrowser, setSelectedBrowser] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // The detail pane's size, remembered separately for side by side and stacked.
  const stacked = useStacked();
  const sizeKey = stacked ? 'wirescry.detailSize.stacked' : 'wirescry.detailSize.side';
  const [detailSizes, setDetailSizes] = useState<Record<string, number>>(() => ({
    'wirescry.detailSize.side': loadDetailSize('wirescry.detailSize.side'),
    'wirescry.detailSize.stacked': loadDetailSize('wirescry.detailSize.stacked'),
  }));
  const detailSize = detailSizes[sizeKey] ?? 0.5;
  const resizeDetail = (size: number): void => setDetailSizes((sizes) => ({ ...sizes, [sizeKey]: size }));

  // Typing stays responsive while a large list is re-filtered.
  const deferredSearch = useDeferredValue(search);
  const [showHelp, setShowHelp] = useState(false);
  const compiled = useMemo(() => compileFilter(deferredSearch, quickFilter), [deferredSearch, quickFilter]);
  // Requests from before a backend restart come first, read-only (only their summaries are left).
  const staleIds = useMemo(() => new Set(previous.map((e) => e.id)), [previous]);
  const allExchanges = useMemo(
    () => (previous.length > 0 ? [...previous, ...exchanges] : exchanges),
    [previous, exchanges],
  );
  const rows = useMemo(() => allExchanges.filter((e) => compiled.matches(e)), [allExchanges, compiled]);
  const selected = selectedId ? allExchanges.find((e) => e.id === selectedId) : undefined;
  const exportable = useMemo(() => rows.filter((e) => !staleIds.has(e.id)), [rows, staleIds]);

  const browsers = status?.browsers ?? [];
  const browserId = selectedBrowser || browsers[0]?.id || '';

  const closeHelp = (returnFocus: boolean): void => {
    setShowHelp(false);
    if (returnFocus) helpButtonRef.current?.focus();
  };

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

  /** Plugin actions offered for an exchange, from running plugins only. */
  const actionsFor = (exchange: ExchangeSummary): ExchangeActionButton[] =>
    // A request from before a restart has nothing left for a plugin to work with.
    staleIds.has(exchange.id)
      ? []
      : exchangeActions
          .filter(({ plugin, action }) => {
            if (!status?.plugins.find((s) => s.name === plugin)?.active) return false;
            try {
              return action.appliesTo?.(exchange) ?? true;
            } catch {
              return false;
            }
          })
          .map(({ plugin, action }) => ({
            key: `${plugin}:${action.id}`,
            label: action.label,
            run: () => {
              setMessage(undefined);
              // A plugin's failure is shown, not thrown at the app.
              Promise.resolve()
                .then(() => action.run(exchange, pluginApi(plugin)))
                .catch((error: unknown) =>
                  setMessage(
                    `${action.label.replace(/…$/, '')} didn't work: ${(error as Error)?.message ?? error}`,
                  ),
                );
            },
          }));

  /** The right-click menu on a traffic row. */
  const showRowMenu = async (exchange: ExchangeSummary): Promise<void> => {
    setSelectedId(exchange.id);
    const actions = actionsFor(exchange);
    const stale = staleIds.has(exchange.id);
    const choices: MenuChoice[] = [
      { id: 'copy-url', label: 'Copy URL' },
      ...(exchange.websocket || stale ? [] : [{ id: 'copy-curl', label: 'Copy as curl' }]),
      ...(actions.length > 0 ? [{ separator: true as const }] : []),
      // Within what a menu accepts: short labels, and at most 40 items.
      ...actions.slice(0, 30).map((a) => ({ id: a.key, label: a.label.slice(0, 100) })),
    ];
    let chosen: string | undefined;
    try {
      chosen = await window.wirescry.showMenu(choices);
    } catch (error) {
      setMessage(`Couldn't show the menu: ${(error as Error).message}`);
      return;
    }
    try {
      if (chosen === 'copy-url') await navigator.clipboard.writeText(exchange.url);
      else if (chosen === 'copy-curl')
        await navigator.clipboard.writeText(await fetchCurlCommand(exchange, send));
      else actions.find((a) => a.key === chosen)?.run();
    } catch (error) {
      setMessage(`Couldn't copy: ${(error as Error).message}`);
    }
  };

  /** Exports what the list shows (the filter applies), in list order. */
  const exportHar = async (): Promise<void> => {
    setMessage(undefined);
    setNotice(undefined);
    setHarBusy(true);
    try {
      const result = await window.wirescry.exportHar(exportable.map((e) => e.id));
      if (result.name) {
        const left = rows.length - exportable.length;
        setNotice(
          `Exported ${result.count?.toLocaleString()} ${result.count === 1 ? 'request' : 'requests'} to ${result.name}.` +
            (left > 0
              ? ` ${left.toLocaleString()} from before the proxy restarted ${left === 1 ? 'wasn’t' : 'weren’t'} included: their details were lost.`
              : ''),
        );
      }
    } catch (error) {
      setMessage(`Couldn't export: ${(error as Error).message}`);
    } finally {
      setHarBusy(false);
    }
  };

  const importHar = async (): Promise<void> => {
    setMessage(undefined);
    setNotice(undefined);
    setHarBusy(true);
    try {
      const result = await window.wirescry.importHar();
      if (result.name) {
        const imported = result.imported ?? 0;
        const problems = (result.problems ?? []).join(' ');
        if (imported === 0) {
          setMessage(`Nothing to import from ${result.name}.${problems ? ` ${problems}` : ''}`);
          return;
        }
        const plural = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'request' : 'requests'}`;
        let text = `Imported ${plural(imported)} from ${result.name}.`;
        if (result.skipped) text += ` Skipped ${result.skipped.toLocaleString()}: ${problems}`;
        if (result.removed) text += ` To make room, the oldest ${plural(result.removed)} left the list.`;
        setNotice(text);
      }
    } catch (error) {
      setMessage(`Couldn't import: ${(error as Error).message}`);
    } finally {
      setHarBusy(false);
    }
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
  if (backendState.state === 'failed') stateLabel = 'Proxy stopped';
  // After the first connection, a gap means the backend is restarting.
  else if (!connected) stateLabel = session > 0 ? 'Proxy restarting…' : 'Starting…';
  else stateLabel = `Proxy on 127.0.0.1:${status?.proxyPort}`;

  const filtered = search.trim() !== '' || quickFilter !== 'all';

  /** Arrow keys, Home and End move between the quick-filter chips, as in any radio group. */
  const onChipKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = QUICK_FILTERS.findIndex((f) => f.id === quickFilter);
    const last = QUICK_FILTERS.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setQuickFilter(QUICK_FILTERS[next]!.id);
    const chips = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    chips[next]?.focus();
  };

  const clearAll = (): void => {
    setSelectedId(undefined);
    void send({ command: 'clear' });
  };

  // Commands from the app menu (and their shortcuts), handled with the latest state.
  const menuHandlers = useRef<(command: MenuCommand) => void>(() => {});
  useEffect(() => {
    menuHandlers.current = (command) => {
      if (command === 'find') {
        setView('traffic');
        requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
      } else if (!connected) {
        return;
      } else if (command === 'import-har') {
        if (!harBusy) void importHar();
      } else if (command === 'export-har') {
        if (!harBusy && exportable.length > 0) void exportHar();
      } else if (command === 'toggle-recording') {
        void send({ command: 'setPaused', paused: !paused });
      } else if (command === 'clear') {
        // Not while typing: Cmd/Ctrl+K mustn't wipe the list from a text field.
        const focused = document.activeElement as HTMLElement | null;
        const typing =
          focused?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused?.tagName ?? '');
        if (!typing) clearAll();
      }
      // The menu ticks Pause Recording itself when clicked; put it back if nothing changed.
      window.wirescry.setMenuState({ connected, canExport: exportable.length > 0 && !harBusy, paused });
    };
  });
  useEffect(() => window.wirescry.onMenuCommand((command) => menuHandlers.current(command)), []);
  useEffect(() => {
    window.wirescry.setMenuState({ connected, canExport: exportable.length > 0 && !harBusy, paused });
  }, [connected, exportable.length, harBusy, paused]);

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Wirescry</h1>
        {connected && status ? (
          <button
            type="button"
            className="pill live"
            data-testid="proxy-status"
            title="Copy the proxy address"
            onClick={() => {
              void navigator.clipboard.writeText(`127.0.0.1:${status.proxyPort}`).then(() => {
                setPillCopied(true);
                setTimeout(() => setPillCopied(false), 1500);
              });
            }}
          >
            {pillCopied ? 'Copied' : stateLabel}
          </button>
        ) : (
          <span className="pill" data-testid="proxy-status">
            {stateLabel}
          </span>
        )}
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
                <>
                  <span className={`tab-badge ${badges[p.key]!.tag ? 'tag' : ''}`} aria-hidden="true">
                    {badges[p.key]!.text}
                  </span>
                  {/* Read with the tab's name, e.g. "Breakpoints, 2 waiting". */}
                  <span className="visually-hidden">
                    {', '}
                    {badges[p.key]!.label ??
                      (badges[p.key]!.tag ? badges[p.key]!.text : `${badges[p.key]!.text} waiting`)}
                  </span>
                </>
              )}
            </button>
          ))}
        </nav>
        <div className="toolbar-actions">
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
              <button
                type="button"
                onClick={launch}
                disabled={!connected}
                aria-label={`Launch ${browsers.find((b) => b.id === browserId)?.name ?? 'browser'}`}
              >
                {/* With a browser menu beside it, the menu already names the browser. */}
                {browsers.length > 1 ? 'Launch' : `Launch ${browsers[0]?.name ?? 'browser'}`}
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => setView('setup')}>
              Set up traffic
            </button>
          )}
        </div>
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
              aria-controls={showHelp ? 'filter-help' : undefined}
              ref={helpButtonRef}
              onClick={() => setShowHelp((v) => !v)}
            >
              ?
            </button>
            <div className="chips" role="radiogroup" aria-label="Quick filter" onKeyDown={onChipKey}>
              {QUICK_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={quickFilter === f.id}
                  // One Tab stop for the group; arrow keys move between chips.
                  tabIndex={quickFilter === f.id ? 0 : -1}
                  className={`chip ${quickFilter === f.id ? 'active' : ''}`}
                  onClick={() => setQuickFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {/* In narrower windows, the chips become a menu. */}
            <select
              className="quick-select"
              aria-label="Quick filter"
              value={quickFilter}
              onChange={(e) => setQuickFilter(e.target.value as QuickFilter)}
            >
              {QUICK_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id === 'all' ? 'All types' : f.label}
                </option>
              ))}
            </select>
            <div className="filter-actions">
              <span className="muted count" data-testid="row-count">
                {filtered
                  ? `${rows.length.toLocaleString()} of ${allExchanges.length.toLocaleString()}`
                  : `${allExchanges.length.toLocaleString()} ${allExchanges.length === 1 ? 'request' : 'requests'}`}
              </span>
              <button
                type="button"
                className="secondary"
                title="Open a HAR file, e.g. one saved from a browser's developer tools"
                onClick={() => void importHar()}
                disabled={!connected || harBusy}
              >
                Import HAR
              </button>
              <button
                type="button"
                className="secondary"
                title={filtered ? 'Save the requests shown as a HAR file' : 'Save all requests as a HAR file'}
                onClick={() => void exportHar()}
                disabled={!connected || harBusy || exportable.length === 0}
              >
                Export HAR
              </button>
              <button
                type="button"
                className="secondary"
                // Recording only: breakpoints, which pause requests, are a different thing.
                onClick={() => void send({ command: 'setPaused', paused: !paused })}
                disabled={!connected}
              >
                {paused ? 'Resume recording' : 'Pause recording'}
              </button>
              <button type="button" className="secondary" onClick={clearAll} disabled={!connected}>
                Clear
              </button>
            </div>
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
                onClose={closeHelp}
                toggle={helpButtonRef}
              />
            </div>
          )}
        </>
      )}

      {backendState.state === 'failed' && (
        <div className="banner error actions" role="alert">
          <span>{backendState.message}</span>
          <button type="button" onClick={() => void window.wirescry.restartBackend()}>
            Restart proxy
          </button>
          <button type="button" className="secondary" onClick={() => void window.wirescry.showLog()}>
            Show log
          </button>
        </div>
      )}
      {restartNotice && backendState.state !== 'failed' && (
        <div className="banner notice restart-notice" role="status">
          <span>
            {restartNotice.crashed
              ? `Wirescry's proxy stopped unexpectedly at ${new Date(restartNotice.at).toLocaleTimeString()} and restarted.`
              : `Wirescry's proxy restarted.`}
            {restartNotice.kept > 0 &&
              ` The ${restartNotice.kept === 1 ? 'request' : `${restartNotice.kept.toLocaleString()} requests`} from before ${restartNotice.kept === 1 ? 'is' : 'are'} still listed, dimmed, but ${restartNotice.kept === 1 ? 'its' : 'their'} headers and bodies were lost.`}
            {restartNotice.dropped > 0 &&
              ` ${restartNotice.dropped === 1 ? 'One paused request was' : `${restartNotice.dropped} paused requests were`} let go.`}
          </span>
          {restartNotice.crashed && (
            <button type="button" className="secondary" onClick={() => void window.wirescry.showLog()}>
              Show log
            </button>
          )}
          <button type="button" className="icon" aria-label="Dismiss" onClick={dismissRestartNotice}>
            ×
          </button>
        </div>
      )}
      {message && (
        <div className="banner error" role="alert">
          <span>{message}</span>
          <button type="button" className="icon" aria-label="Dismiss" onClick={() => setMessage(undefined)}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="banner notice" role="status">
          <span>{notice}</span>
          <button type="button" className="icon" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
            ×
          </button>
        </div>
      )}

      {view === 'traffic' && (
        <div
          className="main"
          ref={mainRef}
          style={{ '--detail-size': `${(detailSize * 100).toFixed(1)}%` } as React.CSSProperties}
        >
          <TrafficList
            rows={rows}
            staleIds={staleIds}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onKeyDown={onListKey}
            onContextMenu={(exchange) => void showRowMenu(exchange)}
            empty={
              !connected ? null : allExchanges.length === 0 ? (
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
          {selected && (
            <>
              <Splitter
                stacked={stacked}
                size={detailSize}
                onChange={resizeDetail}
                onCommit={(size) => saveDetailSize(sizeKey, size ?? detailSize)}
                container={mainRef}
              />
              <DetailPane
                summary={selected}
                send={send}
                onClose={() => setSelectedId(undefined)}
                actions={actionsFor(selected)}
                stale={staleIds.has(selected.id)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
