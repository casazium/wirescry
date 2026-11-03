import { useState, type ReactNode } from 'react';
import type { ComposerRequest } from '../../shared/api';
import { MAX_DRAFT_BODY, parseHeaders, type ComposerDraft } from './composer-request';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface Props {
  draft: ComposerDraft;
  onChange(draft: ComposerDraft): void;
  /** Something about how the draft was filled in, e.g. a body that couldn't be copied. */
  note?: string;
  onDismissNote(): void;
  /** Offered with the note, e.g. to bring back a request Edit and resend replaced. */
  onUndo?: () => void;
  /** Read out by screen readers, e.g. when the response arrives. */
  announcement?: string;
  connected: boolean;
  /** Sends it: plugins first, then the backend. Rejects with a message for the user. */
  onSend(request: ComposerRequest): Promise<void>;
  /** Set while the last request sent is waiting for its response. */
  onCancel?: () => void;
  /** The last request sent, in a detail pane. */
  response?: ReactNode;
  /** Plugin panels, e.g. saved requests. */
  panels: ReactNode[];
}

/** The Compose tab: write a request and send it through Wirescry. */
export function ComposerView({
  draft,
  onChange,
  note,
  onDismissNote,
  onUndo,
  announcement,
  connected,
  onSend,
  onCancel,
  response,
  panels,
}: Props): React.JSX.Element {
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const set = (change: Partial<ComposerDraft>): void => onChange({ ...draft, ...change });

  const send = (): void => {
    if (!connected || sending || onCancel) return;
    setError(undefined);
    const url = draft.url.trim();
    if (!/^https?:\/\/[^/?#]/i.test(url)) {
      setError('Enter a full URL, starting with http:// or https://.');
      return;
    }
    const parsed = parseHeaders(draft.headersText);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    if (new TextEncoder().encode(draft.body).length > MAX_DRAFT_BODY) {
      setError(`The body can be at most ${MAX_DRAFT_BODY / 1024} KB.`);
      return;
    }
    setSending(true);
    onSend({
      method: draft.method.trim().toUpperCase() || 'GET',
      url,
      headers: parsed.headers,
      body: draft.body,
    })
      .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
      // A frame later, once the new row is listed and Cancel has taken Send's place.
      .finally(() => requestAnimationFrame(() => setSending(false)));
  };

  return (
    <div className={`composer ${panels.length > 0 ? 'with-panel' : ''}`}>
      {panels.length > 0 && <aside className="composer-panels">{panels}</aside>}
      <div className="composer-main">
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter sends from any field, the headers and body included.
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !onCancel &&
              !sending &&
              connected
            ) {
              event.preventDefault();
              send();
            }
          }}
        >
          <div className="composer-line">
            <label className="visually-hidden" htmlFor="composer-method">
              Method
            </label>
            <input
              id="composer-method"
              className="composer-method"
              list="composer-methods"
              value={draft.method}
              spellCheck={false}
              autoCapitalize="characters"
              onChange={(e) => set({ method: e.target.value })}
            />
            <datalist id="composer-methods">
              {METHODS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <label className="visually-hidden" htmlFor="composer-url">
              URL
            </label>
            <input
              id="composer-url"
              className="composer-url"
              type="text"
              placeholder="https://api.example.com/items"
              value={draft.url}
              spellCheck={false}
              onChange={(e) => set({ url: e.target.value })}
            />
            {/* One button, so focus stays on it as it turns from Send into Cancel and back. */}
            <button
              type={onCancel ? 'button' : 'submit'}
              className={onCancel ? 'secondary' : undefined}
              aria-disabled={!onCancel && (!connected || sending) ? true : undefined}
              onClick={(event) => {
                if (!onCancel) return;
                event.preventDefault();
                onCancel();
              }}
            >
              {onCancel ? 'Cancel' : sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          <label className="composer-field">
            <span>Headers</span>
            <textarea
              rows={5}
              spellCheck={false}
              placeholder={'Accept: application/json\nAuthorization: Bearer …'}
              value={draft.headersText}
              onChange={(e) => set({ headersText: e.target.value })}
            />
          </label>
          <label className="composer-field">
            <span>Body</span>
            <textarea
              rows={7}
              spellCheck={false}
              value={draft.body}
              onChange={(e) => set({ body: e.target.value })}
            />
          </label>
          <p className="muted composer-hint">
            Sent through Wirescry, so it shows in Traffic and rules apply. Host and Content-Length are set for
            you. ⌘/Ctrl+Enter sends.
          </p>
          {note && (
            <p className="note composer-note" role="status">
              {note}{' '}
              {onUndo && (
                <>
                  <button type="button" className="link" onClick={onUndo}>
                    Undo
                  </button>{' '}
                </>
              )}
              <button type="button" className="link" onClick={onDismissNote}>
                OK
              </button>
            </p>
          )}
          <p className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
          {error && (
            <p className="note error" role="alert">
              {error}
            </p>
          )}
        </form>
        <div className="composer-response">
          {response ?? <p className="muted composer-empty">The response shows here after you send.</p>}
        </div>
      </div>
    </div>
  );
}
