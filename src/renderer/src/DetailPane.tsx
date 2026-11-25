import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodyContent,
  BodyInfo,
  BodySide,
  ExchangeDetail,
  ExchangeSummary,
  FormattedBody,
  Header,
} from '../../shared/api';
import { binaryHeaderHex, describeGrpcTimeout, grpcStatusName, isGrpcClientCancel } from '../../shared/grpc';
import type { Command } from './api-client';
import { BodyView } from './BodyView';
import { formatBytes } from './bytes';
import { bodyFileName } from './body-file-name';
import { fetchCurlCommand } from './curl-command';
import {
  CHECKING_LABEL,
  HIDING,
  isPlaceholder,
  KnownSecrets,
  maskHeaders,
  maskMessage,
  maskSummaryWith,
  maskUrl,
  ownValues,
  SecretsHidden,
  STALE,
  staleSummary,
} from './secrets';
import { REDACTED } from '../../shared/redact';
import { protocolText } from './protocol-text';
import { redirectTarget } from './redirect';
import { WebSocketMessagesView } from './WebSocketMessagesView';
import { SseEventsView } from './SseEventsView';
import { isEventStream } from '../../shared/sse';
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
  /** It hides secrets itself; otherwise it isn't shown while View › Hide Secrets is on. */
  masksSecrets?: boolean;
}

type BodyState = { content: BodyContent | null } | { error: string };

function HeaderTable({ headers, grpc }: { headers: Header[]; grpc?: boolean }): React.JSX.Element {
  return (
    <table className="headers">
      <tbody>
        {headers.map(([name, value], i) => {
          // gRPC sends binary metadata base64-encoded in headers whose names end in -bin.
          // Not for a value Hide Secrets masked or holds back: there's nothing to decode.
          const hex =
            grpc && name.toLowerCase().endsWith('-bin') && !value.includes(REDACTED) && !isPlaceholder(value)
              ? binaryHeaderHex(value)
              : undefined;
          return (
            <tr key={i}>
              <th>{name}</th>
              <td>
                {value}
                {hex !== undefined && (
                  <span className="decoded muted" title="Decoded from base64">
                    <span className="visually-hidden">Decoded: </span>
                    {hex || '(empty)'}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Body({
  state,
  info,
  format,
  onSave,
  unavailable,
}: {
  state: BodyState | undefined;
  info: BodyInfo | undefined;
  format: () => Promise<FormattedBody>;
  onSave?: () => Promise<string | undefined>;
  /** Why it can't be shown, if it can't. */
  unavailable?: string;
}): React.JSX.Element {
  const hideSecrets = useContext(SecretsHidden);
  const masking = useContext(KnownSecrets);
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
  if (unavailable) return <p className="note">{unavailable}</p>;
  if (!state) return <p className="muted">{hideSecrets ? 'Hiding secrets…' : 'Loading…'}</p>;
  // An error's text could quote something: masked like any other message while on.
  if ('error' in state)
    return <p className="note error">{hideSecrets ? maskMessage(state.error, masking) : state.error}</p>;
  if (!state.content) return <p className="muted">No body</p>;
  return (
    <>
      {notes}
      {/* Afresh when the switch changes, so nothing formatted before is kept. */}
      <BodyView
        key={hideSecrets ? 'masked' : 'real'}
        content={state.content}
        format={format}
        onSave={onSave}
      />
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
  const hideSecrets = useContext(SecretsHidden);
  const masking = useContext(KnownSecrets);
  const [loaded, setDetail] = useState<ExchangeDetail>();
  // Only this exchange's details, never the last one's while the next loads.
  const detail = loaded?.summary.id === summary.id ? loaded : undefined;
  // Its own values first, built once per detail: hidden even when the session's set is full.
  const own = useMemo(() => (hideSecrets && detail ? ownValues(detail) : undefined), [hideSecrets, detail]);
  const known = useMemo(() => (own ? [own, masking.known] : [masking.known]), [own, masking]);
  // What's shown: masked while Hide Secrets is on. Copy as curl and actions use the real summary.
  const shown = useMemo(
    () => (!hideSecrets ? summary : stale ? staleSummary(summary) : maskSummaryWith(summary, masking, own)),
    [hideSecrets, stale, summary, masking, own],
  );
  // The URL and header values while they can't be checked: not yet, or not at all (a restart).
  const withheld = !hideSecrets ? undefined : stale ? STALE : masking.covered ? undefined : HIDING;
  const urlShown = withheld ?? shown.url;
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const [copied, setCopied] = useState<string>();
  // Where keyboard focus goes after following a redirect: the link itself goes away.
  const overviewHeading = useRef<HTMLHeadingElement>(null);

  // Refetch when the summary changes, e.g. when the response arrives; not for each update of the
  // size so far while it arrives.
  const summaryKey = JSON.stringify({ ...summary, responseReceived: undefined, requestReceived: undefined });
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
  }, [send, summary.id, summaryKey, stale]);

  // Headers as shown.
  const headers = useMemo(() => {
    const show = (h: Header[] | undefined): Header[] | undefined => {
      if (!h || !hideSecrets) return h;
      if (withheld) return h.map(([name]): Header => [name, withheld]);
      return maskHeaders(h, known);
    };
    return {
      request: show(detail?.requestHeaders),
      response: show(detail?.responseHeaders),
      requestTrailers: show(detail?.requestTrailers),
      responseTrailers: show(detail?.responseTrailers),
    };
  }, [detail, hideSecrets, withheld, known]);

  const redirect = detail?.responseHeaders ? redirectTarget(summary, detail.responseHeaders) : undefined;
  const redirectShown =
    redirect !== undefined && hideSecrets ? (withheld ?? maskUrl(redirect, known)) : redirect;
  // A gRPC call its client canceled: routine, so not shown as a failure.
  const canceled = isGrpcClientCancel(summary);
  // How long a gRPC client gives the call, from its grpc-timeout.
  const deadline = summary.grpc
    ? describeGrpcTimeout(detail?.requestHeaders.find(([n]) => n.toLowerCase() === 'grpc-timeout')?.[1])
    : undefined;
  const followed = redirect && onSelectExchange ? followingRequest?.(redirect) : undefined;
  const requestSize = detail?.requestBody?.size;
  const responseSize = detail?.responseBody?.size;
  // The response is still arriving: its status and headers are in, its body isn't yet.
  const receiving = summary.responding === true && !stale;
  // Still arriving when the proxy restarted: it never will now.
  const neverFinished = summary.responding === true && stale;
  const receivedText = `Receiving… ${formatBytes(summary.responseReceived ?? 0)} so far`;
  // The server never answered, so the response shown is the error reply Wirescry sent.
  const byWirescry = !!summary.failure && !summary.failure.partial && summary.status !== undefined;

  // Loaded bodies, keyed by exchange, side, size and whether masked, so a changed body is fetched
  // again, and a body is never shown as it was while Hide Secrets is on.
  const mode = hideSecrets ? 'masked' : 'real';
  const bodyKey = (side: BodySide, size: number | undefined): string =>
    `${summary.id}:${side}:${size}:${mode}`;
  useEffect(() => {
    let active = true;
    const load = (side: BodySide, size: number | undefined): void => {
      if (!size || stale) return;
      const key = `${summary.id}:${side}:${size}:${mode}`;
      // Keep only this exchange's bodies, as now shown; they can be megabytes each.
      const keepCurrent = (b: Record<string, BodyState>): Record<string, BodyState> =>
        Object.fromEntries(
          Object.entries(b).filter(([k]) => k.startsWith(`${summary.id}:`) && k.endsWith(`:${mode}`)),
        );
      send({
        command: 'getBody',
        exchangeId: summary.id,
        side,
        ...(mode === 'masked' ? { mask: true } : {}),
      }).then(
        (value) =>
          active &&
          setBodies((b) => ({ ...keepCurrent(b), [key]: { content: value as BodyContent | null } })),
        // Masked when shown (Body), with the values known then.
        (error: Error) =>
          active && setBodies((b) => ({ ...keepCurrent(b), [key]: { error: error.message } })),
      );
    };
    load('request', requestSize);
    load('response', responseSize);
    return () => {
      active = false;
    };
  }, [send, summary.id, requestSize, responseSize, stale, mode]);
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

  // Real values, whatever's shown: it repeats the request. Fetched afresh, as the body shown may be masked.
  const copyCurl = async (): Promise<void> => {
    if (!detail) return;
    try {
      await copy('curl', await fetchCurlCommand(summary, send));
    } catch {
      setCopied('Copy failed');
      setTimeout(() => setCopied(undefined), 1500);
    }
  };

  const timing = detail?.timing;

  /** Saves a whole body to a file the user picks; not for a stale exchange, whose body is gone. */
  const saveBody = (side: BodySide): (() => Promise<string | undefined>) | undefined =>
    stale
      ? undefined
      : async () => {
          const sideHeaders = side === 'request' ? headers.request : headers.response;
          const contentType = sideHeaders?.find(([n]) => n.toLowerCase() === 'content-type')?.[1];
          const result = await window.wirescry.saveBody({
            exchangeId: summary.id,
            side,
            // From what's shown: a name made from a masked URL.
            name: bodyFileName(urlShown, contentType, side),
          });
          if (!result.name) return undefined;
          return result.decodeError
            ? `Saved ${result.name} as stored: ${result.decodeError}`
            : `Saved ${result.name} (${formatBytes(result.size ?? 0)})`;
        };

  // Query parameters, parsed, when the URL has any.
  let query: Array<[string, string]> = [];
  try {
    query = [...new URL(urlShown).searchParams];
  } catch {
    // Not a URL we can parse; nothing to show.
  }

  // The backend that had a stale exchange's bodies is gone, so it can't format them.
  const formatBody = (side: BodySide): Promise<FormattedBody> =>
    stale
      ? Promise.resolve({ ok: false, reason: 'the proxy that had this body restarted.' })
      : (send({
          command: 'formatBody',
          exchangeId: summary.id,
          side,
          ...(hideSecrets ? { mask: true } : {}),
        }) as Promise<FormattedBody>);
  // A stale exchange's body can't be fetched again masked.
  const unavailable =
    hideSecrets && stale
      ? 'Can’t be checked for secrets: the proxy that had this body restarted.'
      : undefined;

  // The response as it arrived: headers, then body. Compose puts it first, body first.
  const responseHeadersBlock = (
    <>
      {headers.response && (
        <details open>
          <summary>Response headers{byWirescry && ' (sent by Wirescry)'}</summary>
          <HeaderTable headers={headers.response} grpc={summary.grpc} />
        </details>
      )}
    </>
  );
  const responseBodyBlock = (
    <>
      {receiving && responseSize === undefined && (
        <details open>
          <summary>Response body</summary>
          <p className="muted">{receivedText}</p>
        </details>
      )}
      {!!responseSize && (
        <details open>
          <summary>Response body{byWirescry && ' (sent by Wirescry)'}</summary>
          <Body
            state={responseBody}
            info={detail?.responseBody}
            format={() => formatBody('response')}
            onSave={saveBody('response')}
            unavailable={unavailable}
          />
        </details>
      )}
    </>
  );
  // Sent after the body; gRPC puts a call's status here.
  const responseTrailersBlock = (
    <>
      {headers.responseTrailers && headers.responseTrailers.length > 0 && (
        <details open>
          <summary>Response trailers</summary>
          <HeaderTable headers={headers.responseTrailers} grpc={summary.grpc} />
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
        <strong>{shown.method}</strong>
        <span className="detail-url" title={urlShown}>
          {urlShown}
        </span>
        <button type="button" className="icon" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="detail-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => void copy('URL', urlShown)}
          // It would copy what isn't shown.
          disabled={withheld !== undefined}
          title={
            withheld === STALE
              ? 'Can’t be checked for secrets: the proxy restarted'
              : withheld
                ? `${CHECKING_LABEL}…`
                : undefined
          }
        >
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
        {canceled && (
          <p className="note">
            The client canceled the call.
            {shown.failure?.partial &&
              ' The server had started responding; below is what arrived before then.'}
          </p>
        )}
        {shown.failure && !canceled && (
          <div className="failure" role="alert">
            <strong>{shown.failure.message}</strong>
            {shown.failure.detail && <code>{shown.failure.detail}</code>}
            {shown.failure.partial ? (
              <span className="muted">
                The server had started responding. The body below is what arrived before the connection broke.
              </span>
            ) : (
              shown.failure.kind !== 'client-closed' &&
              summary.status !== undefined && (
                <span className="muted">
                  {shown.failure.kind === 'blocked'
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
              {canceled
                ? 'Canceled by the client'
                : summary.grpcDeadlineExceeded && summary.grpcStatus === undefined
                  ? 'Deadline passed'
                  : shown.failure
                    ? `Failed (${shown.failure.code})`
                    : shown.status !== undefined
                      ? receiving
                        ? `${`${shown.status} ${shown.statusMessage ?? ''}`.trim()} (receiving)`
                        : neverFinished
                          ? `${`${shown.status} ${shown.statusMessage ?? ''}`.trim()} (never finished: the proxy restarted)`
                          : `${shown.status} ${shown.statusMessage ?? ''}`
                      : 'Waiting for response'}
            </dd>
            {deadline && (
              <>
                <dt>Deadline</dt>
                <dd title="The client's grpc-timeout: it gives up after this">{deadline}</dd>
              </>
            )}
            {summary.grpcStatus !== undefined && (
              <>
                <dt>gRPC status</dt>
                <dd>
                  {grpcStatusName(summary.grpcStatus)} ({summary.grpcStatus})
                  {shown.grpcMessage ? `: ${shown.grpcMessage}` : ''}
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
                      {redirectShown}
                    </button>
                  ) : (
                    redirectShown
                  )}
                </dd>
              </>
            )}
            {summary.closeCode !== undefined && (
              <>
                <dt>Closed</dt>
                <dd>
                  Code {summary.closeCode}
                  {shown.closeReason ? `: ${shown.closeReason}` : ''}
                </dd>
              </>
            )}
            {detail?.importedFrom && (
              <>
                <dt>Imported from</dt>
                <dd>{detail.importedFrom}</dd>
              </>
            )}
            {shown.handledBy && (
              <>
                <dt>Handled by</dt>
                <dd>Rule “{shown.handledBy.label}”</dd>
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
            <dd>
              {responseSize !== undefined
                ? formatBytes(responseSize)
                : receiving
                  ? `${formatBytes(summary.responseReceived ?? 0)} so far`
                  : '–'}
            </dd>
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
            {hideSecrets && !section.masksSecrets ? (
              <p className="muted">Hidden while View › Hide Secrets is on.</p>
            ) : (
              section.content
            )}
          </details>
        ))}

        {/* Server-Sent Events, as they arrive and after. Not for an exchange from before a restart. */}
        {/* Keyed by the switch too: mounted afresh, so nothing fetched one way is shown the other. */}
        {isEventStream(summary.contentType) && !stale && (
          <SseEventsView
            key={`${summary.id}:${mode}`}
            exchangeId={summary.id}
            responding={summary.responding === true}
            received={summary.responseReceived}
            size={summary.responseSize}
            send={send}
          />
        )}

        {/*
          An old connection's messages can't be fetched; one that was open keeps what it showed. With
          Hide Secrets on, they can't be fetched again masked, so can't be checked.
        */}
        {summary.websocket && stale && hideSecrets && (
          <section className="ws">
            <h2>Messages ({(summary.messageCount ?? 0).toLocaleString()})</h2>
            <p className="note">Can’t be checked for secrets: the proxy that had these messages restarted.</p>
          </section>
        )}
        {summary.websocket && (!stale || detail) && !(stale && hideSecrets) && (
          <WebSocketMessagesView
            key={`${summary.id}:${mode}`}
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
          {headers.request ? (
            <HeaderTable headers={headers.request} grpc={summary.grpc} />
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
              unavailable={unavailable}
            />
          </details>
        )}
        {headers.requestTrailers && headers.requestTrailers.length > 0 && (
          <details open>
            <summary>Request trailers</summary>
            <HeaderTable headers={headers.requestTrailers} grpc={summary.grpc} />
          </details>
        )}
        {!responseFirst && response}
      </div>
    </aside>
  );
}
