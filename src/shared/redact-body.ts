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
  redactHeader,
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
/**
 * A run of characters that can't end a value written in a URL or form (no space, quote or angle
 * bracket), anchored at its start so each is read once. Runs holding a `%` (or, in a form, a `+`)
 * are decoded and searched again.
 */
const ENCODED_RUN = /(?<![^\s"'<>])[^\s"'<>]+/g;

/** At most this many known values, and this many sharing one longest run. */
const MAX_KNOWN = 10_000;
const MAX_PER_RUN = 8;
/**
 * A value much longer than its longest run (`abcd.abcd.abcd…`) would be checked at length
 * wherever that short run appears: such values aren't kept.
 */
const MAX_LENGTH_PER_RUN = 32;

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
  /** Whether a value was turned away for want of room, so a later secret may not be found. */
  full = false;

  get size(): number {
    return this.values.size;
  }

  add(value: string): void {
    if (this.values.has(value) || !distinctive(value)) return;
    const longest = longestRun(value);
    // A value of mostly punctuation can't be found by its runs.
    if (!longest || longest.run.length < 4 || value.length > longest.run.length * MAX_LENGTH_PER_RUN) return;
    const list = this.byRun.get(longest.run);
    // Values sharing a run are checked one by one wherever it appears, so only a few are kept.
    if (this.values.size >= MAX_KNOWN || (list && list.length >= MAX_PER_RUN)) {
      this.full = true;
      return;
    }
    this.values.add(value);
    if (list) list.push({ value, at: longest.at });
    else this.byRun.set(longest.run, [{ value, at: longest.at }]);
  }

  /**
   * Spans of known values in text, as written or percent-encoded (and, in a form, with `+` for a
   * space).
   */
  scan(text: string, plusIsSpace = false): Span[] {
    if (this.values.size === 0 || text.length < 8) return [];
    const spans = this.find(text, (i) => i);
    for (const match of text.matchAll(ENCODED_RUN)) {
      const run = match[0];
      if (!run.includes('%') && !(plusIsSpace && run.includes('+'))) continue;
      const { decoded, rawAt } = decodeWithMap(run, plusIsSpace);
      for (const span of this.find(decoded, rawAt)) {
        spans.push({ ...span, start: match.index + span.start, end: match.index + span.end });
      }
    }
    return spans;
  }

  /** Spans in `text`, mapped to the caller's positions by `rawAt` (rounding a start down, an end up). */
  private find(text: string, rawAt: (i: number, up: boolean) => number): Span[] {
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
        spans.push({ start: rawAt(start, false), end: rawAt(end, true), kind: 'known value' });
      }
    }
    return spans;
  }
}

/**
 * Percent escapes decoded (and `+` as a space, if asked), with a map back to the raw text. An
 * index inside a decoded run of escapes maps to the run's start for a span's start and to its end
 * for a span's end, so a span may grow to whole escapes, never shrink.
 */
function decodeWithMap(
  raw: string,
  plusIsSpace = false,
): { decoded: string; rawAt: (i: number, up: boolean) => number } {
  const decodedStarts: number[] = [];
  const rawStarts: number[] = [];
  let decoded = '';
  let at = 0;
  // A `+` as a space keeps the length, so the plain parts still map one to one.
  const plain = (part: string): string => (plusIsSpace ? part.replace(/\+/g, ' ') : part);
  for (const match of raw.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)) {
    if (match.index > at) {
      decodedStarts.push(decoded.length);
      rawStarts.push(at);
      decoded += plain(raw.slice(at, match.index));
    }
    decodedStarts.push(decoded.length);
    rawStarts.push(match.index);
    decoded += percentDecode(match[0], false);
    at = match.index + match[0].length;
  }
  if (at < raw.length) {
    decodedStarts.push(decoded.length);
    rawStarts.push(at);
    decoded += plain(raw.slice(at));
  }
  decodedStarts.push(decoded.length);
  rawStarts.push(raw.length);
  const rawAt = (i: number, up: boolean): number => {
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
    if (i === chunkStart) return chunkRaw;
    // Inside a run of escapes: its start or its end, so the span covers the whole run.
    if (raw[chunkRaw] === '%') return up ? rawStarts[Math.min(low + 1, rawStarts.length - 1)]! : chunkRaw;
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
 * Where an unquoted value starting at `start` ends: at whitespace, `&`, markup or a quote, less a
 * sentence's full stop, a list's comma or a closing bracket.
 */
function unquotedEnd(text: string, start: number): number {
  let end = start;
  const limit = Math.min(text.length, start + MAX_VALUE);
  while (end < limit && !/[\s&<>"']/.test(text[end]!)) end++;
  while (end > start && /[.,;)}\]]/.test(text[end - 1]!)) end--;
  return end;
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
    if (quote === '"' || quote === "'") {
      const start = from + 1;
      const end = closingQuote(text, start, quote);
      if (end <= start || STOP_WORDS.has(text.slice(start, end).toLowerCase())) continue;
      spans.push({ start, end, kind: 'name', name });
      continue;
    }
    // A quoted name and a bare number, as in JSON the walker couldn't read: written back quoted,
    // so the JSON stays valid.
    // Only a whole JSON number, ending where a JSON value ends, after a double-quoted name.
    const scalar =
      match[1] === '"'
        ? /^-?(?:0|[1-9]\d{0,62})(?:\.\d{1,63})?(?:[eE][+-]?\d{1,4})?(?=\s{0,8}(?:[,}\]]|$))/.exec(
            text.slice(from, from + 160),
          )
        : null;
    if (scalar) {
      spans.push({
        start: from,
        end: from + scalar[0].length,
        kind: 'name',
        name,
        replacement: `"${REDACTED}"`,
      });
      continue;
    }
    const end = unquotedEnd(text, from);
    const value = text.slice(from, end);
    if (value.length < 6 || /[(){}<>$]/.test(value) || STOP_WORDS.has(value.toLowerCase())) continue;
    // Not added to the known values: a rule over free text is too loose a source for them.
    spans.push({ start: from, end, kind: 'name', name });
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

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

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
      if (next === undefined || !(next in SIMPLE_ESCAPES)) return undefined;
      char = SIMPLE_ESCAPES[next]!;
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
  /**
   * Only these keys take the inherited rule: an object inside a secret-named array passes it to a
   * key, value or ID (`{"api_keys":[{"key":"…"}]}`), not to every field.
   */
  inheritOnly?: ReadonlySet<string>;
  /** An array holding a header's values (`"set-cookie": ["…", "…"]`): the header's name. */
  headerKey?: string;
  /** An object naming a header (`{"name": "Cookie", "value": "…"}`): the header's name. */
  headerName?: string;
  /** In an object: the key of the value being read. */
  key?: string;
  /** In an object: whether the next token is a key. */
  expectKey: boolean;
}

/** Keys that take a secret container's rule though their own name says nothing, or says ID. */
const VALUE_KEYS: ReadonlySet<string> = new Set(['id', 'value', 'key', 'val']);
/** Keys holding a header's value, redacted by that header's rules (an echoed request, a HAR). */
const HEADER_KEYS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
]);

/** Families whose numbers are secrets too (a PIN, a card code); tokens' aren't. */
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
      const key = frame.key ?? '';
      const rule = nameRule(key, 'json');
      if (rule && rule !== 'describes') return rule;
      const lower = key.toLowerCase();
      // A session's or token's own `id` or `value` is the secret (`{"session":{"id":"…"}}`).
      // An ID only of a session or token: a secret's or key's ID isn't the secret.
      if (
        frame.inherit &&
        VALUE_KEYS.has(lower) &&
        (lower !== 'id' || LONG_ONLY_FAMILIES.has(frame.inherit))
      ) {
        return frame.inherit;
      }
      if (rule === 'describes' || (frame.inheritOnly && !frame.inheritOnly.has(lower))) return undefined;
      return frame.inherit;
    }
    return frame.inherit;
  };
  /** Whether the value here is under a strong secret name of its own, not one it inherits. */
  const ownStrong = (): boolean => {
    const frame = stack.at(-1);
    if (frame?.kind !== 'object') return false;
    const rule = nameRule(frame.key ?? '', 'json');
    return rule !== undefined && rule !== 'describes' && STRONG_FAMILIES.has(rule);
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
    const frame = stack.at(-1);
    const key = frame?.kind === 'object' ? (frame.key ?? '') : '';
    // A header's value: under its name, in an array under its name, or as a HAR-style pair's value.
    const header =
      frame?.kind === 'array'
        ? frame.headerKey
        : HEADER_KEYS.has(key.toLowerCase())
          ? key
          : key === 'value'
            ? frame?.headerName
            : undefined;
    if (frame?.kind === 'object' && key.toLowerCase() === 'name' && HEADER_KEYS.has(decoded.toLowerCase())) {
      frame.headerName = decoded;
    }
    if (header && decoded !== '') {
      // As the header itself would be: a cookie's name kept, an authorization's scheme. The whole
      // string is written back, so escapes in its kept parts may change; it stays valid JSON.
      const redacted = redactHeader(header, decoded, known).value;
      if (redacted !== decoded) {
        spans.push({
          start,
          end,
          kind: 'name',
          name: key,
          replacement: JSON.stringify(redacted).slice(1, -1),
        });
        return true;
      }
      // Nothing to redact by the header's rules: the shapes and known values below still look.
    }
    if (family && decoded !== '') {
      const longEnough = !LONG_ONLY_FAMILIES.has(family) || (decoded.length >= 8 && !/\s/.test(decoded));
      if (longEnough) {
        spans.push({ start, end, kind: 'name', name: nameHere() });
        // Only a value under its own strong name is certain enough to look for elsewhere.
        if (known && ownStrong()) addValue(known, decoded);
        return true;
      }
    }
    // Too short for a token shape, a URL with a secret, an assignment or a known value.
    if (decoded.length < 8) return true;
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
        const decodedKey = decodeJsonString(text.slice(i + 1, end - 1));
        if (decodedKey === undefined) return undefined;
        const key = decodedKey.decoded;
        frame.key = key;
        // A key can be a secret too (a token used as a map's key): its shapes and known values.
        if (key.length >= 8) {
          const inKey = shapeSpans(key, known);
          if (known) for (const span of known.scan(key)) inKey.push(span);
          for (const span of mergeSpans(inKey)) {
            spans.push({
              ...span,
              start: i + 1 + decodedKey.rawAt(span.start),
              end: i + 1 + decodedKey.rawAt(span.end),
            });
          }
        }
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
        // An object in a secret-named array passes the rule on to its key, value or ID only.
        const inArray = c === '{' && frame?.kind === 'array' && frame.inherit !== undefined;
        const inherit = c === '[' || inArray ? family : own && own !== 'describes' ? own : undefined;
        const inheritName = inherit ? nameHere() : undefined;
        stack.push(
          c === '{'
            ? {
                kind: 'object',
                inherit,
                inheritName,
                expectKey: true,
                ...(inArray ? { inheritOnly: VALUE_KEYS } : {}),
              }
            : {
                kind: 'array',
                inherit,
                inheritName,
                expectKey: false,
                ...(frame?.kind === 'object' && HEADER_KEYS.has((frame.key ?? '').toLowerCase())
                  ? { headerKey: frame.key }
                  : {}),
              },
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
        // Numbers only: a boolean is no secret, and changing its type would break readers.
        if (family && SCALAR_FAMILIES.has(family) && /^-?\d/.test(scalar[0])) {
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

/** Tags and quoted attribute values up to 256 KB: a SAML form's hidden input runs to 20 KB. */
const TAG = /<([A-Za-z][\w:.-]{0,63})([^<>]{0,262144})>/g;
const ATTRIBUTE =
  /([A-Za-z_:][\w:.-]{0,63})\s*=\s*(?:"([^"]{0,262144})"|'([^']{0,262144})'|([^\s"'<>`=]{1,4096}))/g;

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
    // A password field is one whatever its name.
    const isPassword =
      /^input$/i.test(match[1]!) &&
      attributes.some((a) => /^type$/i.test(a.name) && /^password$/i.test(a.value));
    const namedFamily = isPassword ? 'password' : named ? secretName(named.value, 'form') : undefined;
    for (const attribute of attributes) {
      if (attribute.value === '') continue;
      const own = secretName(localName(attribute.name), 'json');
      const byName = namedFamily && /^(?:value|content)$/i.test(attribute.name);
      if (!own && !byName) continue;
      spans.push({
        start: attribute.start,
        end: attribute.end,
        kind: 'name',
        name: byName ? (named?.value ?? 'password') : attribute.name,
      });
      const family = byName ? namedFamily : own;
      if (sink && family && STRONG_FAMILIES.has(family)) addValue(sink, attribute.value);
    }
  }
  return spans;
}

const ELEMENT_OPEN = /<([A-Za-z][\w:.-]{0,63})(\s[^<>]{0,4096})?>/g;
const CDATA_OPEN = '<![CDATA[';

/**
 * Elements whose text is a secret, redacted: by the element's name (`<Password>…</Password>`,
 * `<wsse:Password>`), or in XML by its `key` attribute (`<entry key="password">…</entry>`). In
 * HTML only a `<textarea>` with a secret `name` counts: a link or button named for a password
 * holds words, not one. Plain text or one CDATA section, after any whitespace. Only text found by
 * the element's own name is added to the known values.
 */
export function xmlElementSpans(text: string, sink?: ValueSink, html = false): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(ELEMENT_OPEN)) {
    const name = match[1]!;
    const byOwnName = html ? undefined : secretName(localName(name), 'json');
    let family: SecretFamily | undefined = byOwnName;
    let named: Attribute | undefined;
    if (!family) {
      const attributes = match[2] ? attributesOf(match[2], match.index + 1 + name.length) : [];
      named = html
        ? /^textarea$/i.test(name)
          ? attributes.find((a) => /^name$/i.test(a.name))
          : undefined
        : attributes.find((a) => /^key$/i.test(a.name));
      family = named ? secretName(named.value, 'form') : undefined;
    }
    if (!family) continue;
    // The text, searched for its end only so far: an unclosed one isn't read to the body's end.
    let start = match.index + match[0].length;
    const window = text.slice(start, start + 64 + CDATA_OPEN.length + MAX_VALUE + 3);
    const lead = /^\s{0,64}/.exec(window)![0].length;
    let close: number;
    if (window.startsWith(CDATA_OPEN, lead)) {
      const cdataEnd = window.indexOf(']]>', lead + CDATA_OPEN.length);
      if (cdataEnd < 0 || !text.startsWith(`</${name}`, start + cdataEnd + 3)) continue;
      close = start + cdataEnd;
      start += lead + CDATA_OPEN.length;
    } else {
      const lt = window.indexOf('<');
      if (lt < 0 || !text.startsWith(`</${name}`, start + lt)) continue;
      close = start + lt;
    }
    if (close === start) continue;
    spans.push({ start, end: close, kind: 'name', name: named?.value ?? localName(name) });
    if (sink && byOwnName && STRONG_FAMILIES.has(byOwnName)) addValue(sink, text.slice(start, close).trim());
  }
  return spans;
}

/** Where `<script>` and `<style>` elements' contents are, in which assignments are code. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const open = /<(script|style)\b[^<>]{0,4096}>/gi;
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const start = match.index + match[0].length;
    const close = new RegExp(`</${match[1]!}`, 'gi');
    close.lastIndex = start;
    const end = close.exec(text)?.index ?? text.length;
    ranges.push([start, end]);
    // On from the element's end: an unclosed one runs to the end, and is searched once.
    open.lastIndex = end;
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
    type === 'application/x-jsonlines' ||
    type === 'application/stream+json'
  )
    return 'ndjson';
  if (type === 'application/json' || type.endsWith('+json') || type === 'text/json') return 'json';
  if (type === 'text/event-stream') return 'sse';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if (type.startsWith('multipart/')) return 'multipart';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.endsWith('/xml') || type.endsWith('+xml')) return 'xml';
  if (/javascript|ecmascript|^text\/css$|sourcemap|\/wasm/.test(type)) return 'code';
  if (type.startsWith('application/grpc')) return 'opaque';
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

/** Multipart parts are looked into this many levels deep (a part can be multipart itself). */
const MAX_MULTIPART_DEPTH = 2;
/** A part's headers are looked for in its first 16 KB. */
const MAX_PART_HEADERS = 16_384;

/** The text rules and the known values, for text with no structure to go by. */
function plainSpans(text: string, known: KnownValues | undefined, assignments: boolean): Span[] {
  const spans = textSpans(text, known, assignments);
  if (known) for (const span of known.scan(text)) spans.push(span);
  return spans;
}

/** Spans in a multipart body, part by part. */
function multipartSpans(
  text: string,
  mediaType: string | undefined,
  known: KnownValues | undefined,
  notScanned: string[],
  depth: number,
): Span[] {
  const boundary = boundaryOf(mediaType);
  if (!boundary) return plainSpans(text, known, true);
  if (depth >= MAX_MULTIPART_DEPTH) {
    notScanned.push('multipart nested more than two deep, read as text');
    return plainSpans(text, known, true);
  }
  const spans: Span[] = [];
  const add = (inner: Span[], offset: number): void => {
    for (const span of inner) spans.push({ ...span, start: offset + span.start, end: offset + span.end });
  };
  const delimiter = `--${boundary}`;
  let at = text.indexOf(delimiter);
  // Before the first part: a preamble, as text.
  add(plainSpans(text.slice(0, at < 0 ? text.length : at), known, true), 0);
  while (at >= 0) {
    const headersStart = at + delimiter.length;
    if (text.startsWith('--', headersStart)) {
      // After the last part: an epilogue, as text.
      add(plainSpans(text.slice(headersStart + 2), known, true), headersStart + 2);
      break;
    }
    const next = text.indexOf(delimiter, headersStart);
    const partEnd = next < 0 ? text.length : next;
    // The blank line ending the part's headers, looked for only in the part's first 16 KB.
    const zone = text.slice(headersStart, Math.min(partEnd, headersStart + MAX_PART_HEADERS));
    const crlf = zone.indexOf('\r\n\r\n');
    const lf = zone.indexOf('\n\n');
    const blankInZone = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
    if (blankInZone < 0) {
      // A part with no headers to read: its text gets the text rules, and the next part is read.
      add(plainSpans(text.slice(headersStart, partEnd), known, true), headersStart);
      at = next;
      continue;
    }
    const blank = headersStart + blankInZone;
    const headers = text.slice(headersStart, blank);
    // A part's headers: token shapes and known values (`filename="<token>.bin"`).
    add(plainSpans(headers, known, false), headersStart);
    let bodyEnd = partEnd;
    if (text.slice(bodyEnd - 2, bodyEnd) === '\r\n') bodyEnd -= 2;
    else if (text[bodyEnd - 1] === '\n') bodyEnd -= 1;
    const disposition = /^content-disposition:([^\r\n]{0,1024})/im.exec(headers)?.[1] ?? '';
    // `name=`, quoted or not, and not the end of `filename=`.
    const nameMatch = /(?:^|[;\s])name=(?:"([^"]{0,256})"|([^;\s]{1,256}))/i.exec(disposition);
    const name = nameMatch ? (nameMatch[1] ?? nameMatch[2]) : undefined;
    const isFile = /filename\*?=/i.test(disposition);
    const partType = /^content-type:\s*([^\r\n]{1,256})/im.exec(headers)?.[1];
    if (bodyEnd > blank) {
      const family = name !== undefined ? secretName(name, 'form') : undefined;
      if (family) {
        // A secret-named field or file (an uploaded private key) is redacted whole.
        spans.push({ start: blank, end: bodyEnd, kind: 'name', name });
        if (known && !isFile && STRONG_FAMILIES.has(family)) addValue(known, text.slice(blank, bodyEnd));
      } else if (isFile && partType && !/^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(partType)) {
        notScanned.push('a file part that isn’t text');
        // Token shapes are still looked for: a key or token in a file of unknown type.
        add(plainSpans(text.slice(blank, bodyEnd), known, false), blank);
      } else {
        add(
          kindSpans(text.slice(blank, bodyEnd), partType ?? 'text/plain', known, notScanned, depth + 1),
          blank,
        );
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
      : plainSpans(line, known, true);
    for (const span of inLine) spans.push({ ...span, start: at + span.start, end: at + span.end });
    at = end + 1;
  }
  return spans;
}

/** What can come before JSON: a byte order mark, and the prefixes that guard JSON from being run as a script. */
const JSON_PREFIX = /^\uFEFF?(?:\)\]\}',?\s*|for\s*\(;;\);\s*|while\s*\(\s*1\s*\);\s*)?/;

/** JSON after any prefix, its spans in the text's positions; undefined if it isn't JSON. */
function prefixedJsonSpans(text: string, known: KnownValues | undefined): Span[] | undefined {
  const prefix = JSON_PREFIX.exec(text)![0].length;
  const spans = jsonSpans(prefix > 0 ? text.slice(prefix) : text, known);
  return spans?.map((s) => ({ ...s, start: s.start + prefix, end: s.end + prefix }));
}

/** A form's fields: by name, values holding JSON by its rules, and known values (`+` as a space). */
function formBodySpans(text: string, known: KnownValues | undefined): Span[] {
  const spans = formSpans(text, known);
  for (const span of shapeSpans(text, known)) spans.push(span);
  // A field holding JSON (`payload=%7B%22password%22…`): redacted whole if the JSON has a secret.
  let at = 0;
  for (const pair of text.split('&')) {
    const eq = pair.indexOf('=');
    if (eq >= 0) {
      const value = pair.slice(eq + 1);
      const decoded = percentDecode(value);
      if (/^\s*[[{]/.test(decoded) && (jsonSpans(decoded, known)?.length ?? 0) > 0) {
        spans.push({
          start: at + eq + 1,
          end: at + pair.length,
          kind: 'name',
          name: percentDecode(pair.slice(0, eq)),
        });
      }
    }
    at += pair.length + 1;
  }
  if (known) for (const span of known.scan(text, true)) spans.push(span);
  return spans;
}

/** Spans by the rules for a body's kind, known values included. */
function kindSpans(
  text: string,
  mediaType: string | undefined,
  known: KnownValues | undefined,
  notScanned: string[],
  depth = 0,
): Span[] {
  const kind = bodyKind(mediaType);
  switch (kind) {
    case 'json':
      // JSON as a whole, else line by line (JSON objects one after another), else text.
      return prefixedJsonSpans(text, known) ?? lineSpans(text, known, () => 0);
    case 'ndjson':
      return lineSpans(text, known, () => 0);
    case 'sse':
      // `data:` lines' values, with the one space after the colon left out.
      return lineSpans(text, known, (line) => (line.startsWith('data:') ? (line[5] === ' ' ? 6 : 5) : -1));
    case 'form':
      return formBodySpans(text, known);
    case 'multipart':
      return multipartSpans(text, mediaType, known, notScanned, depth);
    case 'xml': {
      const spans = plainSpans(text, known, true);
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
      const spans = plainSpans(text, known, false);
      for (const span of assignmentSpans(text)) if (!inCode(span)) spans.push(span);
      for (const span of tagSpans(text, known)) spans.push(span);
      for (const span of xmlElementSpans(text, known, true)) spans.push(span);
      return spans;
    }
    case 'code':
      return plainSpans(text, known, false);
    case 'opaque':
      notScanned.push('an encoded body');
      return [];
    default:
      // Text that is JSON, sent without saying so; else text.
      return (
        (/^\uFEFF?\s*[[{)fw]/.test(text) ? prefixedJsonSpans(text, known) : undefined) ??
        plainSpans(text, known, true)
      );
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
  // Known values are looked for by each kind's rules: in JSON, inside its strings; in text, anywhere.
  const spans = kindSpans(text, mediaType, known, notScanned);
  const merged = mergeSpans(spans);
  return {
    spans: merged,
    records: recordsOf(merged),
    ...(notScanned.length > 0 ? { notScanned: [...new Set(notScanned)].join('; ') } : {}),
  };
}
