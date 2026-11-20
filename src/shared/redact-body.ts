/**
 * Redaction in bodies: by kind (JSON, NDJSON, server-sent events, forms, multipart, XML, HTML,
 * other text), and the known-values matcher, which finds a secret found in one place (a header, a
 * cookie, a URL) wherever else it appears. Best-effort, unlike headers and URLs: no list of shapes
 * or names is complete.
 *
 * Pure, like redact.ts: strings in, spans out. Bodies that aren't text (and text that isn't UTF-8)
 * are the caller's to turn into text, or to record as not scanned.
 *
 * Every scan is linear in the body's length: each rule either anchors its matches at a boundary
 * with bounded lengths, or walks the text once.
 */
import {
  addValue,
  distinctive,
  formSpans,
  mergeSpans,
  nameRule,
  percentDecode,
  recordsOf,
  REDACTED,
  secretName,
  shapeSpans,
  STRONG_FAMILIES,
  urlInTextSpans,
  type Redaction,
  type SecretFamily,
  type Span,
  type ValueSink,
} from './redact';

// ---------------------------------------------------------------- known values

const TOKEN_CHAR = /[A-Za-z0-9_-]/;
const TOKEN_RUN = /[A-Za-z0-9_-]+/g;
/** A run of URL characters with at least one percent escape, for values written encoded. */
// Anchored at a run's start, so a long run with no escape is tried once, not from every character.
const ENCODED_RUN =
  /(?<![A-Za-z0-9_.~!*'()+-])(?:[A-Za-z0-9_.~!*'()+-]|%[0-9A-Fa-f]{2})*%[0-9A-Fa-f]{2}(?:[A-Za-z0-9_.~!*'()+-]|%[0-9A-Fa-f]{2})*/g;

/** At most this many known values, and this many sharing one longest run. */
const MAX_KNOWN = 10_000;
const MAX_PER_RUN = 8;

interface Known {
  value: string;
  /** Where the value's longest run of token characters starts in it. */
  at: number;
}

/** The longest run of `[A-Za-z0-9_-]` in a value, and where it starts. */
function longestRun(value: string): { run: string; at: number } | undefined {
  let best: { run: string; at: number } | undefined;
  for (const match of value.matchAll(TOKEN_RUN)) {
    if (!best || match[0].length > best.run.length) best = { run: match[0], at: match.index };
  }
  return best;
}

/**
 * Secret values found so far, found again wherever they appear: as written, or percent-encoded.
 * Only distinctive values are kept (see `distinctive`), and a match must stand alone, not be part
 * of a longer run of letters and digits.
 *
 * Finding is one pass: each run of token characters in the text is looked up by itself in a map
 * keyed by each value's longest run, then the whole value is checked around it.
 */
export class KnownValues implements ValueSink {
  private readonly byRun = new Map<string, Known[]>();
  private readonly values = new Set<string>();

  get size(): number {
    return this.values.size;
  }

  add(value: string): void {
    if (this.values.size >= MAX_KNOWN || this.values.has(value) || !distinctive(value)) return;
    const longest = longestRun(value);
    // A value of mostly punctuation can't be found by its runs.
    if (!longest || longest.run.length < 4) return;
    const list = this.byRun.get(longest.run);
    // Values sharing a run are checked one by one wherever it appears, so only a few are kept.
    if (list && list.length >= MAX_PER_RUN) return;
    this.values.add(value);
    if (list) list.push({ value, at: longest.at });
    else this.byRun.set(longest.run, [{ value, at: longest.at }]);
  }

  /** Spans of known values in text, as written or percent-encoded. */
  scan(text: string): Span[] {
    if (this.values.size === 0) return [];
    const spans = this.find(text, (i) => i);
    for (const match of text.matchAll(ENCODED_RUN)) {
      const { decoded, rawAt } = decodeWithMap(match[0]);
      for (const span of this.find(decoded, rawAt)) {
        spans.push({ ...span, start: match.index + span.start, end: match.index + span.end });
      }
    }
    return spans;
  }

  /** Spans in `text`, mapped to the caller's positions by `rawAt`. */
  private find(text: string, rawAt: (i: number) => number): Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(TOKEN_RUN)) {
      const candidates = this.byRun.get(match[0]);
      if (!candidates) continue;
      for (const { value, at } of candidates) {
        const start = match.index - at;
        const end = start + value.length;
        if (start < 0 || !text.startsWith(value, start)) continue;
        // Standing alone: not the middle of a longer run.
        if (TOKEN_CHAR.test(value[0]!) && start > 0 && TOKEN_CHAR.test(text[start - 1]!)) continue;
        if (TOKEN_CHAR.test(value.at(-1)!) && end < text.length && TOKEN_CHAR.test(text[end]!)) continue;
        spans.push({ start: rawAt(start), end: rawAt(end), kind: 'known value' });
      }
    }
    return spans;
  }
}

/**
 * Percent escapes decoded, with a map back to the raw text. An index inside a decoded run of
 * escapes maps to the run's edge, so a span may grow to whole escapes, never shrink.
 */
function decodeWithMap(raw: string): { decoded: string; rawAt: (i: number) => number } {
  const decodedStarts: number[] = [];
  const rawStarts: number[] = [];
  let decoded = '';
  let at = 0;
  for (const match of raw.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)) {
    if (match.index > at) {
      decodedStarts.push(decoded.length);
      rawStarts.push(at);
      decoded += raw.slice(at, match.index);
    }
    decodedStarts.push(decoded.length);
    rawStarts.push(match.index);
    decoded += percentDecode(match[0], false);
    at = match.index + match[0].length;
  }
  if (at < raw.length) {
    decodedStarts.push(decoded.length);
    rawStarts.push(at);
    decoded += raw.slice(at);
  }
  decodedStarts.push(decoded.length);
  rawStarts.push(raw.length);
  const rawAt = (i: number): number => {
    // The chunk holding i: the last start at or before it.
    let low = 0;
    let high = decodedStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (decodedStarts[mid]! <= i) low = mid;
      else high = mid - 1;
    }
    const chunkStart = decodedStarts[low]!;
    const chunkRaw = rawStarts[low]!;
    const next = low + 1 < decodedStarts.length ? low + 1 : low;
    const chunkIsEscapes = raw[chunkRaw] === '%';
    if (i === chunkStart) return chunkRaw;
    // Inside a run of escapes: its end, so the span covers the whole run.
    if (chunkIsEscapes) return rawStarts[next]!;
    return chunkRaw + (i - chunkStart);
  };
  return { decoded, rawAt };
}

// ---------------------------------------------------------------- text rules

/** Names whose values the assignment rule redacts in text: the strongest secret names. */
const ASSIGNMENT = /(?<![A-Za-z0-9_])(["']?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1[ \t]{0,4}[:=][ \t]{0,4}/g;
const STOP_WORDS = new Set([
  'null',
  'undefined',
  'true',
  'false',
  'string',
  'number',
  'boolean',
  'required',
  'optional',
  'none',
  'empty',
  'hidden',
  'redacted',
]);
const MAX_VALUE = 4096;

/** The end of a quoted value starting after `open` at `from`, honouring backslashes; -1 if none. */
function closingQuote(text: string, from: number, quote: string): number {
  const limit = Math.min(text.length, from + MAX_VALUE);
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote) return i;
    else if (c === '\n') return -1;
  }
  return -1;
}

/**
 * The assignment rule: a strong secret name (a password's, a secret's or a token's) followed by
 * `=` or `:` and a value, as in logs and config: `password=…`, `api_key: …`, `"token": "…"`. A
 * quoted value runs to its closing quote; an unquoted one to whitespace or `&`, needs 6+
 * characters, none of `( ) { } < > $` (code, not a value), and isn't a word like `null` or
 * `string`.
 */
export function assignmentSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(ASSIGNMENT)) {
    const name = match[2]!;
    const family = secretName(name, 'json');
    if (!family || !STRONG_FAMILIES.has(family)) continue;
    const from = match.index + match[0].length;
    const quote = text[from];
    let start: number;
    let end: number;
    if (quote === '"' || quote === "'") {
      start = from + 1;
      end = closingQuote(text, start, quote);
      if (end <= start) continue;
    } else {
      start = from;
      end = start;
      const limit = Math.min(text.length, start + MAX_VALUE);
      while (end < limit && !/[\s&<>"']/.test(text[end]!)) end++;
      // A sentence's full stop or a list's comma isn't the value's.
      while (end > start && /[.,;]/.test(text[end - 1]!)) end--;
      const value = text.slice(start, end);
      if (value.length < 6 || /[(){}<>$]/.test(value) || STOP_WORDS.has(value.toLowerCase())) continue;
    }
    // Not added to the known values: a rule over free text is too loose a source for them.
    spans.push({ start, end, kind: 'name', name });
  }
  return spans;
}

/** The rules for text: token shapes, URLs, and assignments where they make sense. */
function textSpans(text: string, sink: ValueSink | undefined, assignments: boolean): Span[] {
  const spans = shapeSpans(text, sink);
  for (const span of urlInTextSpans(text, sink)) spans.push(span);
  if (assignments) for (const span of assignmentSpans(text)) spans.push(span);
  return spans;
}

// ---------------------------------------------------------------- JSON

/** JSON nesting deeper than this isn't walked: the body is taken as text. */
const MAX_DEPTH = 512;
/** JSON inside JSON strings (an LLM tool's arguments) is looked into this many levels deep. */
const MAX_JSON_IN_STRING = 3;

/** A JSON string's contents decoded, with a map from a decoded index to the raw text's. */
function decodeJsonString(raw: string): { decoded: string; rawAt: (i: number) => number } | undefined {
  if (!raw.includes('\\')) return { decoded: raw, rawAt: (i) => i };
  const parts: string[] = [];
  const starts: number[] = [];
  const extras: number[] = [];
  let from = 0;
  let length = 0;
  let extra = 0;
  for (let at = raw.indexOf('\\'); at >= 0; at = raw.indexOf('\\', at)) {
    let char: string;
    let width = 2;
    const next = raw[at + 1];
    if (next === 'u') {
      const hex = raw.slice(at + 2, at + 6);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined;
      char = String.fromCharCode(parseInt(hex, 16));
      width = 6;
    } else {
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (next === undefined || !(next in simple)) return undefined;
      char = simple[next]!;
    }
    parts.push(raw.slice(from, at), char);
    length += at - from;
    starts.push(length);
    extra += width - 1;
    extras.push(extra);
    length += 1;
    from = at + width;
    at = from;
  }
  parts.push(raw.slice(from));
  const rawAt = (i: number): number => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (starts[mid]! < i) low = mid + 1;
      else high = mid;
    }
    return i + (low > 0 ? extras[low - 1]! : 0);
  };
  return { decoded: parts.join(''), rawAt };
}

interface Frame {
  kind: 'object' | 'array';
  /** The rule this container's direct values take, if any (its key's, or an array's parent's). */
  inherit?: SecretFamily;
  /** The name that rule came from, for the record. */
  inheritName?: string;
  /** In an object: the key of the value being read. */
  key?: string;
  /** In an object: whether the next token is a key. */
  expectKey: boolean;
}

/** Families whose numbers and booleans are secrets too (a PIN, a card code); tokens' aren't. */
const SCALAR_FAMILIES: ReadonlySet<SecretFamily> = new Set(['password', 'secret']);
/** Families whose short or spaced strings are kept in JSON (a logprob's `"token": "Hello"`). */
const LONG_ONLY_FAMILIES: ReadonlySet<SecretFamily> = new Set(['token', 'session']);

/**
 * Spans in a JSON document, or undefined if it isn't one. Values under secret names are redacted
 * in place (a number becomes `"[redacted]"`); everything else stays byte for byte as it was. Then
 * the text rules and the known values run inside every string, and JSON inside a string is looked
 * into. Walked without building it, and without recursion.
 */
export function jsonSpans(text: string, known?: KnownValues, depth = 0): Span[] | undefined {
  const spans: Span[] = [];
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
      i++;
    }
  };
  /** The family a value at the current position takes, from its key or its container. */
  const familyHere = (): SecretFamily | undefined => {
    const frame = stack.at(-1);
    if (!frame) return undefined;
    if (frame.kind === 'object') {
      const rule = nameRule(frame.key ?? '', 'json');
      if (rule === 'describes') return undefined;
      return rule ?? frame.inherit;
    }
    return frame.inherit;
  };
  /** The name a redaction here is recorded under: its key's, or the one its rule came from. */
  const nameHere = (): string => {
    const frame = stack.at(-1);
    if (!frame) return '';
    const rule = frame.kind === 'object' ? nameRule(frame.key ?? '', 'json') : undefined;
    return rule && rule !== 'describes' ? frame.key! : (frame.inheritName ?? frame.key ?? '');
  };
  /** Ends a string at `i` (on its opening quote); the index after its closing quote, or -1. */
  const stringEnd = (): number => {
    let from = i + 1;
    for (;;) {
      const quote = text.indexOf('"', from);
      if (quote < 0) return -1;
      let slashes = 0;
      while (text.charCodeAt(quote - 1 - slashes) === 0x5c) slashes++;
      from = quote + 1;
      if (slashes % 2 === 0) return from;
    }
  };
  /** Redaction for a string value at [start, end) (inside its quotes). */
  const stringValue = (start: number, end: number, family: SecretFamily | undefined): boolean => {
    const raw = text.slice(start, end);
    const unescaped = decodeJsonString(raw);
    if (!unescaped) return false;
    const { decoded, rawAt } = unescaped;
    if (family && decoded !== '') {
      const longEnough = !LONG_ONLY_FAMILIES.has(family) || (decoded.length >= 8 && !/\s/.test(decoded));
      if (longEnough) {
        spans.push({ start, end, kind: 'name', name: nameHere() });
        if (known && STRONG_FAMILIES.has(family)) addValue(known, decoded);
        return true;
      }
    }
    let inner: Span[] | undefined;
    if (depth < MAX_JSON_IN_STRING && /^\s*[[{]/.test(decoded)) inner = jsonSpans(decoded, known, depth + 1);
    inner ??= textSpans(decoded, known, true);
    if (known) for (const span of known.scan(decoded)) inner.push(span);
    for (const span of mergeSpans(inner)) {
      spans.push({
        ...span,
        start: start + rawAt(span.start),
        end: start + rawAt(span.end),
        // A number's replacement is quoted; inside a string, the quotes are escaped.
        ...(span.replacement ? { replacement: JSON.stringify(span.replacement).slice(1, -1) } : {}),
      });
    }
    return true;
  };

  ws();
  if (i >= n) return undefined;
  let needValue = true;
  for (;;) {
    ws();
    if (i >= n) break;
    const frame = stack.at(-1);
    const c = text[i]!;
    if (frame?.kind === 'object' && frame.expectKey) {
      if (c === '}' && frame.key === undefined) {
        stack.pop();
        i++;
        needValue = false;
      } else {
        if (c !== '"') return undefined;
        const end = stringEnd();
        if (end < 0) return undefined;
        const key = decodeJsonString(text.slice(i + 1, end - 1))?.decoded;
        if (key === undefined) return undefined;
        frame.key = key;
        i = end;
        ws();
        if (text[i] !== ':') return undefined;
        i++;
        frame.expectKey = false;
        needValue = true;
        continue;
      }
    } else if (needValue) {
      const family = familyHere();
      if (c === '{' || c === '[') {
        if (stack.length >= MAX_DEPTH) return undefined;
        // An object under a secret name gives its direct values that name's rule; an array, its
        // items. Deeper containers judge by their own keys.
        const own = frame?.kind === 'object' ? nameRule(frame.key ?? '', 'json') : undefined;
        const inherit = c === '[' ? family : own && own !== 'describes' ? own : undefined;
        const inheritName = inherit ? nameHere() : undefined;
        stack.push(
          c === '{'
            ? { kind: 'object', inherit, inheritName, expectKey: true }
            : { kind: 'array', inherit, inheritName, expectKey: false },
        );
        i++;
        ws();
        if (c === '[' && text[i] === ']') {
          stack.pop();
          i++;
          needValue = false;
        } else {
          needValue = c === '[';
        }
        continue;
      }
      if (c === '"') {
        const end = stringEnd();
        if (end < 0) return undefined;
        if (!stringValue(i + 1, end - 1, family)) return undefined;
        i = end;
      } else {
        const scalar = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
          text.slice(i, i + 400),
        );
        if (!scalar) return undefined;
        if (family && SCALAR_FAMILIES.has(family) && scalar[0] !== 'null') {
          spans.push({
            start: i,
            end: i + scalar[0].length,
            kind: 'name',
            name: nameHere(),
            replacement: `"${REDACTED}"`,
          });
        }
        i += scalar[0].length;
      }
      needValue = false;
    } else {
      // After a value: a comma, or the container's end.
      if (!frame) return undefined;
      if (c === ',') {
        i++;
        if (frame.kind === 'object') {
          frame.expectKey = true;
          frame.key = undefined;
          ws();
          if (text[i] !== '"') return undefined;
        } else {
          needValue = true;
        }
        continue;
      }
      if ((c === '}' && frame.kind === 'object') || (c === ']' && frame.kind === 'array')) {
        stack.pop();
        i++;
        continue;
      }
      return undefined;
    }
    if (stack.length === 0 && !needValue) {
      ws();
      return i >= n ? spans : undefined;
    }
  }
  return stack.length === 0 && !needValue ? spans : undefined;
}

// ---------------------------------------------------------------- tags (XML and HTML)

const TAG = /<([A-Za-z][\w:.-]{0,63})([^<>]{0,4096})>/g;
const ATTRIBUTE =
  /([A-Za-z_:][\w:.-]{0,63})\s*=\s*(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^\s"'<>`=]{1,4096}))/g;

interface Attribute {
  name: string;
  value: string;
  start: number;
  end: number;
}

function attributesOf(tag: string, offset: number): Attribute[] {
  const out: Attribute[] = [];
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const group = match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
    const value = match[group]!;
    const quoted = group !== 4;
    const start = offset + match.index + match[0].length - value.length - (quoted ? 1 : 0);
    out.push({ name: match[1]!, value, start, end: start + value.length });
  }
  return out;
}

/** Local name of a qualified one: `wsse:Password` → `Password`. */
const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

/**
 * Secrets in tags' attributes: an attribute with a secret name (`password="…"`), and a value
 * named by another attribute, as HTML forms and meta tags and .NET config write them:
 * `<input name="csrf_token" value="…">`, `<meta name="csrf-token" content="…">`,
 * `<add key="password" value="…"/>`.
 */
export function tagSpans(text: string, sink?: ValueSink): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(TAG)) {
    const attributes = attributesOf(match[2]!, match.index + 1 + match[1]!.length);
    const named = attributes.find((a) => /^(?:name|key|property)$/i.test(a.name));
    const namedFamily = named ? secretName(named.value, 'form') : undefined;
    for (const attribute of attributes) {
      if (attribute.value === '') continue;
      const own = secretName(localName(attribute.name), 'json');
      const byName = namedFamily && /^(?:value|content)$/i.test(attribute.name);
      if (!own && !byName) continue;
      spans.push({
        start: attribute.start,
        end: attribute.end,
        kind: 'name',
        name: byName ? named!.value : attribute.name,
      });
      const family = byName ? namedFamily : own;
      if (sink && family && STRONG_FAMILIES.has(family)) addValue(sink, attribute.value);
    }
  }
  return spans;
}

const ELEMENT_OPEN = /<([A-Za-z][\w:.-]{0,63})(?:\s[^<>]{0,4096})?>/g;

/** XML elements with secret names, their text redacted: `<Password>…</Password>`. */
export function xmlElementSpans(text: string, sink?: ValueSink): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(ELEMENT_OPEN)) {
    const name = match[1]!;
    const family = secretName(localName(name), 'json');
    if (!family) continue;
    const start = match.index + match[0].length;
    const close = text.indexOf('<', start);
    if (close < 0 || close - start > MAX_VALUE || !text.startsWith(`</${name}`, close)) continue;
    if (close === start) continue;
    spans.push({ start, end: close, kind: 'name', name: localName(name) });
    if (sink && STRONG_FAMILIES.has(family)) addValue(sink, text.slice(start, close).trim());
  }
  return spans;
}

/** Where `<script>` and `<style>` elements' contents are, in which assignments are code. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lower = text.toLowerCase();
  const pattern = /<(script|style)\b[^<>]{0,4096}>/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + match[0].length;
    const close = lower.indexOf(`</${match[1]!.toLowerCase()}`, start);
    const end = close < 0 ? text.length : close;
    ranges.push([start, end]);
    // On from the element's end: an unclosed one runs to the end, and is searched once.
    pattern.lastIndex = end;
  }
  return ranges;
}

// ---------------------------------------------------------------- bodies

/** What kind of body a media type names, for the rules it gets. */
export type BodyKind =
  'json' | 'ndjson' | 'sse' | 'form' | 'multipart' | 'xml' | 'html' | 'code' | 'text' | 'opaque';

/** The kind of a body with this media type (the `Content-Type` header's value). */
export function bodyKind(mediaType: string | undefined): BodyKind {
  const type = (mediaType ?? '').split(';')[0]!.trim().toLowerCase();
  if (
    type === 'application/x-ndjson' ||
    type === 'application/jsonl' ||
    type === 'application/json-seq' ||
    type === 'application/x-jsonlines'
  )
    return 'ndjson';
  if (type === 'application/json' || type.endsWith('+json') || type === 'text/json') return 'json';
  if (type === 'text/event-stream') return 'sse';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if (type.startsWith('multipart/')) return 'multipart';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.endsWith('/xml') || type.endsWith('+xml')) return 'xml';
  if (/javascript|ecmascript|^text\/css$|sourcemap|\/wasm/.test(type)) return 'code';
  if (type === 'application/grpc-web-text' || type.startsWith('application/grpc')) return 'opaque';
  return 'text';
}

/** A body's redactions. */
export interface BodyRedaction {
  spans: Span[];
  records: Redaction[];
  /** Why it wasn't scanned, if it wasn't (wholly or in part). */
  notScanned?: string;
}

/** The boundary a multipart media type names. */
function boundaryOf(mediaType: string | undefined): string | undefined {
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(mediaType ?? '');
  return match ? (match[1] ?? match[2]) : undefined;
}

/** Spans in a multipart body, part by part. */
function multipartSpans(
  text: string,
  mediaType: string | undefined,
  known: KnownValues | undefined,
  notScanned: string[],
): Span[] {
  const boundary = boundaryOf(mediaType);
  if (!boundary) return textSpans(text, known, true);
  const spans: Span[] = [];
  const delimiter = `--${boundary}`;
  let at = text.indexOf(delimiter);
  while (at >= 0) {
    const headersStart = at + delimiter.length;
    if (text.startsWith('--', headersStart)) break;
    const next = text.indexOf(delimiter, headersStart);
    const partEnd = next < 0 ? text.length : next;
    const crlf = text.indexOf('\r\n\r\n', headersStart);
    const lf = text.indexOf('\n\n', headersStart);
    const blank = crlf >= 0 && crlf < partEnd ? crlf + 4 : lf >= 0 && lf < partEnd ? lf + 2 : -1;
    if (blank < 0) break;
    const headers = text.slice(headersStart, blank);
    let bodyEnd = partEnd;
    if (text.slice(bodyEnd - 2, bodyEnd) === '\r\n') bodyEnd -= 2;
    else if (text[bodyEnd - 1] === '\n') bodyEnd -= 1;
    const name = /name="([^"]{0,256})"/i.exec(headers)?.[1];
    const isFile = /filename\*?=/i.test(headers);
    const partType = /^content-type:\s*([^\r\n]{1,256})/im.exec(headers)?.[1];
    if (bodyEnd > blank) {
      const family = name !== undefined && !isFile ? secretName(name, 'form') : undefined;
      if (family) {
        spans.push({ start: blank, end: bodyEnd, kind: 'name', name });
        if (known && STRONG_FAMILIES.has(family)) addValue(known, text.slice(blank, bodyEnd));
      } else if (isFile && partType && !/^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(partType)) {
        notScanned.push('a file part that isn’t text');
      } else {
        const inner = kindSpans(text.slice(blank, bodyEnd), partType ?? 'text/plain', known, notScanned);
        for (const span of inner) spans.push({ ...span, start: blank + span.start, end: blank + span.end });
      }
    }
    at = next;
  }
  return spans;
}

/** Spans of each line, JSON lines as JSON and the rest as text: for NDJSON and event streams. */
function lineSpans(text: string, known: KnownValues | undefined, valueOf: (line: string) => number): Span[] {
  const spans: Span[] = [];
  let at = 0;
  while (at <= text.length) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end).replace(/\r$/, '');
    const from = valueOf(line);
    const value = from >= 0 ? line.slice(from) : '';
    const json = from >= 0 && /^\s*[[{]/.test(value) ? jsonSpans(value, known) : undefined;
    const inLine = json
      ? json.map((s) => ({ ...s, start: s.start + from, end: s.end + from }))
      : textSpans(line, known, true);
    for (const span of inLine) spans.push({ ...span, start: at + span.start, end: at + span.end });
    at = end + 1;
  }
  return spans;
}

/** Spans by the rules for a body's kind, before known values. */
function kindSpans(
  text: string,
  mediaType: string | undefined,
  known: KnownValues | undefined,
  notScanned: string[],
): Span[] {
  const kind = bodyKind(mediaType);
  switch (kind) {
    case 'json':
      return jsonSpans(text, known) ?? textSpans(text, known, true);
    case 'ndjson':
      return lineSpans(text, known, () => 0);
    case 'sse':
      // `data:` lines' values, with the one space after the colon left out.
      return lineSpans(text, known, (line) => (line.startsWith('data:') ? (line[5] === ' ' ? 6 : 5) : -1));
    case 'form': {
      const spans = formSpans(text, known);
      for (const span of shapeSpans(text, known)) spans.push(span);
      return spans;
    }
    case 'multipart':
      return multipartSpans(text, mediaType, known, notScanned);
    case 'xml': {
      const spans = textSpans(text, known, true);
      for (const span of xmlElementSpans(text, known)) spans.push(span);
      for (const span of tagSpans(text, known)) spans.push(span);
      return spans;
    }
    case 'html': {
      const code = codeRanges(text);
      // The ranges are in order and don't overlap: the last one starting at or before the span.
      const inCode = (span: Span): boolean => {
        let low = 0;
        let high = code.length - 1;
        let found = -1;
        while (low <= high) {
          const mid = (low + high) >> 1;
          if (code[mid]![0] <= span.start) {
            found = mid;
            low = mid + 1;
          } else high = mid - 1;
        }
        return found >= 0 && span.end <= code[found]![1];
      };
      const spans = textSpans(text, known, false);
      for (const span of assignmentSpans(text)) if (!inCode(span)) spans.push(span);
      for (const span of tagSpans(text, known)) spans.push(span);
      return spans;
    }
    case 'code':
      return textSpans(text, known, false);
    case 'opaque':
      notScanned.push('an encoded body');
      return [];
    default: {
      // Text that is JSON, sent without saying so.
      if (/^\s*[[{]/.test(text)) {
        const json = jsonSpans(text, known);
        if (json) return json;
      }
      return textSpans(text, known, true);
    }
  }
}

/**
 * A text body's redactions, by its media type. Values found by name are added to `known`, and
 * every known value found in the body is redacted too, before or after where it was learned.
 */
export function redactBody(text: string, mediaType: string | undefined, known?: KnownValues): BodyRedaction {
  const notScanned: string[] = [];
  // Collected first, so a value found late in the body is also found earlier in it.
  if (known) kindSpans(text, mediaType, known, []);
  const spans = kindSpans(text, mediaType, known, notScanned);
  // Known values: in JSON, the walk looked in its strings; elsewhere, anywhere in the text.
  if (known && !['json', 'ndjson', 'sse'].includes(bodyKind(mediaType))) {
    for (const span of known.scan(text)) spans.push(span);
  }
  const merged = mergeSpans(spans);
  return {
    spans: merged,
    records: recordsOf(merged),
    ...(notScanned.length > 0 ? { notScanned: [...new Set(notScanned)].join('; ') } : {}),
  };
}
