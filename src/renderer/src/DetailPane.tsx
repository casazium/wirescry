import { useEffect, useRef, useState } from 'react';
import type {
  BodyContent,
  BodyInfo,
  BodySide,
  ExchangeDetail,
  ExchangeSummary,
  FormattedBody,
  Header,
} from '../../shared/api';
import { grpcStatusName } from '../../shared/grpc';
import type { Command } from './api-client';
import { BodyView } from './BodyView';
import { formatBytes } from './bytes';
import { bodyFileName } from './body-file-name';
import { curlCommand } from './curl-command';
import { protocolText } from './protocol-text';
import { redirectTarget } from './redirect';
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
  /** From before the backend restarted: only what was already loaded is left. */
  stale: boolean;
  /** Sections from plugins, shown after the timing. */
  sections?: DetailSection[];
  /** The response straight after the overview, as Compose shows a request it just sent. */
  responseFirst?: boolean;
  /** The captured request that followed a redirect to `target`, if there is one. */
  followingRequest?(target: string): ExchangeSummary | undefined;
  /** Shows another request's details, e.g. the one a redirect led to. */
  onSelectExchange?(id: string): void;
}

/** A plugin's section in the detail pane. */
export interface DetailSection {
  key: string;
  label: string;
  content: React.ReactNode;
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
  onSave,
}: {
  state: BodyState | undefined;
  info: BodyInfo | undefined;
  format: () => Promise<FormattedBody>;
  onSave?: () => Promise<string | undefined>;
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
      <BodyView content={state.content} format={format} onSave={onSave} />
    </>
  );
}

function ms(from: number | undefined, to: number | undefined): string {
  return from !== undefined && to !== undefined ? `${Math.max(0, Math.round(to - from))} ms` : '–';
}

/** Headers, timing and bodies for the selected exchange. */
export function DetailPane({
  summary,
  send,
  onClose,
  actions,
  stale,
  sections = [],
  responseFirst = false,
  followingRequest,
  onSelectExchange,
}: Props): React.JSX.Element {
  const [loaded, setDetail] = useState<ExchangeDetail>();
  // Only this exchange's details, never the last one's while the next loads.
  const detail = loaded?.summary.id === summary.id ? loaded : undefined;
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const [copied, setCopied] = useState<string>();
  // Where keyboard focus goes after following a redirect: the link itself goes away.
  const overviewHeading = useRef<HTMLHeadingElement>(null);

  // Refetch when the summary changes, e.g. when the response arrives.
  useEffect(() => {
    // The backend that had it is gone; keep whatever was loaded.
    if (stale) return;
    let active = true;
    send({ command: 'getExchange', exchangeId: summary.id }).then(
      (value) => active && setDetail(value as ExchangeDetail),
      () => active && setDetail(undefined),
    );
    return () => {
      active = false;
    };
  }, [send, summary, stale]);

  const redirect = detail?.responseHeaders ? redirectTarget(summary, detail.responseHeaders) : undefined;
  const followed = redirect && onSelectExchange ? followingRequest?.(redirect) : undefined;
  const requestSize = detail?.requestBody?.size;
  const responseSize = detail?.responseBody?.size;
  // The server never answered, so the response shown is the error reply Wirescry sent.
  const byWirescry = !!summary.failure && !summary.failure.partial && summary.status !== undefined;

  // Loaded bodies, keyed by exchange, side and size so a changed body is fetched again.
  const bodyKey = (side: BodySide, size: number | undefined): string => `${summary.id}:${side}:${size}`;
  useEffect(() => {
    let active = true;
    const load = (side: BodySide, size: number | undefined): void => {
      if (!size || stale) return;
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
  }, [send, summary.id, requestSize, responseSize, stale]);
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

  /** Saves a whole body to a file the user picks; not for a stale exchange, whose body is gone. */
  const saveBody = (side: BodySide): (() => Promise<string | undefined>) | undefined =>
    stale
      ? undefined
      : async () => {
          const headers = side === 'request' ? detail?.requestHeaders : detail?.responseHeaders;
          const contentType = headers?.find(([n]) => n.toLowerCase() === 'content-type')?.[1];
          const result = await window.wirescry.saveBody({
            exchangeId: summary.id,
            side,
            name: bodyFileName(summary.url, contentType, side),
          });
          if (!result.name) return undefined;
          return result.decodeError
            ? `Saved ${result.name} as stored: ${result.decodeError}`
            : `Saved ${result.name} (${formatBytes(result.size ?? 0)})`;
        };

  // Query parameters, parsed, when the URL has any.
  let query: Array<[string, string]> = [];
  try {
    query = [...new URL(summary.url).searchParams];
  } catch {
    // Not a URL we can parse; nothing to show.
  }

  // The backend that had a stale exchange's bodies is gone, so it can't format them.
  const formatBody = (side: BodySide): Promise<FormattedBody> =>
    stale
      ? Promise.resolve({ ok: false, reason: 'the proxy that had this body restarted.' })
      : (send({ command: 'formatBody', exchangeId: summary.id, side }) as Promise<FormattedBody>);

  // The response as it arrived: headers, then body. Compose puts it first, body first.
  const responseHeadersBlock = (
    <>
      {detail?.responseHeaders && (
        <details open>
          <summary>Response headers{byWirescry && ' (sent by Wirescry)'}</summary>
          <HeaderTable headers={detail.responseHeaders} />
        </details>
      )}
    </>
  );
  const responseBodyBlock = (
    <>
      {!!responseSize && (
        <details open>
          <summary>Response body{byWirescry && ' (sent by Wirescry)'}</summary>
          <Body
            state={responseBody}
            info={detail?.responseBody}
            format={() => formatBody('response')}
            onSave={saveBody('response')}
          />
        </details>
      )}
    </>
  );
  // Sent after the body; gRPC puts a call's status here.
  const responseTrailersBlock = (
    <>
      {detail?.responseTrailers && detail.responseTrailers.length > 0 && (
        <details open>
          <summary>Response trailers</summary>
          <HeaderTable headers={detail.responseTrailers} />
        </details>
      )}
    </>
  );
  const response = responseFirst ? (
    <>
      {responseBodyBlock}
      {responseHeadersBlock}
      {responseTrailersBlock}
    </>
  ) : (
    <>
      {responseHeadersBlock}
      {responseBodyBlock}
      {responseTrailersBlock}
    </>
  );

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
                  {summary.failure.kind === 'blocked'
                    ? `Wirescry replied to the device with ${summary.status}.`
                    : `The server never answered, so Wirescry replied to the client with ${summary.status}.`}
                </span>
              )
            )}
          </div>
        )}
        {stale && !detail && (
          <p className="note">
            This request is from before Wirescry’s proxy restarted. Its headers and bodies were lost; only the
            summary is left.
          </p>
        )}
        <section>
          <h2 ref={overviewHeading} tabIndex={-1}>
            Overview
          </h2>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              {summary.failure
                ? `Failed (${summary.failure.code})`
                : summary.status !== undefined
                  ? `${summary.status} ${summary.statusMessage ?? ''}`
                  : 'Waiting for response'}
            </dd>
            {summary.grpcStatus !== undefined && (
              <>
                <dt>gRPC status</dt>
                <dd>
                  {grpcStatusName(summary.grpcStatus)} ({summary.grpcStatus})
                  {summary.grpcMessage ? `: ${summary.grpcMessage}` : ''}
                </dd>
              </>
            )}
            {redirect && (
              <>
                <dt>Redirects to</dt>
                <dd className="redirect">
                  {followed ? (
                    <button
                      type="button"
                      className="link"
                      title="Show the request that followed it"
                      onClick={() => {
                        onSelectExchange!(followed.id);
                        overviewHeading.current?.focus();
                      }}
                    >
                      {redirect}
                    </button>
                  ) : (
                    redirect
                  )}
                </dd>
              </>
            )}
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
              {protocolText(summary.protocol, summary.httpVersion)}
              {byWirescry && ', between the client and Wirescry'}
            </dd>
            <dt>Request body</dt>
            <dd>{requestSize !== undefined ? formatBytes(requestSize) : '–'}</dd>
            <dt>Response body</dt>
            <dd>{responseSize !== undefined ? formatBytes(responseSize) : '–'}</dd>
          </dl>
        </section>

        {responseFirst && response}

        {timing && (
          <section>
            <h2>Timing</h2>
            <dl className="facts">
              <dt>Request received</dt>
              <dd>{ms(timing.startTimestamp, timing.bodyReceivedTimestamp)}</dd>
              {/* A rule's reply may come from no server at all (a mock, a delay, a pause). */}
              <dt>{summary.handledBy ? 'Waiting for response' : 'Waiting for server'}</dt>
              <dd>{ms(timing.bodyReceivedTimestamp, timing.headersSentTimestamp)}</dd>
              <dt>Response sent</dt>
              <dd>{ms(timing.headersSentTimestamp, timing.responseSentTimestamp)}</dd>
              <dt>Total</dt>
              <dd>{ms(timing.startTimestamp, timing.responseSentTimestamp ?? timing.abortedTimestamp)}</dd>
            </dl>
          </section>
        )}

        {sections.map((section) => (
          <details open key={section.key} className="plugin-section">
            <summary>{section.label}</summary>
            {section.content}
          </details>
        ))}

        {/* An old connection's messages can't be fetched; one that was open keeps what it showed. */}
        {summary.websocket && (!stale || detail) && (
          <WebSocketMessagesView
            key={summary.id}
            exchangeId={summary.id}
            messageCount={summary.messageCount ?? 0}
            send={send}
          />
        )}

        {query.length > 0 && (
          <details open>
            <summary>Query</summary>
            <HeaderTable headers={query} />
          </details>
        )}
        <details open>
          <summary>Request headers</summary>
          {detail ? (
            <HeaderTable headers={detail.requestHeaders} />
          ) : (
            <p className="muted">{stale ? 'Lost when the proxy restarted.' : 'Loading…'}</p>
          )}
        </details>
        {!!requestSize && (
          <details open>
            <summary>Request body</summary>
            <Body
              state={requestBody}
              info={detail?.requestBody}
              format={() => formatBody('request')}
              onSave={saveBody('request')}
            />
          </details>
        )}
        {detail?.requestTrailers && detail.requestTrailers.length > 0 && (
          <details open>
            <summary>Request trailers</summary>
            <HeaderTable headers={detail.requestTrailers} />
          </details>
        )}
        {!responseFirst && response}
      </div>
    </aside>
  );
}
