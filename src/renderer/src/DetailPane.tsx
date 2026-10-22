import { useEffect, useState } from 'react';
import type { BodyContent, BodySide, ExchangeDetail, ExchangeSummary, Header } from '../../shared/api';
import { toCurl } from '../../shared/curl';
import type { Command } from './api-client';
import { BodyView } from './BodyView';
import { base64ToBytes, formatBytes } from './bytes';

interface Props {
  summary: ExchangeSummary;
  send(command: Command): Promise<unknown>;
  onClose(): void;
}

type BodyState = { content: BodyContent | null } | { error: string };

function HeaderTable({ headers }: { headers: Header[] }): React.JSX.Element {
  return (
    <table className="headers">
      <tbody>
        {headers.map(([name, value], i) => (
          <tr key={i}>
            <th>{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({ state, dropped }: { state: BodyState | undefined; dropped?: boolean }): React.JSX.Element {
  if (dropped) return <p className="muted">Body too large to capture.</p>;
  if (!state) return <p className="muted">Loading…</p>;
  if ('error' in state) return <p className="note error">{state.error}</p>;
  if (!state.content) return <p className="muted">No body</p>;
  return <BodyView content={state.content} />;
}

function ms(from: number | undefined, to: number | undefined): string {
  return from !== undefined && to !== undefined ? `${Math.max(0, Math.round(to - from))} ms` : '–';
}

/** Headers, timing and bodies for the selected exchange. */
export function DetailPane({ summary, send, onClose }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<ExchangeDetail>();
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const [copied, setCopied] = useState<string>();

  // Refetch when the summary changes, e.g. when the response arrives.
  useEffect(() => {
    let active = true;
    send({ command: 'getExchange', exchangeId: summary.id }).then(
      (value) => active && setDetail(value as ExchangeDetail),
      () => active && setDetail(undefined),
    );
    return () => {
      active = false;
    };
  }, [send, summary]);

  const requestSize = detail?.requestBody?.size;
  const responseSize = detail?.responseBody?.size;

  // Loaded bodies, keyed by exchange, side and size so a changed body is fetched again.
  const bodyKey = (side: BodySide, size: number | undefined): string => `${summary.id}:${side}:${size}`;
  useEffect(() => {
    let active = true;
    const load = (side: BodySide, size: number | undefined): void => {
      if (!size) return;
      const key = `${summary.id}:${side}:${size}`;
      // Keep only this exchange's bodies; they can be megabytes each.
      const keepCurrent = (b: Record<string, BodyState>): Record<string, BodyState> =>
        Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith(`${summary.id}:`)));
      send({ command: 'getBody', exchangeId: summary.id, side }).then(
        (value) =>
          active &&
          setBodies((b) => ({ ...keepCurrent(b), [key]: { content: value as BodyContent | null } })),
        (error: Error) =>
          active && setBodies((b) => ({ ...keepCurrent(b), [key]: { error: error.message } })),
      );
    };
    load('request', requestSize);
    load('response', responseSize);
    return () => {
      active = false;
    };
  }, [send, summary.id, requestSize, responseSize]);
  const requestBody = bodies[bodyKey('request', requestSize)];
  const responseBody = bodies[bodyKey('response', responseSize)];

  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied('Copy failed');
    }
    setTimeout(() => setCopied(undefined), 1500);
  };

  const copyCurl = async (): Promise<void> => {
    if (!detail) return;
    const request = requestBody;
    let headers = detail.requestHeaders;
    let body: Uint8Array | undefined;
    if (request && 'content' in request && request.content) {
      body = base64ToBytes(request.content.base64);
      // The UI has the decoded body, so send it unencoded.
      if (request.content.decodedSize !== undefined) {
        headers = headers.filter(([name]) => name.toLowerCase() !== 'content-encoding');
      }
    }
    await copy('curl', toCurl({ method: summary.method, url: summary.url, headers, body }));
  };

  const timing = detail?.timing;

  return (
    <aside className="detail" aria-label="Exchange details">
      <div className="detail-header">
        <strong>{summary.method}</strong>
        <span className="detail-url" title={summary.url}>
          {summary.url}
        </span>
        <button type="button" className="icon" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="detail-actions">
        <button type="button" className="secondary" onClick={() => void copy('URL', summary.url)}>
          Copy URL
        </button>
        <button type="button" className="secondary" onClick={() => void copyCurl()} disabled={!detail}>
          Copy as curl
        </button>
        {copied && <span className="muted">{copied === 'Copy failed' ? copied : `Copied ${copied}`}</span>}
      </div>
      <div className="detail-body">
        {summary.failure && (
          <div className="failure" role="alert">
            <strong>{summary.failure.message}</strong>
            {summary.failure.detail && <code>{summary.failure.detail}</code>}
            {summary.failure.kind !== 'client-closed' && summary.status !== undefined && (
              <span className="muted">
                The server never answered, so Leverframe replied to the client with {summary.status}.
              </span>
            )}
          </div>
        )}
        <section>
          <h2>Overview</h2>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              {summary.failure
                ? `Failed (${summary.failure.code})`
                : summary.status !== undefined
                  ? `${summary.status} ${summary.statusMessage ?? ''}`
                  : 'Waiting for response'}
            </dd>
            {summary.closeCode !== undefined && (
              <>
                <dt>Closed</dt>
                <dd>WebSocket close code {summary.closeCode}</dd>
              </>
            )}
            <dt>Protocol</dt>
            <dd>
              {summary.protocol.toUpperCase()}, HTTP/{summary.httpVersion}
            </dd>
            <dt>Request body</dt>
            <dd>{requestSize !== undefined ? formatBytes(requestSize) : '–'}</dd>
            <dt>Response body</dt>
            <dd>{responseSize !== undefined ? formatBytes(responseSize) : '–'}</dd>
          </dl>
        </section>

        {timing && (
          <section>
            <h2>Timing</h2>
            <dl className="facts">
              <dt>Request received</dt>
              <dd>{ms(timing.startTimestamp, timing.bodyReceivedTimestamp)}</dd>
              <dt>Waiting for server</dt>
              <dd>{ms(timing.bodyReceivedTimestamp, timing.headersSentTimestamp)}</dd>
              <dt>Response sent</dt>
              <dd>{ms(timing.headersSentTimestamp, timing.responseSentTimestamp)}</dd>
              <dt>Total</dt>
              <dd>{ms(timing.startTimestamp, timing.responseSentTimestamp ?? timing.abortedTimestamp)}</dd>
            </dl>
          </section>
        )}

        <details open>
          <summary>Request headers</summary>
          {detail ? <HeaderTable headers={detail.requestHeaders} /> : <p className="muted">Loading…</p>}
        </details>
        {(!!requestSize || detail?.requestBody?.dropped) && (
          <details open>
            <summary>Request body</summary>
            <Body state={requestBody} dropped={detail?.requestBody?.dropped} />
          </details>
        )}
        {detail?.responseHeaders && (
          <details open>
            <summary>Response headers</summary>
            <HeaderTable headers={detail.responseHeaders} />
          </details>
        )}
        {(!!responseSize || detail?.responseBody?.dropped) && (
          <details open>
            <summary>Response body</summary>
            <Body state={responseBody} dropped={detail?.responseBody?.dropped} />
          </details>
        )}
      </div>
    </aside>
  );
}
