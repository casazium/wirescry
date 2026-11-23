/**
 * Masking a body for the window while View › Hide Secrets is on: the same rules as HAR export
 * (src/shared/redact-body.ts), with what the window needs to show it. The text with each secret
 * replaced by `[redacted]`, for the Formatted, Text and Fields views; and the byte ranges that held
 * them, for the Hex view, with those bytes overwritten so they never reach the window.
 *
 * Runs in a worker thread (mask-worker.mts), so its imports carry `.ts` and are pure: Node loads
 * them from source in tests.
 */
import { applySpans, mergeSpans, redactHeader, redactUrl, type Span } from '../shared/redact.ts';
import { bodyKind, isTextual, KnownValues, redactBody } from '../shared/redact-body.ts';
import { textOfBytes, type Encoding } from './har-redact.ts';
import type { SseItem } from '../shared/sse.ts';

/** A byte range in a body, [start, end). */
export type ByteRange = [number, number];

/** A body masked for the window. */
export type MaskedBytes =
  /** Not shown at all: none of its bytes go to the window. */
  | { hidden: string }
  | {
      /** The bytes with each secret's bytes overwritten with `*`. */
      bytes: Uint8Array;
      /** The body as UTF-8 text with secrets replaced, when it's UTF-8 text. */
      text?: string;
      /** Where secrets were in `bytes`, sorted and apart. */
      ranges: ByteRange[];
      /** Not text, so not checked. */
      binary?: true;
      /** What was masked, as written, for masking the same body formatted. */
      literals: string[];
    };

/** Why a body that isn't text is left out: a secret found elsewhere is in its bytes. */
/** Why a body said to be text that can't be read as text is left out. */
export const HIDDEN_UNREADABLE = 'This body couldn’t be read as text, so it can’t be checked for secrets.';

export const HIDDEN_BINARY =
  'This body isn’t text and holds a value hidden elsewhere, so it isn’t shown while View › Hide Secrets is on.';

const STAR = 0x2a;

/**
 * How many bytes at the end of `bytes` are the start of a UTF-8 character that was cut off: 0 to
 * 3. A body kept to its first few MB can end partway through one.
 */
export function cutUtf8Tail(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const byte = bytes[n - back]!;
    if ((byte & 0xc0) === 0x80) continue; // A continuation byte: look further back.
    const needs = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needs > back ? back : 0;
  }
  return 0;
}

interface Decoded {
  text: string;
  encoding: 'utf8' | Encoding;
  /** Bytes the text covers: all but a cut-off character at the end. */
  length: number;
}

/** Whether bytes say they're UTF-16: a byte-order mark, or a charset. */
function saysUtf16(bytes: Uint8Array, mediaType: string): boolean {
  const bom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  return bom || /charset\s*=\s*"?utf-16/i.test(mediaType);
}

/** UTF-16 or Latin-1 text, as HAR export reads it, allowing for a cut after half a character. */
function otherText(bytes: Uint8Array, mediaType: string, cut: boolean): Decoded | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const whole = textOfBytes(buffer, mediaType);
  if (whole) return { ...whole, length: bytes.length };
  if (cut && bytes.length % 2 === 1) {
    const even = textOfBytes(buffer.subarray(0, bytes.length - 1), mediaType);
    if (even && even.encoding !== 'latin1') return { ...even, length: bytes.length - 1 };
  }
  return undefined;
}

/**
 * A body's text, read as the window reads it (UTF-8) where it can be, else as HAR export reads a
 * text body (UTF-16 or Latin-1), so its bytes can still be masked in the Hex view. A BOM is kept as
 * a character, so offsets match the bytes. Undefined if it isn't text, or can't be read surely.
 *
 * UTF-16 comes first: ASCII written in UTF-16 is valid UTF-8 too, with a NUL in every other byte,
 * and read as UTF-8 nothing in it would be found.
 */
export function decodeForMask(bytes: Uint8Array, mediaType: string, cut: boolean): Decoded | undefined {
  let nuls = 0;
  for (const byte of bytes) if (byte === 0) nuls++;
  if (nuls > 0 || saysUtf16(bytes, mediaType)) {
    const other = otherText(bytes, mediaType, cut);
    if (other && other.encoding !== 'latin1') return other;
    // Said to be UTF-16 but can't be read so, or NULs in no pattern UTF-16 shows: not text.
    if (!other) return undefined;
  }
  const tail = cut ? cutUtf8Tail(bytes) : 0;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, bytes.length - tail),
    );
    return { text, encoding: 'utf8', length: bytes.length - tail };
  } catch {
    // Not UTF-8: maybe text in another encoding.
  }
  if (!isTextual(mediaType)) return undefined;
  return otherText(bytes, mediaType, cut);
}

/**
 * Spans of `text` (in UTF-16 code units) as byte ranges in the bytes it was decoded from. Spans
 * must be sorted and apart (as mergeSpans makes them). One pass over the text.
 */
export function byteRanges(text: string, spans: readonly Span[], encoding: Decoded['encoding']): ByteRange[] {
  if (encoding === 'latin1') return spans.map((s) => [s.start, s.end]);
  if (encoding !== 'utf8') return spans.map((s) => [s.start * 2, s.end * 2]);
  const out: ByteRange[] = [];
  let i = 0;
  let bytes = 0;
  const advance = (to: number): void => {
    while (i < to) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          // A pair: four bytes, and a span never starts or ends between its halves.
          bytes += 4;
          i += 2;
          continue;
        }
        bytes += 3;
      } else bytes += 3;
      i += 1;
    }
  };
  for (const span of spans) {
    advance(span.start);
    const start = bytes;
    advance(span.end);
    out.push([start, bytes]);
  }
  return out;
}

/** The media type the rules read: gRPC's isn't read as text, but a body that decodes as text is. */
function rulesType(mediaType: string): string {
  return bodyKind(mediaType) === 'opaque' ? 'text/plain' : mediaType;
}

/**
 * A body masked with `known` (its exchange's values and the session's): text found by the rules
 * and known values replaced, its bytes overwritten. `cut` says only its start was kept.
 */
export function maskBytes(
  bytes: Uint8Array,
  mediaType: string,
  cut: boolean,
  known: KnownValues,
): MaskedBytes {
  const decoded = decodeForMask(bytes, mediaType, cut);
  if (!decoded) {
    // Text it can't read: its secrets can't be found, so it isn't shown.
    if (isTextual(mediaType) || saysUtf16(bytes, mediaType)) return { hidden: HIDDEN_UNREADABLE };
    if (known.inBytes(bytes)) return { hidden: HIDDEN_BINARY };
    return { bytes, ranges: [], binary: true, literals: [] };
  }
  const { text, encoding } = decoded;
  // Read as UTF-16 (by a BOM or NULs that may be chance in binary): a known value written as plain
  // UTF-8 bytes in it wouldn't be found in the text, so the body isn't shown.
  if (encoding !== 'utf8' && encoding !== 'latin1') {
    if (known.inBytes(bytes)) return { hidden: HIDDEN_BINARY };
    // Nor would a secret the rules find in it read byte for byte (the Hex view's ASCII column).
    const asBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
    if (redactBody(asBytes, 'text/plain', known).spans.length > 0) return { hidden: HIDDEN_BINARY };
  }
  const spans = mergeSpans(redactBody(text, rulesType(mediaType), known, { cut }).spans);
  const ranges = byteRanges(text, spans, encoding);
  // A secret running to a cut end runs on into the cut-off character's bytes.
  const last = ranges[ranges.length - 1];
  if (last && last[1] === decoded.length) last[1] = bytes.length;
  let masked = bytes;
  if (ranges.length > 0) {
    masked = Uint8Array.from(bytes);
    for (const [start, end] of ranges) masked.fill(STAR, start, end);
  }
  return {
    bytes: masked,
    ...(encoding === 'utf8' ? { text: applySpans(text, spans) } : {}),
    ranges,
    literals: spans.map((s) => text.slice(s.start, s.end)),
  };
}

/** Values the request body holds, learned before its response is masked (export's order). */
export function learnFrom(bytes: Uint8Array, mediaType: string, cut: boolean, known: KnownValues): void {
  const decoded = decodeForMask(bytes, mediaType, cut);
  if (decoded) redactBody(decoded.text, rulesType(mediaType), known, { cut });
}

/** At most this many values masked in a body are looked for in it formatted, each this long. */
export const MAX_LITERALS = 5_000;
export const MAX_LITERAL_LENGTH = 64 * 1024;
/** At most this many are shorter than four characters. */
const MAX_SHORT = 32;
/** Characters compared, at most, finding them: a hostile body can't make it slow. */
const MAX_COMPARED = 50_000_000;
const PREFIX = 4;

/** Why formatted code isn't shown: too many values were masked in it to find them all again. */
export const HIDDEN_FORMATTED = 'too many values were hidden in it to show it formatted';

/**
 * Formatted code (from the body `literals` were masked in) with the same values masked, wherever
 * formatting left them whole, plus anything the rules and `known` find in it. Undefined if there
 * are too many values to look for.
 */
export function maskFormatted(
  formatted: string,
  mediaType: string,
  literals: readonly string[],
  known: KnownValues,
): string | undefined {
  const byPrefix = new Map<string, string[]>();
  const seen = new Set<string>();
  const short: string[] = [];
  for (const literal of literals) {
    if (seen.has(literal)) continue;
    seen.add(literal);
    if (seen.size > MAX_LITERALS || literal.length > MAX_LITERAL_LENGTH) return undefined;
    if (literal.length < PREFIX) {
      if (short.length >= MAX_SHORT) return undefined;
      short.push(literal);
      continue;
    }
    const key = literal.slice(0, PREFIX);
    const list = byPrefix.get(key) ?? [];
    list.push(literal);
    byPrefix.set(key, list);
  }
  const spans: Span[] = [];
  if (byPrefix.size > 0) {
    let compared = 0;
    for (let i = 0; i + PREFIX <= formatted.length; i++) {
      const list = byPrefix.get(formatted.slice(i, i + PREFIX));
      if (!list) continue;
      let end = 0;
      for (const literal of list) {
        if (literal.length <= end) continue;
        compared += literal.length;
        if (compared > MAX_COMPARED) return undefined;
        if (formatted.startsWith(literal, i)) end = literal.length;
      }
      if (end > 0) spans.push({ start: i, end: i + end, kind: 'known value' });
    }
  }
  // Values of one to three characters (rare: a short password) are found only where they stand alone.
  for (const literal of short) {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of formatted.matchAll(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'g'))) {
      spans.push({ start: match.index, end: match.index + literal.length, kind: 'known value' });
    }
  }
  for (const span of redactBody(formatted, rulesType(mediaType), known).spans) spans.push(span);
  return applySpans(formatted, spans);
}

// ---------------------------------------------------------------- messages and events

/** A WebSocket message to mask: its kept bytes, whether it's binary, and whether it was cut. */
export interface MessageBytes {
  bytes: Uint8Array;
  binary: boolean;
  cut: boolean;
}

/** A message masked: as a body is, without the literals. */
export type MaskedMessage =
  { hidden: string } | { bytes: Uint8Array; text?: string; ranges: ByteRange[]; binary?: true };

/** Why a message or event isn't shown when checking it went wrong. */
export const MESSAGE_FAILED = 'Couldn’t check this message for secrets.';
export const EVENT_FAILED = 'Couldn’t check this event for secrets.';

/**
 * A page of WebSocket messages masked, in order, with the stream's known values. Read twice: once
 * to learn, so a value found in any message of the page is hidden in all of them, and in later
 * pages. A binary message is checked as text when it is text (JSON in binary frames is common);
 * otherwise it's hidden if it holds a known value. One that can't be checked is hidden alone.
 */
export function maskMessages(
  messages: readonly MessageBytes[],
  known: KnownValues,
  /** For tests: how one message is masked. */
  maskOne: typeof maskBytes = maskBytes,
): MaskedMessage[] {
  const type = (binary: boolean): string => (binary ? 'application/octet-stream' : 'text/plain');
  for (const { bytes, binary, cut } of messages) {
    try {
      learnFrom(bytes, type(binary), cut, known);
    } catch {
      // Learned nothing from it; it's hidden below if it fails again.
    }
  }
  return messages.map(({ bytes, binary, cut }): MaskedMessage => {
    try {
      const result = maskOne(bytes, type(binary), cut, known);
      if ('hidden' in result) return result;
      const { literals: _literals, ...masked } = result;
      void _literals;
      return masked;
    } catch {
      return { hidden: MESSAGE_FAILED };
    }
  });
}

/** Text with secrets replaced, by the text rules (which read JSON where they find it), as export does. */
export function maskString(text: string, known: KnownValues, cut = false): string {
  return applySpans(text, redactBody(text, 'text/plain', known, { cut }).spans);
}

/**
 * Server-Sent Events items masked, in order, with the stream's known values: an event's data, type
 * and ID, and a comment's text. A retry is a number. One that can't be checked says so.
 */
export function maskSseItems(
  items: readonly SseItem[],
  known: KnownValues,
  /** For tests: how one string is masked. */
  maskText: typeof maskString = maskString,
): SseItem[] {
  const each = (item: SseItem): SseItem => {
    if (item.kind === 'comment') return { ...item, text: maskText(item.text, known) };
    if (item.kind === 'retry') return item;
    return {
      ...item,
      type: maskText(item.type, known),
      data: maskText(item.data, known, item.cut === true),
      ...(item.id !== undefined ? { id: maskText(item.id, known) } : {}),
    };
  };
  // Once to learn, so a value found in any item is hidden in all of them.
  for (const item of items) {
    try {
      each(item);
    } catch {
      // Learned nothing from it.
    }
  }
  return items.map((item) => {
    try {
      return each(item);
    } catch {
      return failedItem(item);
    }
  });
}

/** An item that couldn't be checked: its text replaced, saying so. */
export function failedItem(item: SseItem): SseItem {
  if (item.kind === 'comment') return { ...item, text: EVENT_FAILED };
  if (item.kind === 'retry') return item;
  const { cut: _cut, ...rest } = item;
  void _cut;
  return {
    ...rest,
    type: '[redacted]',
    data: EVENT_FAILED,
    ...(item.id !== undefined ? { id: '[redacted]' } : {}),
  };
}

// ---------------------------------------------------------------- summary and header fields

/** A piece of an exchange's summary or headers to mask, by what it is. */
export type MaskField =
  | { kind: 'url'; value: string }
  | { kind: 'header'; name: string; value: string }
  /** A host name: not a secret by any rule, but a known value can turn up in one. */
  | { kind: 'host'; value: string }
  | { kind: 'text'; value: string }
  /** A body's text, read by its type (JSON by its keys, a form by its field names). */
  | { kind: 'body'; contentType: string; value: string }
  /** A JSON document that must stay valid: known values are looked for inside its strings only. */
  | { kind: 'json'; value: string };

/** Known values left in text after the rules: masked too. */
function withKnown(text: string, known: KnownValues): string {
  return applySpans(text, known.scan(text));
}

function maskField(field: MaskField, known: KnownValues): string {
  switch (field.kind) {
    case 'url':
      return withKnown(redactUrl(field.value, known).url, known);
    case 'header':
      return withKnown(redactHeader(field.name, field.value, known).value, known);
    case 'host':
      return withKnown(field.value, known);
    case 'text':
      return maskString(field.value, known);
    case 'json':
      return applySpans(field.value, redactBody(field.value, 'application/json', known).spans);
    case 'body': {
      const redaction = redactBody(field.value, field.contentType, known);
      // What its type's rules found stands; a part they couldn't read gets the text rules too.
      const spans = redaction.notScanned
        ? mergeSpans([...redaction.spans, ...redactBody(field.value, 'text/plain', known).spans])
        : redaction.spans;
      return withKnown(applySpans(field.value, spans), known);
    }
  }
}

/**
 * Fields masked by the rules and the known values, read twice: once to learn, so a value found in
 * any field (an Authorization header, say) is hidden in all of them (a path, another header).
 * One that can't be masked is hidden whole.
 */
export function maskFields(fields: readonly MaskField[], known: KnownValues): string[] {
  for (const field of fields) {
    try {
      maskField(field, known);
    } catch {
      // Learned nothing from it.
    }
  }
  return fields.map((field) => {
    try {
      return maskField(field, known);
    } catch {
      return '[redacted]';
    }
  });
}
