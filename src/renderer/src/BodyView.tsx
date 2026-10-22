import { useMemo, useState } from 'react';
import type { BodyContent } from '../../shared/api';
import { base64ToBytes, bytesToText, formatBytes, hexDump } from './bytes';

type Kind = 'json' | 'image' | 'text' | 'binary';
type Mode = 'formatted' | 'text' | 'hex';

const TEXT_TYPES = /^(text\/|application\/(.*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql))/;

function kindOf(contentType: string | undefined, text: string | undefined): Kind {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (text === undefined) return 'binary';
  if (type.endsWith('json') || type.endsWith('+json')) return 'json';
  if (TEXT_TYPES.test(type) || text !== undefined) return 'text';
  return 'binary';
}

function prettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

/** Shows a body formatted for its type, as text, or as hex. */
export function BodyView({ content }: { content: BodyContent }): React.JSX.Element {
  const bytes = useMemo(() => base64ToBytes(content.base64), [content.base64]);
  const text = useMemo(() => bytesToText(bytes), [bytes]);
  const kind = kindOf(content.contentType, text);
  const pretty = useMemo(() => (kind === 'json' && text ? prettyJson(text) : undefined), [kind, text]);
  const imageUrl = useMemo(() => {
    if (kind !== 'image') return undefined;
    const type = (content.contentType ?? 'image/png').split(';')[0]!.trim();
    return `data:${type};base64,${content.base64}`;
  }, [kind, content]);

  const modes: Mode[] = [];
  if (pretty !== undefined || imageUrl) modes.push('formatted');
  if (text !== undefined) modes.push('text');
  modes.push('hex');
  const [chosen, setMode] = useState<Mode>();
  const mode = chosen && modes.includes(chosen) ? chosen : modes[0]!;

  return (
    <div className="body-view">
      <div className="body-meta">
        <span>{content.contentType ?? 'No content type'}</span>
        <span>
          {formatBytes(content.size)}
          {content.encoding && content.decodedSize !== undefined
            ? ` ${content.encoding}, ${formatBytes(content.decodedSize)} decoded`
            : ''}
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
      {mode === 'text' && <pre className="code">{text}</pre>}
      {mode === 'hex' && <pre className="code hex">{hexDump(bytes)}</pre>}
    </div>
  );
}
