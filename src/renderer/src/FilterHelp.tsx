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
  ['-host=*.google.com', 'Everything except Google hosts'],
];

/** A short guide to the search syntax, with examples that fill in the search box. */
export function FilterHelp({
  onPick,
  onClose,
}: {
  onPick(query: string): void;
  onClose(): void;
}): React.JSX.Element {
  return (
    <div className="filter-help" role="dialog" aria-label="Search syntax">
      <div className="filter-help-head">
        <strong>Search and filters</strong>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
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
