import type { ExchangeDetail, ExchangeSummary, Header } from './api';
import { exchangeType } from './exchange-type';
import { grpcClientSideStatus, grpcStatusName } from './grpc';

/**
 * The search box's query language. Terms are separated by spaces and must all match.
 *
 * - A plain word matches anywhere in the method, status, URL, content type, failure, or a gRPC
 *   call's status and message.
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
 *
 * Header terms need the exchange's headers, which summaries don't carry, so the backend matches
 * them (see `matchesDetail` and src/backend/search.ts):
 * - `header~text`: any one header line, `name: value`, contains `text`.
 * - `header.NAME=glob`, `header.NAME!=glob`, `header.NAME~text`: NAME's value. `=*` means present.
 * - `reqheader…` and `resheader…`: the same, on one side only (headers and trailers).
 * HTTP/2 pseudo-headers (`:path` etc.) are left out. Plain words don't search headers.
 */

/** The longest search the box takes; the backend refuses longer ones. */
export const MAX_QUERY_LENGTH = 4096;

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
  protocol: { kind: 'text', get: (e) => protocolsOf(e) },
  // The label of the plugin rule (e.g. a Pro mock rule) that handled the request.
  rule: { kind: 'text', get: (e) => e.handledBy?.label },
  // Matches the failure's kind (dns, tls, timeout…) or its code (ENOTFOUND…).
  failure: { kind: 'text', get: (e) => (e.failure ? [e.failure.kind, e.failure.code] : undefined) },
  // A gRPC call's status, by name or number: grpc=NOT_FOUND, grpc=5.
  grpc: {
    kind: 'text',
    get: (e) => {
      // Without a status from the server, what the client ended with: CANCELLED or DEADLINE_EXCEEDED.
      const status = e.grpcStatus ?? grpcClientSideStatus(e);
      return status !== undefined ? [grpcStatusName(status), String(status)] : undefined;
    },
  },
};

/**
 * The schemes an exchange answers to. A WebSocket is both its own (ws, wss) and HTTP's (http,
 * https), since it starts as an HTTP request: so `protocol=https` finds secure WebSockets too,
 * whether captured (stored as wss) or imported (stored as https, marked websocket).
 */
function protocolsOf(e: ExchangeSummary): string[] {
  const scheme = e.protocol.toLowerCase();
  if (!e.websocket && scheme !== 'ws' && scheme !== 'wss') return [scheme];
  const secure = scheme === 'https' || scheme === 'wss';
  return secure ? ['wss', 'https'] : ['ws', 'http'];
}

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
  /**
   * Whether the summary passes every term that can be checked on it. Header terms can't, and
   * count as passing: they're for `matchesDetail`.
   */
  matches(e: ExchangeSummary): boolean;
  /** True if the query has header terms, so only the backend can tell what matches. */
  needsDetail: boolean;
  /** Every term, header terms included, against an exchange's details. */
  matchesDetail(detail: ExchangeDetail): boolean;
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

/** Whether `piece` (with `?` for any one character) matches `text` at `at`. */
function matchesAt(text: string, at: number, piece: string): boolean {
  if (at < 0 || at + piece.length > text.length) return false;
  for (let i = 0; i < piece.length; i++) {
    if (piece[i] !== '?' && piece[i] !== text[at + i]) return false;
  }
  return true;
}

/** Where `piece` first matches in `text` from `from`, ending by `end`; -1 if nowhere. */
function findPiece(text: string, piece: string, from: number, end: number): number {
  if (!piece.includes('?')) {
    const at = text.indexOf(piece, from);
    return at !== -1 && at + piece.length <= end ? at : -1;
  }
  for (let at = from; at + piece.length <= end; at++) if (matchesAt(text, at, piece)) return at;
  return -1;
}

/**
 * Whether `text` equals `pattern`, where `*` stands for any run of characters and `?` for any
 * one. Both are lowercased by the caller. The pieces between `*`s are found left to right, each
 * at its first place, which is enough for a glob: no backtracking, unlike a regular expression
 * of `.*`s, which can take minutes on a long header value. Header values are matched in the
 * backend, where that would stop the proxy.
 */
export function wildcardMatch(text: string, pattern: string): boolean {
  const pieces = pattern.split('*');
  if (pieces.length === 1) return text.length === pattern.length && matchesAt(text, 0, pattern);
  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  if (text.length < first.length + last.length) return false;
  if (!matchesAt(text, 0, first) || !matchesAt(text, text.length - last.length, last)) return false;
  let pos = first.length;
  const end = text.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    if (piece === '') continue;
    const at = findPiece(text, piece, pos, end);
    if (at === -1) return false;
    pos = at + piece.length;
  }
  return true;
}

/** An exchange's headers, lowercased, without pseudo-headers, by side; trailers included. */
export interface HeaderView {
  request: Header[];
  response: Header[];
}

function lowered(...lists: Array<Header[] | undefined>): Header[] {
  const out: Header[] = [];
  for (const list of lists) {
    for (const [name, value] of list ?? []) {
      // HTTP/2's :method, :path and so on repeat fields the query already has.
      if (name.startsWith(':')) continue;
      out.push([name.toLowerCase(), value.toLowerCase()]);
    }
  }
  return out;
}

export function headerView(detail: ExchangeDetail): HeaderView {
  return {
    request: lowered(detail.requestHeaders, detail.requestTrailers),
    response: lowered(detail.responseHeaders, detail.responseTrailers),
  };
}

type HeaderPredicate = (view: HeaderView) => boolean;

const HEADER_START = /^(req|res)?header(?=[.~=!<>])/i;
const HEADER_NAME = /^[a-z0-9_-]+$/i;
const HEADER_OP = /^(>=|<=|!=|=|>|<|~)/;

/** The longest value a header term takes. */
export const MAX_HEADER_VALUE = 256;

/**
 * Parses a header term (the `-` already taken off): a predicate, an error, or a hint to show
 * while searching it as plain text. Undefined when it isn't a header term after all, such as
 * `header.css` (no operator), which stays plain text as before.
 */
function headerPredicate(term: string): HeaderPredicate | string | { hint: string } | undefined {
  const start = HEADER_START.exec(term);
  if (!start) return undefined;
  const field = start[0].toLowerCase();
  const side = start[1]?.toLowerCase() as 'req' | 'res' | undefined;
  let rest = term.slice(start[0].length);
  let name: string | undefined;
  if (rest.startsWith('.')) {
    const end = rest.slice(1).search(/[=!<>~]/);
    // No operator: `header.css` is a plain word, as it always was.
    if (end === -1) return undefined;
    name = rest.slice(1, end + 1);
    rest = rest.slice(end + 1);
  }
  const opMatch = HEADER_OP.exec(rest);
  if (!opMatch) return undefined;
  const op = opMatch[1] as Op;
  const value = rest.slice(op.length);
  const label = name === undefined ? field : `${field}.${name}`;

  if (name === undefined) {
    if (op !== '~') return `${field}${op} needs a header name: ${field}.NAME=value, or ${field}~text`;
  } else {
    if (name === '') return `${field}.${op} needs a header name: ${field}.NAME=value, or ${field}~text`;
    // Likely part of a URL, like header.php?id=1: searched as text, as it always was.
    if (!HEADER_NAME.test(name))
      return { hint: `"${term}" is searched as text: header names use letters, digits, - and _.` };
  }
  if (op !== '=' && op !== '!=' && op !== '~') return `${label} can't be compared with ${op}; use =, != or ~`;
  if (value === '') return `${label}${op} needs a value`;
  if (value.length > MAX_HEADER_VALUE) return `${label}${op} takes at most ${MAX_HEADER_VALUE} characters`;

  const needle = value.toLowerCase();
  const lowerName = name?.toLowerCase();
  const headersOf = (view: HeaderView): Header[] =>
    side === 'req' ? view.request : side === 'res' ? view.response : [...view.request, ...view.response];

  if (lowerName === undefined) {
    // One line at a time, so a match never spans two headers.
    return (view) => headersOf(view).some(([n, v]) => `${n}: ${v}`.includes(needle));
  }
  const test = (v: string): boolean => (op === '~' ? v.includes(needle) : wildcardMatch(v, needle));
  return (view) => {
    const hit = headersOf(view).some(([n, v]) => n === lowerName && test(v));
    // As for every other field, != is the opposite of =: no such header matches too.
    return op === '!=' ? !hit : hit;
  };
}

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
  } ${
    // Not OK's name: "ok" would then match every successful call.
    e.grpcStatus !== undefined && e.grpcStatus !== 0
      ? `${grpcStatusName(e.grpcStatus)} ${e.grpcMessage ?? ''}`
      : ''
  }`.toLowerCase();
}

/** Turns the search box's text into a predicate, plus any errors and hints to show. */
export function compileQuery(input: string): CompiledQuery {
  const predicates: Predicate[] = [];
  const headerPredicates: HeaderPredicate[] = [];
  const errors: string[] = [];
  const hints: string[] = [];
  const tooLong = input.length > MAX_QUERY_LENGTH;
  let droppedForLength = false;

  for (const token of tokenize(input)) {
    const negated = token.startsWith('-') && token.length > 1;
    const term = negated ? token.slice(1) : token;
    let predicate: Predicate | undefined;

    const header = headerPredicate(term);
    if (typeof header === 'string') {
      errors.push(header);
      continue;
    }
    if (typeof header === 'function') {
      // Too long for the backend: dropped, with an error below.
      if (tooLong) droppedForLength = true;
      else headerPredicates.push(negated ? (view) => !header(view) : header);
      continue;
    }
    if (header) hints.push(header.hint);

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

  if (droppedForLength)
    errors.push(
      `The search is too long for header terms: ${MAX_QUERY_LENGTH.toLocaleString('en-US')} characters at most.`,
    );
  const matches = (e: ExchangeSummary): boolean => predicates.every((p) => p(e));
  return {
    matches,
    needsDetail: headerPredicates.length > 0,
    matchesDetail: (detail) => {
      if (!matches(detail.summary)) return false;
      if (headerPredicates.length === 0) return true;
      const view = headerView(detail);
      return headerPredicates.every((p) => p(view));
    },
    errors,
    hints,
  };
}
