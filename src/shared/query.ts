import type { ExchangeSummary } from './api';
import { exchangeType } from './exchange-type';

/**
 * The search box's query language. Terms are separated by spaces and must all match.
 *
 * - A plain word matches anywhere in the method, status, URL, content type or failure.
 * - `field op value` filters one field:
 *   - `=`  equals, case-insensitive, with `*` and `?` wildcards: `host=api.*`, `method=POST`
 *   - `!=` doesn't equal
 *   - `~`  contains: `path~login`
 *   - `>` `>=` `<` `<=` compare numbers: `status>=400`, `size>1mb`, `time>500ms`
 *   - `status=4xx` matches a whole class of statuses
 * - A leading `-` negates any term: `-host=*.google.com`, `-png`.
 * - Double quotes keep spaces together: `"not found"`, `path~"my file"`.
 *
 * A term whose field isn't known (like `page=2` from a URL) is searched as plain text.
 */

type Kind = 'text' | 'number' | 'status' | 'size' | 'time';

interface FieldSpec {
  kind: Kind;
  /** The value(s) to compare; numbers for numeric kinds, strings otherwise. */
  get(e: ExchangeSummary): string | number | undefined | Array<string | undefined>;
}

const FIELDS: Record<string, FieldSpec> = {
  method: { kind: 'text', get: (e) => e.method },
  status: { kind: 'status', get: (e) => e.status },
  host: { kind: 'text', get: (e) => e.host },
  path: { kind: 'text', get: (e) => e.path },
  url: { kind: 'text', get: (e) => e.url },
  type: { kind: 'text', get: (e) => (e.status !== undefined && !e.failure ? exchangeType(e) : undefined) },
  size: { kind: 'size', get: (e) => e.responseSize },
  time: { kind: 'time', get: (e) => e.durationMs },
  protocol: { kind: 'text', get: (e) => e.protocol },
  // The label of the plugin rule (e.g. a Pro mock rule) that handled the request.
  rule: { kind: 'text', get: (e) => e.handledBy?.label },
  // Matches the failure's kind (dns, tls, timeout…) or its code (ENOTFOUND…).
  failure: { kind: 'text', get: (e) => (e.failure ? [e.failure.kind, e.failure.code] : undefined) },
};

const ALIASES: Record<string, string> = {
  code: 'status',
  domain: 'host',
  duration: 'time',
  proto: 'protocol',
  error: 'failure',
};

export const QUERY_FIELDS = Object.keys(FIELDS);

type Op = '=' | '!=' | '~' | '>' | '>=' | '<' | '<=';
const TERM = /^([a-z]+)(>=|<=|!=|=|>|<|~)(.*)$/i;

export interface CompiledQuery {
  matches(e: ExchangeSummary): boolean;
  /** Problems with terms that were dropped, e.g. `status>abc`. */
  errors: string[];
  /** Notes about terms read as plain text that may have been meant as filters. */
  hints: string[];
}

/** Splits on spaces, keeping double-quoted parts together and removing the quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const SIZE_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};
const TIME_UNITS: Record<string, number> = { '': 1, ms: 1, s: 1000, m: 60_000, min: 60_000 };

function parseNumber(value: string, kind: Kind): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
  if (!match) return undefined;
  const units = kind === 'size' ? SIZE_UNITS : kind === 'time' ? TIME_UNITS : { '': 1 };
  const factor = units[match[2]!.toLowerCase()];
  return factor === undefined ? undefined : Number(match[1]) * factor;
}

function compare(actual: number, op: Op, expected: number): boolean {
  switch (op) {
    case '=':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>':
      return actual > expected;
    case '>=':
      return actual >= expected;
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    default:
      return false;
  }
}

type Predicate = (e: ExchangeSummary) => boolean;

/** Builds a predicate for `field op value`, or an error message. */
function fieldPredicate(fieldName: string, spec: FieldSpec, op: Op, value: string): Predicate | string {
  if (value === '') return `${fieldName}${op} needs a value`;

  if (spec.kind === 'text') {
    if (op !== '=' && op !== '!=' && op !== '~')
      return `${fieldName} can't be compared with ${op}; use =, != or ~`;
    const needle = value.toLowerCase();
    const pattern = globToRegExp(value);
    const test = (v: string | undefined): boolean =>
      v !== undefined && (op === '~' ? v.toLowerCase().includes(needle) : pattern.test(v));
    return (e) => {
      const raw = spec.get(e);
      const values = Array.isArray(raw) ? raw : [raw as string | undefined];
      const hit = values.some(test);
      return op === '!=' ? !hit : hit;
    };
  }

  // status=4xx / status!=5xx: a whole class.
  if (spec.kind === 'status' && /^[1-5][0-9x]{2}$/i.test(value) && /x/i.test(value)) {
    if (op !== '=' && op !== '!=') return `use = or != with a status class like ${value}`;
    const pattern = new RegExp(`^${value.replace(/x/gi, '\\d')}$`);
    return (e) => {
      const hit = e.status !== undefined && pattern.test(String(e.status));
      return op === '!=' ? !hit : hit;
    };
  }

  if (op === '~') return `${fieldName} is a number; use =, !=, >, >=, < or <=`;
  const expected = parseNumber(value, spec.kind);
  if (expected === undefined) {
    const example = spec.kind === 'size' ? '10kb or 2mb' : spec.kind === 'time' ? '500ms or 2s' : '404';
    return `"${value}" isn't a valid ${fieldName}; try something like ${example}`;
  }
  return (e) => {
    const actual = spec.get(e);
    return typeof actual === 'number' && compare(actual, op, expected);
  };
}

function textHaystack(e: ExchangeSummary): string {
  return `${e.method} ${e.status ?? ''} ${e.url} ${e.contentType ?? ''} ${
    e.failure ? `${e.failure.code} ${e.failure.kind}` : ''
  }`.toLowerCase();
}

/** Turns the search box's text into a predicate, plus any errors and hints to show. */
export function compileQuery(input: string): CompiledQuery {
  const predicates: Predicate[] = [];
  const errors: string[] = [];
  const hints: string[] = [];

  for (const token of tokenize(input)) {
    const negated = token.startsWith('-') && token.length > 1;
    const term = negated ? token.slice(1) : token;
    let predicate: Predicate | undefined;

    const match = TERM.exec(term);
    if (match) {
      const name = match[1]!.toLowerCase();
      const field = ALIASES[name] ?? name;
      const spec = FIELDS[field];
      if (spec) {
        const result = fieldPredicate(name, spec, match[2] as Op, match[3]!);
        if (typeof result === 'string') {
          errors.push(result);
          continue;
        }
        predicate = result;
      } else if (/^[a-z]+$/i.test(name) && name.length <= 10) {
        hints.push(`No field called "${name}", so "${term}" is searched as text.`);
      }
    }

    if (!predicate) {
      const needle = term.toLowerCase();
      predicate = (e) => textHaystack(e).includes(needle);
    }
    predicates.push(
      negated
        ? (
            (p) => (e: ExchangeSummary) =>
              !p(e)
          )(predicate)
        : predicate,
    );
  }

  return {
    matches: (e) => predicates.every((p) => p(e)),
    errors,
    hints,
  };
}
