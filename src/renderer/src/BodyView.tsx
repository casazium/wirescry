import { useEffect, useMemo, useState } from 'react';
import type { BodyContent, FormattedBody } from '../../shared/api';
import { exchangeType } from '../../shared/exchange-type';
import { base64ToBytes, bytesToText, formatBytes, hexDump } from './bytes';

type Kind = 'json' | 'image' | 'code' | 'text' | 'binary';
type Mode = 'formatted' | 'text' | 'hex';

function kindOf(contentType: string | undefined, text: string | undefined): Kind {
  const type = exchangeType({ contentType: contentType?.split(';')[0]?.trim().toLowerCase(), path: '' });
  if (type === 'image') return 'image';
  if (text === undefined) return 'binary';
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

/** Asks the backend to pretty-print the body once the Formatted view is shown. */
function FormattedCode({
  format,
  text,
}: {
  format: () => Promise<FormattedBody>;
  text: string;
}): React.JSX.Element {
  const [result, setResult] = useState<FormattedBody>();
  useEffect(() => {
    let active = true;
    format().then(
      (value) => active && setResult(value),
      (error: Error) => active && setResult({ ok: false, reason: error.message }),
    );
    return () => {
      active = false;
    };
  }, [format]);

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

/** Shows a body formatted for its type, as text, or as hex. */
export function BodyView({
  content,
  format,
}: {
  content: BodyContent;
  format: () => Promise<FormattedBody>;
}): React.JSX.Element {
  const bytes = useMemo(() => base64ToBytes(content.base64), [content.base64]);
  const text = useMemo(() => bytesToText(bytes), [bytes]);
  const kind = kindOf(content.contentType, text);
  const pretty = useMemo(() => (kind === 'json' && text ? prettyJson(text) : undefined), [kind, text]);
  const imageUrl = useMemo(() => {
    if (kind !== 'image') return undefined;
    const type = (content.contentType ?? 'image/png').split(';')[0]!.trim();
    return `data:${type};base64,${content.base64}`;
  }, [kind, content]);
  // The parent passes a new function on each render; keep the first so formatting runs once.
  const [formatOnce] = useState(() => format);

  const modes: Mode[] = [];
  if (pretty !== undefined || imageUrl || kind === 'code') modes.push('formatted');
  if (text !== undefined) modes.push('text');
  modes.push('hex');
  const [chosen, setMode] = useState<Mode>();
  const mode = chosen && modes.includes(chosen) ? chosen : modes[0]!;

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
        {modes.length > 1 &&
          modes.map((m) => (
            <button
              key={m}
              type="button"
              className={`tab ${m === mode ? 'active' : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'formatted' ? (kind === 'image' ? 'Image' : 'Formatted') : m === 'text' ? 'Text' : 'Hex'}
            </button>
          ))}
      </div>
      {content.decodeError && <div className="note error">{content.decodeError}</div>}
      {content.truncated && <div className="note">Showing the first {formatBytes(bytes.length)}.</div>}
      {mode === 'formatted' && imageUrl && <img className="body-image" src={imageUrl} alt="Response body" />}
      {mode === 'formatted' && pretty !== undefined && <pre className="code">{pretty}</pre>}
      {mode === 'formatted' && kind === 'code' && text !== undefined && (
        <FormattedCode format={formatOnce} text={text} />
      )}
      {mode === 'text' && <pre className="code">{text}</pre>}
      {mode === 'hex' && <pre className="code hex">{hexDump(bytes)}</pre>}
    </div>
  );
}
