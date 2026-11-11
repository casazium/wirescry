import { useEffect, useRef } from 'react';
import { QUERY_FIELDS } from '../../shared/query';

const EXAMPLES: Array<[string, string]> = [
  ['status>=400', 'Errors from the server'],
  ['status=5xx', 'Any 5xx status'],
  ['method=POST', 'POST requests'],
  ['host=api.*', 'Hosts starting with api.'],
  ['path~login', 'Paths containing "login"'],
  ['size>1mb', 'Responses over 1 MB'],
  ['time>500ms', 'Slower than half a second'],
  ['type=json', 'JSON responses'],
  ['failure=dns', 'DNS failures'],
  ['grpc=NOT_FOUND', 'gRPC calls that failed with NOT_FOUND'],
  ['-host=*.google.com', 'Everything except Google hosts'],
];

/**
 * A short guide to the search syntax, with examples that fill in the search box.
 * Takes focus when it opens. Escape or × closes it and gives focus back (`returnFocus`
 * true); a click outside it (except on `toggle`), or Escape with focus elsewhere, just closes it.
 */
export function FilterHelp({
  onPick,
  onClose,
  toggle,
}: {
  onPick(query: string): void;
  onClose(returnFocus: boolean): void;
  /** The button that opens and closes this; clicking it isn't a click outside. */
  toggle: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // The latest callbacks, so the listeners below are added once, when it opens.
  const latest = useRef({ onClose, toggle });
  useEffect(() => {
    latest.current = { onClose, toggle };
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('li button')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // With focus elsewhere (tabbed out of it), close it but let Escape do its usual job there.
      if (!ref.current?.contains(document.activeElement)) return latest.current.onClose(false);
      event.preventDefault();
      event.stopPropagation();
      latest.current.onClose(true);
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || latest.current.toggle.current?.contains(target)) return;
      latest.current.onClose(false);
    };
    // Capture, so Escape doesn't also reach the search box or the traffic list.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  return (
    <div className="filter-help" role="dialog" aria-label="Search syntax" id="filter-help" ref={ref}>
      <div className="filter-help-head">
        <strong>Search and filters</strong>
        <button type="button" className="icon" aria-label="Close" onClick={() => onClose(true)}>
          ×
        </button>
      </div>
      <p>
        Plain words match anywhere. <code>field=value</code> filters one field: <code>=</code> equals (with{' '}
        <code>*</code> wildcards), <code>!=</code> doesn&apos;t, <code>~</code> contains, and{' '}
        <code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code> compare numbers. Start a
        term with <code>-</code> to exclude it. All terms must match.
      </p>
      <ul>
        {EXAMPLES.map(([query, label]) => (
          <li key={query}>
            <button type="button" className="link" onClick={() => onPick(query)}>
              <code>{query}</code>
            </button>{' '}
            <span className="muted">{label}</span>
          </li>
        ))}
      </ul>
      <p className="muted">Fields: {QUERY_FIELDS.join(', ')}. Sizes take kb or mb, times ms or s.</p>
    </div>
  );
}
