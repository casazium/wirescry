import { useEffect, useMemo, useState } from 'react';
import type { BodyContent, FormattedBody } from '../../shared/api';
import { exchangeType } from '../../shared/exchange-type';
import { base64ToBytes, bytesToText, formatBytes, hexDump } from './bytes';
import { fieldsText, formFields, type FormField } from '../../shared/form-fields';

type Kind = 'json' | 'image' | 'code' | 'form' | 'text' | 'binary';
type Mode = 'formatted' | 'text' | 'hex';

function kindOf(contentType: string | undefined, text: string | undefined): Kind {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
  const type = exchangeType({ contentType: mediaType, path: '' });
  if (type === 'image') return 'image';
  if (text === undefined) return 'binary';
  // Some clients send JSON or XML labeled as a form: shown as what it is, not as one mangled field.
  if (mediaType === 'application/x-www-form-urlencoded')
    return /^\s*[[{]/.test(text) ? 'json' : /^\s*</.test(text) ? 'text' : 'form';
  if (type === 'json') return 'json';
  if (type === 'html' || type === 'xml' || type === 'js' || type === 'css') return 'code';
  return 'text';
}

function prettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

/** Rows shown at most: a form of many thousands would hold up the window. Copy copies all. */
const MAX_FIELD_ROWS = 1000;

function FormFields({ fields }: { fields: FormField[] }): React.JSX.Element {
  if (fields.length === 0) return <p className="muted">No fields.</p>;
  const hidden = fields.length - MAX_FIELD_ROWS;
  return (
    <div className="form-fields">
      {fields.some((field) => field.asWritten) && (
        <p className="note">Some fields aren&apos;t UTF-8, so they&apos;re shown as written.</p>
      )}
      <table className="headers" aria-label="Form fields">
        <tbody>
          {fields.slice(0, MAX_FIELD_ROWS).map(({ name, value }, i) => (
            <tr key={i}>
              <th scope="row">{name}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <p className="muted">
          And {hidden.toLocaleString()} more {hidden === 1 ? 'field' : 'fields'}. Copy copies them all.
        </p>
      )}
    </div>
  );
}

/** Asks the backend to pretty-print the body once the Formatted view is shown. */
function FormattedCode({
  format,
  text,
  onFormatted,
}: {
  format: () => Promise<FormattedBody>;
  text: string;
  /** Called with the formatted text, so Copy can copy what's shown. */
  onFormatted(text: string | undefined): void;
}): React.JSX.Element {
  const [result, setResult] = useState<FormattedBody>();
  useEffect(() => {
    let active = true;
    format().then(
      (value) => {
        if (!active) return;
        setResult(value);
        onFormatted(value.ok ? value.text : undefined);
      },
      (error: Error) => active && setResult({ ok: false, reason: error.message }),
    );
    return () => {
      active = false;
    };
  }, [format, onFormatted]);

  if (!result) return <p className="muted">Formatting…</p>;
  if (!result.ok) {
    return (
      <>
        <p className="note">Not formatted: {result.reason}</p>
        <pre className="code">{text}</pre>
      </>
    );
  }
  return (
    <pre className="code" data-language={result.language}>
      {result.text}
    </pre>
  );
}

/** Shows a body formatted for its type, as text, or as hex, with Copy and Save. */
export function BodyView({
  content,
  format,
  onSave,
}: {
  content: BodyContent;
  format: () => Promise<FormattedBody>;
  /** Saves the whole body to a file; resolves with what to tell the user. Absent when it can't be saved. */
  onSave?: () => Promise<string | undefined>;
}): React.JSX.Element {
  const [status, setStatus] = useState<string>();
  // Code the backend formatted, once it has.
  const [formattedCode, setFormattedCode] = useState<string>();
  const say = (text: string | undefined): void => {
    setStatus(text);
    if (text) setTimeout(() => setStatus((current) => (current === text ? undefined : current)), 4000);
  };
  const bytes = useMemo(() => base64ToBytes(content.base64), [content.base64]);
  const text = useMemo(() => bytesToText(bytes), [bytes]);
  const kind = kindOf(content.contentType, text);
  const pretty = useMemo(() => (kind === 'json' && text ? prettyJson(text) : undefined), [kind, text]);
  const fields = useMemo(
    () => (kind === 'form' && text !== undefined ? formFields(text) : undefined),
    [kind, text],
  );
  const imageUrl = useMemo(() => {
    if (kind !== 'image') return undefined;
    const type = (content.contentType ?? 'image/png').split(';')[0]!.trim();
    return `data:${type};base64,${content.base64}`;
  }, [kind, content]);
  // The parent passes a new function on each render; keep the first so formatting runs once.
  const [formatOnce] = useState(() => format);

  const modes: Mode[] = [];
  if (pretty !== undefined || imageUrl || kind === 'code' || fields) modes.push('formatted');
  if (text !== undefined) modes.push('text');
  modes.push('hex');
  const [chosen, setMode] = useState<Mode>();
  const mode = chosen && modes.includes(chosen) ? chosen : modes[0]!;

  // What Copy puts on the clipboard: what's shown, as text (the hex dump is made on click).
  const canCopy = mode === 'hex' || (text !== undefined && !(mode === 'formatted' && imageUrl !== undefined));
  const copy = async (): Promise<void> => {
    const copyText =
      mode === 'hex'
        ? hexDump(bytes)
        : mode === 'formatted'
          ? fields
            ? fieldsText(fields)
            : (pretty ?? (kind === 'code' ? (formattedCode ?? text) : text))
          : text;
    if (copyText === undefined) return;
    try {
      await navigator.clipboard.writeText(copyText);
      say(content.truncated ? `Copied the first ${formatBytes(bytes.length)}` : 'Copied');
    } catch {
      say('Copy failed');
    }
  };
  const save = async (): Promise<void> => {
    if (!onSave) return;
    try {
      say(await onSave());
    } catch (error) {
      say(`Couldn't save: ${(error as Error).message}`);
    }
  };

  let decoded = '';
  if (content.encoding && content.decodedSize !== undefined) {
    decoded = ` ${content.encoding}, ${formatBytes(content.decodedSize)} decoded`;
  } else if (content.encoding && !content.decodeError) {
    decoded = ` ${content.encoding}`;
  }

  return (
    <div className="body-view">
      <div className="body-meta">
        <span>{content.contentType ?? 'No content type'}</span>
        <span>
          {formatBytes(content.size)}
          {decoded}
        </span>
        <span className="spacer" />
        {status && (
          <span className="muted" role="status">
            {status}
          </span>
        )}
        <button type="button" className="secondary small" disabled={!canCopy} onClick={() => void copy()}>
          Copy
        </button>
        {onSave && (
          <button type="button" className="secondary small" onClick={() => void save()}>
            Save…
          </button>
        )}
        {modes.length > 1 &&
          modes.map((m) => (
            <button
              key={m}
              type="button"
              className={`tab ${m === mode ? 'active' : ''}`}
              aria-pressed={m === mode}
              onClick={() => setMode(m)}
            >
              {m === 'formatted'
                ? kind === 'image'
                  ? 'Image'
                  : kind === 'form'
                    ? 'Fields'
                    : 'Formatted'
                : m === 'text'
                  ? 'Text'
                  : 'Hex'}
            </button>
          ))}
      </div>
      {content.decodeError && <div className="note error">{content.decodeError}</div>}
      {content.truncated && <div className="note">Showing the first {formatBytes(bytes.length)}.</div>}
      {mode === 'formatted' && imageUrl && <img className="body-image" src={imageUrl} alt="Response body" />}
      {mode === 'formatted' && pretty !== undefined && <pre className="code">{pretty}</pre>}
      {mode === 'formatted' && fields && <FormFields fields={fields} />}
      {mode === 'formatted' && kind === 'code' && text !== undefined && (
        <FormattedCode format={formatOnce} text={text} onFormatted={setFormattedCode} />
      )}
      {mode === 'text' && <pre className="code">{text}</pre>}
      {mode === 'hex' && <pre className="code hex">{hexDump(bytes)}</pre>}
    </div>
  );
}
