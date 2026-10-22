import { useEffect, useRef, useState } from 'react';
import type { ExchangeSummary } from '../../shared/api';
import { useBackend } from './useBackend';

function statusClass(exchange: ExchangeSummary): string {
  if (exchange.error) return 'status error';
  if (exchange.status === undefined) return 'status pending';
  if (exchange.status >= 500) return 'status error';
  if (exchange.status >= 400) return 'status warn';
  if (exchange.status >= 300) return 'status redirect';
  return 'status ok';
}

export function App(): React.JSX.Element {
  const { backendState, connected, status, exchanges, send } = useBackend();
  const [message, setMessage] = useState<string>();
  const [selectedBrowser, setSelectedBrowser] = useState<string>('');
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const browsers = status?.browsers ?? [];
  const browserId = selectedBrowser || browsers[0]?.id || '';

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [exchanges]);

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

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Leverframe</h1>
        <span className={`pill ${connected ? 'live' : ''}`} data-testid="proxy-status">
          {stateLabel}
        </span>
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
        <button
          type="button"
          className="secondary"
          onClick={() => void send({ command: 'clear' })}
          disabled={!connected}
        >
          Clear
        </button>
      </header>

      {backendState.state === 'failed' && <div className="banner error">{backendState.message}</div>}
      {message && <div className="banner error">{message}</div>}

      <div
        className="list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <table>
          <thead>
            <tr>
              <th className="col-method">Method</th>
              <th className="col-status">Status</th>
              <th className="col-host">Host</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {exchanges.map((e) => (
              <tr key={e.id} data-testid="exchange-row">
                <td className="col-method">{e.method}</td>
                <td className={`col-status ${statusClass(e)}`} title={e.error ?? e.statusMessage}>
                  {e.error ? 'Failed' : (e.status ?? '…')}
                </td>
                <td className="col-host">{e.host}</td>
                <td className="col-path" title={e.url}>
                  {e.path}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {connected && exchanges.length === 0 && (
          <p className="empty">
            No traffic yet. Launch a browser, or send requests through 127.0.0.1:{status?.proxyPort}.
          </p>
        )}
      </div>
    </div>
  );
}
