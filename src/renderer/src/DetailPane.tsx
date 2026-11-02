import { useEffect, useState } from 'react';
import type {
  BodyContent,
  BodyInfo,
  BodySide,
  ExchangeDetail,
  ExchangeSummary,
  FormattedBody,
  Header,
} from '../../shared/api';
import type { Command } from './api-client';
import { BodyView } from './BodyView';
import { formatBytes } from './bytes';
import { curlCommand } from './curl-command';
import { WebSocketMessagesView } from './WebSocketMessagesView';
import { DETAIL_PANE_ID } from './Splitter';

/** A plugin's action on this exchange, such as Pro's "Mock…". */
export interface ExchangeActionButton {
  key: string;
  label: string;
  run(): void;
}

interface Props {
  summary: ExchangeSummary;
  send(command: Command): Promise<unknown>;
  onClose(): void;
  actions: ExchangeActionButton[];
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

function Body({
  state,
  info,
  format,
}: {
  state: BodyState | undefined;
  info: BodyInfo | undefined;
  format: () => Promise<FormattedBody>;
}): React.JSX.Element {
  const notes = (
    <>
      {info?.incomplete && <p className="note">The connection closed before the whole body arrived.</p>}
      {info && info.stored < info.size && (
        <p className="note">
          Wirescry kept the first {formatBytes(info.stored)} of this {formatBytes(info.size)} body.
        </p>
      )}
    </>
  );
  if (!state) return <p className="muted">Loading…</p>;
  if ('error' in state) return <p className="note error">{state.error}</p>;
  if (!state.content) return <p className="muted">No body</p>;
  return (
    <>
      {notes}
      <BodyView content={state.content} format={format} />
    </>
  );
}

function ms(from: number | undefined, to: number | undefined): string {
  return from !== undefined && to !== undefined ? `${Math.max(0, Math.round(to - from))} ms` : '–';
}

/** Headers, timing and bodies for the selected exchange. */
export function DetailPane({ summary, send, onClose, actions }: Props): React.JSX.Element {
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
    const body = requestBody && 'content' in requestBody ? requestBody.content : undefined;
    await copy('curl', curlCommand(summary, detail, body));
  };

  const timing = detail?.timing;

  return (
    <aside className="detail" id={DETAIL_PANE_ID} aria-label="Exchange details">
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
        {!summary.websocket && (
          <button type="button" className="secondary" onClick={() => void copyCurl()} disabled={!detail}>
            Copy as curl
          </button>
        )}
        {actions.map((action) => (
          <button key={action.key} type="button" className="secondary" onClick={action.run}>
            {action.label}
          </button>
        ))}
        {copied && <span className="muted">{copied === 'Copy failed' ? copied : `Copied ${copied}`}</span>}
      </div>
      <div className="detail-body">
        {summary.failure && (
          <div className="failure" role="alert">
            <strong>{summary.failure.message}</strong>
            {summary.failure.detail && <code>{summary.failure.detail}</code>}
            {summary.failure.partial ? (
              <span className="muted">
                The server had started responding. The body below is what arrived before the connection broke.
              </span>
            ) : (
              summary.failure.kind !== 'client-closed' &&
              summary.status !== undefined && (
                <span className="muted">
                  The server never answered, so Wirescry replied to the client with {summary.status}.
                </span>
              )
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
                <dd>
                  Code {summary.closeCode}
                  {summary.closeReason ? `: ${summary.closeReason}` : ''}
                </dd>
              </>
            )}
            {detail?.importedFrom && (
              <>
                <dt>Imported from</dt>
                <dd>{detail.importedFrom}</dd>
              </>
            )}
            {summary.handledBy && (
              <>
                <dt>Handled by</dt>
                <dd>Rule “{summary.handledBy.label}”</dd>
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

        {summary.websocket && (
          <WebSocketMessagesView
            key={summary.id}
            exchangeId={summary.id}
            messageCount={summary.messageCount ?? 0}
            send={send}
          />
        )}

        <details open>
          <summary>Request headers</summary>
          {detail ? <HeaderTable headers={detail.requestHeaders} /> : <p className="muted">Loading…</p>}
        </details>
        {!!requestSize && (
          <details open>
            <summary>Request body</summary>
            <Body
              state={requestBody}
              info={detail?.requestBody}
              format={() =>
                send({
                  command: 'formatBody',
                  exchangeId: summary.id,
                  side: 'request',
                }) as Promise<FormattedBody>
              }
            />
          </details>
        )}
        {detail?.responseHeaders && (
          <details open>
            <summary>Response headers</summary>
            <HeaderTable headers={detail.responseHeaders} />
          </details>
        )}
        {!!responseSize && (
          <details open>
            <summary>Response body</summary>
            <Body
              state={responseBody}
              info={detail?.responseBody}
              format={() =>
                send({
                  command: 'formatBody',
                  exchangeId: summary.id,
                  side: 'response',
                }) as Promise<FormattedBody>
              }
            />
          </details>
        )}
      </div>
    </aside>
  );
}
