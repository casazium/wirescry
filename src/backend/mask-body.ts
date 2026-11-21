/**
 * Masking a body for the window while View › Hide Secrets is on: the same rules as HAR export
 * (src/shared/redact-body.ts), with what the window needs to show it. The text with each secret
 * replaced by `[redacted]`, for the Formatted, Text and Fields views; and the byte ranges that held
 * them, for the Hex view, with those bytes overwritten so they never reach the window.
 *
 * Runs in a worker thread (mask-worker.mts), so its imports carry `.ts` and are pure: Node loads
 * them from source in tests.
 */
import { applySpans, mergeSpans, type Span } from '../shared/redact.ts';
import { bodyKind, isTextual, KnownValues, redactBody } from '../shared/redact-body.ts';
import { textOfBytes, type Encoding } from './har-redact.ts';

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

/**
 * A body's text, read as the window reads it (UTF-8) where it can be, else as HAR export reads a
 * text body (UTF-16 or Latin-1), so its bytes can still be masked in the Hex view. A BOM is kept as
 * a character, so offsets match the bytes. Undefined if it isn't text.
 */
export function decodeForMask(bytes: Uint8Array, mediaType: string, cut: boolean): Decoded | undefined {
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
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const whole = textOfBytes(buffer, mediaType);
  if (whole) return { ...whole, length: bytes.length };
  // UTF-16 cut after half a character.
  if (cut && bytes.length % 2 === 1) {
    const even = textOfBytes(buffer.subarray(0, bytes.length - 1), mediaType);
    if (even && even.encoding !== 'latin1') return { ...even, length: bytes.length - 1 };
  }
  return undefined;
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
    if (known.inBytes(bytes)) return { hidden: HIDDEN_BINARY };
    return { bytes, ranges: [], binary: true, literals: [] };
  }
  const { text, encoding } = decoded;
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
/** At most this many of them start with the same four characters, and this many are shorter. */
const MAX_PER_PREFIX = 16;
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
    if (list.length >= MAX_PER_PREFIX) return undefined;
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
