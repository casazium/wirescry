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
  credentialLike,
  formSpans,
  isKeyName,
  keyValueIsSecret,
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
} from './redact.ts';

// ---------------------------------------------------------------- known values

const TOKEN_CHAR = /[A-Za-z0-9_-]/;
const TOKEN_RUN = /[A-Za-z0-9_-]+/g;
/**
 * A run of characters that can't end a value written in a URL or form (no space, quote or angle
 * bracket), anchored at its start so each is read once. Runs holding a `%` (or, in a form, a `+`)
 * are decoded, and runs holding a `\` have JSON's escapes undone, and are searched again.
 */
const ENCODED_RUN = /(?<![^\s"'<>])[^\s"'<>]+/g;

/** A long value in `longIndex`, keyed by the eight characters ending at `k` in it. */
interface LongEntry {
  value: string;
  k: number;
}

/**
 * The largest `k`, at most `from`, where the eight characters of `value` before `k` hold at least
 * four different ones; -1 if there's none. A count of each character slides back with the
 * window, so the search reads each character about once, and stops at the first it finds.
 */
export function variedWindowEnd(value: string, from: number): number {
  if (from < 8 || from > value.length) return -1;
  const counts = new Map<string, number>();
  let distinct = 0;
  const add = (char: string): void => {
    const count = counts.get(char) ?? 0;
    if (count === 0) distinct++;
    counts.set(char, count + 1);
  };
  for (let i = from - 8; i < from; i++) add(value[i]!);
  for (let k = from; ; k--) {
    if (distinct >= 4) return k;
    if (k === 8) return -1;
    // The window one back: gains the character before it, loses its last.
    add(value[k - 9]!);
    const last = value[k - 1]!;
    const left = counts.get(last)! - 1;
    counts.set(last, left);
    if (left === 0) distinct--;
  }
}

/** Adds `value` to `index` under `key`. */
function indexBy(index: Map<string, string[]>, key: string, value: string): void {
  const list = index.get(key);
  if (list) list.push(value);
  else index.set(key, [value]);
}

/**
 * JSON's escapes undone, leniently, for finding known values: `\/`, `\\` and `\uXXXX` (a run of
 * text never holds a quote, so `\"` can't appear in one); any other backslash is kept as written.
 * With a map from an index in the result to one in `raw` (a start to the escape's start, an end
 * to after it).
 */
function undoEscapes(raw: string): { decoded: string; rawAt: (i: number, up: boolean) => number } {
  const parts: string[] = [];
  const starts: number[] = [];
  const extras: number[] = [];
  let from = 0;
  let length = 0;
  let extra = 0;
  for (let at = raw.indexOf('\\'); at >= 0; at = raw.indexOf('\\', at)) {
    const next = raw[at + 1];
    let char: string | undefined;
    let width = 2;
    if (next === '/' || next === '\\') char = next;
    else if (next === 'u' && /^[0-9A-Fa-f]{4}$/.test(raw.slice(at + 2, at + 6))) {
      char = String.fromCharCode(parseInt(raw.slice(at + 2, at + 6), 16));
      width = 6;
    }
    if (char === undefined) {
      at += 1;
      continue;
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
  if (starts.length === 0) return { decoded: raw, rawAt: (i) => i };
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

/**
 * How many values new to a set an exchange's URL may add to it: in a set of the exchange's own, so
 * a URL of junk leaves room for what its bodies teach; in a set shared by many (the session's, an
 * export's), so URLs leave room for header values.
 */
export const OWN_URL_SHARE = 2_000;
export const SHARED_URL_SHARE = 8_000;
/** How many values new to an exchange's own set its request body may add. */
export const REQUEST_BODY_SHARE = 3_000;

/** The longest value kept (see `distinctive`). */
const MAX_KNOWN_LENGTH = 4096;
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
 * Secret values found so far, found again wherever they appear: as written, percent-encoded, or
 * with JSON's escapes. Only distinctive values are kept (see `distinctive`). In bodies a match must
 * stand alone, not be part of a longer run of letters and digits, unless the value is 16+
 * characters long (see `embedded`); a body cut off inside one is caught by `cutTail`.
 *
 * Finding is one pass: each run of token characters in the text is looked up by itself in a map
 * keyed by each value's longest run, then the whole value is checked around it.
 */
export class KnownValues implements ValueSink {
  /**
   * `under`: a set this one stands over: its values are found too, and nothing is added to it
   * (building its index of bytes may mark it full, as it would on its own). An
   * exchange's own values go in a set over the session's, so the session's can't crowd them out.
   */
  private readonly under: KnownValues | undefined;

  constructor(under?: KnownValues) {
    this.under = under;
  }

  private readonly byRun = new Map<string, Known[]>();
  private readonly values = new Set<string>();
  /** The values in the order learned, for `list`. */
  private readonly order: string[] = [];
  /** For `inBytes`: built when first needed. */
  private byFirstEight: Map<number, Map<number, Uint8Array[]>> | undefined;
  /** Each value by its first eight characters, for `anywhere`. */
  private textIndex: Map<string, string[]> | undefined;
  /** Values of 16+ characters by an eight-character window near their end (see `indexLong`). */
  private readonly longIndex = new Map<string, LongEntry[]>();
  /** Each value by its first eight characters, for `cutTail`. */
  private headIndex: Map<string, string[]> | undefined;
  /** Set when a value was turned away here, or a search asked of this set gave up (see `full`). */
  private turnedAway = false;
  /** New values each share has let in (see `share`). */
  private readonly shares = new Map<string, number>();
  /** The share `add` counts against now, if any. */
  private sharing: { name: string; max: number } | undefined;

  /**
   * Whether a value was turned away for want of room, here or in the set this one stands over (as
   * it is now), so a later secret may not be found.
   */
  get full(): boolean {
    return this.turnedAway || (this.under?.full ?? false);
  }

  /** Records that a value was turned away, or a search gave up, here: `full` says so from now on. */
  markFull(): void {
    this.turnedAway = true;
  }

  /** This set's own values, not counting the set it stands over. */
  get size(): number {
    return this.values.size;
  }

  /** Whether neither this set nor any it stands over has a value. */
  get empty(): boolean {
    return this.values.size === 0 && (this.under?.empty ?? true);
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  /**
   * Runs `learn`, letting it add at most `max` values new to this set under `name`, counted for
   * the set's life: so a URL or request body can take only part of an exchange's room. Past it a
   * new value is turned away and the set marked full.
   */
  share(name: string, max: number, learn: () => void): void {
    const before = this.sharing;
    this.sharing = { name, max };
    try {
      learn();
    } finally {
      this.sharing = before;
    }
  }

  /** Adds a value if it can be found and there is room; whether it was added. */
  add(value: string): boolean {
    if (this.values.has(value) || !distinctive(value)) return false;
    const longest = longestRun(value);
    // A value of mostly punctuation can't be found by its runs.
    if (!longest || longest.run.length < 4 || value.length > longest.run.length * MAX_LENGTH_PER_RUN) {
      return false;
    }
    const list = this.byRun.get(longest.run);
    const share = this.sharing;
    const used = share ? (this.shares.get(share.name) ?? 0) : 0;
    // Values sharing a run are checked one by one wherever it appears, so only a few are kept.
    if (
      this.values.size >= MAX_KNOWN ||
      (list && list.length >= MAX_PER_RUN) ||
      (share !== undefined && used >= share.max)
    ) {
      this.turnedAway = true;
      return false;
    }
    if (share) this.shares.set(share.name, used + 1);
    this.values.add(value);
    this.order.push(value);
    this.byFirstEight = undefined;
    this.textIndex = undefined;
    // Kept up to date as values arrive: rebuilt for each, a body teaching one per line would
    // cost its length times the values.
    this.indexLong(value);
    if (this.headIndex) indexBy(this.headIndex, value.slice(0, 8), value);
    if (list) list.push({ value, at: longest.at });
    else this.byRun.set(longest.run, [{ value, at: longest.at }]);
    return true;
  }

  /**
   * The values from position `after` in the order learned, up to about `maxChars` of text (at
   * least one, if there is one).
   */
  list(after: number, maxChars: number): string[] {
    const out: string[] = [];
    let chars = 0;
    for (let i = Math.max(0, after); i < this.order.length; i++) {
      const value = this.order[i]!;
      if (out.length > 0 && chars + value.length > maxChars) break;
      out.push(value);
      chars += value.length;
    }
    return out;
  }

  /** Adds another set's own values, in the order it learned them; `full` carries over. */
  addAll(other: KnownValues): void {
    for (const value of other.values) this.add(value);
    if (other.full) this.turnedAway = true;
  }

  /** This set and each it stands over, nearest first. */
  private chain(): KnownValues[] {
    const sets: KnownValues[] = [this];
    for (let set = this.under; set; set = set.under) sets.push(set);
    return sets;
  }

  /**
   * Spans of known values in text, as written or percent-encoded (and, in a form, with `+` for a
   * space).
   */
  scan(text: string, plusIsSpace = false): Span[] {
    if (text.length < 8) return [];
    const spans: Span[] = [];
    for (const set of this.chain()) set.scanOwn(text, plusIsSpace, this, spans);
    // The same value can be found by more than one search, or in more than one set: each span once.
    const seen = new Set<string>();
    return spans.filter((span) => {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** `scan` in this set's own values, into `spans`; a search that gives up marks `asker` full. */
  private scanOwn(text: string, plusIsSpace: boolean, asker: KnownValues, spans: Span[]): void {
    if (this.values.size === 0) return;
    for (const span of this.find(text, (i) => i)) spans.push(span);
    this.embedded(text, (i) => i, spans, asker);
    for (const match of text.matchAll(ENCODED_RUN)) {
      const run = match[0];
      const add = (found: Span[]): void => {
        for (const span of found) {
          spans.push({ ...span, start: match.index + span.start, end: match.index + span.end });
        }
      };
      if (run.includes('%') || (plusIsSpace && run.includes('+'))) {
        const { decoded, rawAt } = decodeWithMap(run, plusIsSpace);
        const found = this.find(decoded, rawAt);
        this.embedded(decoded, rawAt, found, asker);
        add(found);
      }
      // Written with JSON's escapes, as a script or a page often writes a value (a slash as
      // backslash-slash, or inside escaped JSON).
      if (run.includes('\\')) {
        const { decoded, rawAt } = undoEscapes(run);
        const found = this.find(decoded, rawAt);
        this.embedded(decoded, rawAt, found, asker);
        add(found);
      }
    }
  }

  /** Adds a value to `longIndex`, if long and varied enough; past MAX_PER_RUN alike, `full`. */
  private indexLong(value: string): void {
    if (value.length < 16) return;
    // Keyed by an eight-character window of at least four different characters, from the end
    // back: a repeated tail (`…AAAA`) would match at every position of a run of it, and a value
    // with no such window (`AAAA…==`) would match inside unrelated text, so isn't kept here. Values
    // sharing a window (`<id>.worker1`) move to the one before it, up to four times.
    let tries = 0;
    for (
      let k = variedWindowEnd(value, value.length);
      k >= 8 && tries < 4;
      k = variedWindowEnd(value, k - 8)
    ) {
      const key = value.slice(k - 8, k);
      const list = this.longIndex.get(key);
      if (!list) {
        this.longIndex.set(key, [{ value, k }]);
        return;
      }
      if (list.length < MAX_PER_RUN) {
        list.push({ value, k });
        return;
      }
      tries++;
    }
    // Turned away from full lists; a value with no varied window is just not looked for inside runs.
    if (tries > 0) this.turnedAway = true;
  }

  /**
   * Values of 16+ characters inside longer runs (`/dl/<token>_thumb.png`, `x<token>`), added to
   * `out`: long enough that a repeat is rarely chance. One pass, each position looked up by the
   * eight characters ending there; at most MAX_PER_RUN values share those, each compared from its
   * end back. The comparisons are budgeted at 40 per character of text, so the cost stays linear
   * however many calls there are; past the budget the search stops and the set asked (`asker`,
   * never one it stands over) is marked full.
   */
  private embedded(
    text: string,
    rawAt: (i: number, up: boolean) => number,
    out: Span[],
    asker: KnownValues,
  ): void {
    if (this.longIndex.size === 0 || text.length < 16) return;
    let budget = text.length * 40;
    for (let at = 8; at <= text.length; at++) {
      const list = this.longIndex.get(text.slice(at - 8, at));
      if (!list) continue;
      for (const { value, k } of list) {
        const start = at - k;
        const end = start + value.length;
        if (start < 0 || end > text.length) continue;
        let i = value.length - 1;
        while (i >= 0 && text.charCodeAt(start + i) === value.charCodeAt(i)) i--;
        budget -= value.length - i;
        if (budget < 0) {
          // Text built to near-match long values everywhere: said, not silently given up.
          asker.turnedAway = true;
          return;
        }
        if (i < 0) out.push({ start: rawAt(start, false), end: rawAt(end, true), kind: 'known value' });
      }
    }
  }

  /**
   * At the end of a body that was cut off, the tail that begins a known value (or is one): 8+
   * characters of it in the text's last run, which may be that value cut short. The run is read
   * back to whitespace, a quote or an angle bracket, and no further than 4,096 characters, so a
   * value with a space is caught only if the cut falls in its first word. Each candidate is
   * compared from the tail's end back, where values that share a start (tokens from one issuer)
   * differ.
   */
  cutTail(text: string): Span[] {
    if (text.length < 8) return [];
    // The earliest start found in any set: the longest tail hidden.
    let best: Span | undefined;
    for (const set of this.chain()) {
      const found = set.cutTailOwn(text);
      if (found && (!best || found.start < best.start)) best = found;
    }
    return best ? [best] : [];
  }

  /** `cutTail` in this set's own values. */
  private cutTailOwn(text: string): Span | undefined {
    if (this.values.size === 0) return undefined;
    if (!this.headIndex) {
      this.headIndex = new Map();
      for (const value of this.values) indexBy(this.headIndex, value.slice(0, 8), value);
    }
    let runStart = text.length;
    while (
      runStart > 0 &&
      text.length - runStart < MAX_KNOWN_LENGTH &&
      !/[\s"'<>]/.test(text[runStart - 1]!)
    ) {
      runStart--;
    }
    let budget = (text.length - runStart) * 16 + 100_000;
    for (let start = runStart; start <= text.length - 8; start++) {
      const tail = text.length - start;
      for (const value of this.headIndex.get(text.slice(start, start + 8)) ?? []) {
        if (value.length < tail) continue;
        // The first eight match already.
        let i = tail - 1;
        while (i >= 8 && text.charCodeAt(start + i) === value.charCodeAt(i)) i--;
        budget -= tail - i;
        // Past the budget, the tail is hidden: a cut end is short, and hiding it costs little.
        if (budget < 0 || i < 8) return { start, end: text.length, kind: 'known value' };
      }
    }
    return undefined;
  }

  /**
   * Spans of known values anywhere in text, even joined to other characters (`id-<token>`): for
   * short fields such as a URL or a header, where a repeat is rarely chance. One pass, each position
   * looked up by the eight characters from it.
   */
  anywhere(text: string): Span[] {
    if (text.length < 8) return [];
    const spans: Span[] = [];
    for (const set of this.chain()) {
      const found = set.anywhereOwn(text);
      // Too costly to check in any set: all of it hidden.
      if (found === undefined) return [{ start: 0, end: text.length, kind: 'known value' }];
      for (const span of found) spans.push(span);
    }
    return spans;
  }

  /** `anywhere` in this set's own values; undefined if it would cost too much. */
  private anywhereOwn(text: string): Span[] | undefined {
    if (this.values.size === 0) return [];
    if (!this.textIndex) {
      this.textIndex = new Map();
      for (const value of this.values) {
        // By its end: tokens from one issuer share a start (`eyJhbGci`), rarely an end.
        const key = value.slice(-8);
        const list = this.textIndex.get(key);
        if (list) list.push(value);
        else this.textIndex.set(key, [value]);
      }
    }
    const spans = this.within(text, (i) => i);
    if (!spans) return undefined;
    for (const match of text.matchAll(ENCODED_RUN)) {
      const run = match[0];
      if (!run.includes('%')) continue;
      const { decoded, rawAt } = decodeWithMap(run);
      const found = this.within(decoded, rawAt);
      if (!found) return undefined;
      for (const span of found) {
        spans.push({ ...span, start: match.index + span.start, end: match.index + span.end });
      }
    }
    return spans;
  }

  /**
   * Known values in `text`, wherever they sit; undefined if comparing them would cost too much,
   * as text built to nearly match many long values does: the caller then hides all of it.
   */
  private within(text: string, rawAt: (i: number, up: boolean) => number): Span[] | undefined {
    const spans: Span[] = [];
    let budget = text.length * 8 + 1_000_000;
    for (let end = 8; end <= text.length; end++) {
      for (const value of this.textIndex!.get(text.slice(end - 8, end)) ?? []) {
        const start = end - value.length;
        // Charged for what's really compared, so values that merely end alike can't use it up.
        let same = 0;
        if (start >= 0) {
          while (same < value.length && text.charCodeAt(start + same) === value.charCodeAt(same)) same++;
        }
        budget -= same + 1;
        if (budget < 0) return undefined;
        if (same === value.length) {
          spans.push({ start: rawAt(start, false), end: rawAt(end, true), kind: 'known value' });
        }
      }
    }
    return spans;
  }

  /**
   * Whether a known value's UTF-8 bytes are anywhere in these bytes, even inside a longer run:
   * for a body that isn't text, where a value sits between arbitrary bytes (a length, a field
   * tag) and finding one means leaving the body out. One pass, each position looked up by the
   * eight bytes from it; at most a few values share those, so it stays linear.
   */
  inBytes(bytes: Uint8Array): boolean {
    if (bytes.length < 8) return false;
    return this.chain().some((set) => set.inBytesOwn(bytes));
  }

  /**
   * `inBytes` in this set's own values. Values too alike to index mark this set full, which a set
   * over it reports too.
   */
  private inBytesOwn(bytes: Uint8Array): boolean {
    if (this.values.size === 0) return false;
    const index = this.bytesIndex();
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < bytes.length; i++) {
      hi = ((hi << 8) | (lo >>> 24)) >>> 0;
      lo = ((lo << 8) | bytes[i]!) >>> 0;
      if (i < 7) continue;
      const candidates = index.get(hi)?.get(lo);
      if (!candidates) continue;
      const start = i - 7;
      for (const value of candidates) {
        if (start + value.length > bytes.length) continue;
        // The first eight match already.
        let k = 8;
        while (k < value.length && bytes[start + k] === value[k]) k++;
        if (k === value.length) return true;
      }
    }
    return false;
  }

  /** Each value's UTF-8 bytes, by their first four bytes and then the next four. */
  private bytesIndex(): Map<number, Map<number, Uint8Array[]>> {
    if (this.byFirstEight) return this.byFirstEight;
    const index = new Map<number, Map<number, Uint8Array[]>>();
    const encoder = new TextEncoder();
    const word = (b: Uint8Array, at: number): number =>
      ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    for (const value of this.values) {
      const encoded = encoder.encode(value);
      // Found by eight bytes: `distinctive` keeps none shorter, but don't rely on it.
      if (encoded.length < 8) continue;
      const hi = word(encoded, 0);
      const lo = word(encoded, 4);
      let inner = index.get(hi);
      if (!inner) index.set(hi, (inner = new Map()));
      const list = inner.get(lo);
      if (!list) inner.set(lo, [encoded]);
      else if (list.length < MAX_PER_RUN) list.push(encoded);
      // Too many alike to check at every position: one may go unfound in bytes.
      else this.turnedAway = true;
    }
    this.byFirstEight = index;
    return index;
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

/**
 * The end of a quoted value starting after `open` at `from`, honouring backslashes: its closing
 * quote. -1 if a line break or the text's end comes first, within MAX_VALUE characters; -2 if
 * neither comes within them (see longValueEnd).
 */
function closingQuote(text: string, from: number, quote: string): number {
  const limit = Math.min(text.length, from + MAX_VALUE);
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote) return i;
    else if (c === '\n') return -1;
  }
  return limit < text.length ? -2 : -1;
}

/**
 * Where a quoted value that ran past MAX_VALUE ends: its closing quote, else the line break or the
 * text's end. Fails closed: all of it is redacted, not just the first 4 KB or none of it.
 */
function longValueEnd(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote || c === '\n') return i;
  }
  return text.length;
}

/**
 * Where an unquoted value starting at `start` ends: at whitespace, `&`, markup or a quote, less a
 * sentence's full stop, a list's comma or a closing bracket.
 */
function unquotedEnd(text: string, start: number): number {
  let end = start;
  // No limit: a long value is redacted whole. The caller reads each character about once.
  while (end < text.length && !/[\s&<>"']/.test(text[end]!)) end++;
  while (end > start && /[.,;)}\]]/.test(text[end - 1]!)) end--;
  return end;
}

/**
 * After an unquoted scheme word at `text[from, end)` (`ApiKey`, `svc`), the credential that follows
 * on the same line, if it ends the line and looks like one (see `schemeAndCredential`), or
 * undefined. Up to 64 spaces or tabs come between them, and after it only spaces, tabs and
 * closing punctuation. Not another `name=value` field.
 */
function credentialAfterScheme(
  text: string,
  from: number,
  end: number,
): { start: number; end: number } | undefined {
  // Checked again below; here only so most values aren't followed into the next word.
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(text.slice(from, end))) return undefined;
  let start = end;
  while (start < text.length && start - end < 64 && (text[start] === ' ' || text[start] === '\t')) start++;
  if (start === end || start >= text.length) return undefined;
  const credentialEnd = unquotedEnd(text, start);
  // `name=value` is a log line's next field (`token=<token> session=…`), not a credential; base64's
  // `=` padding at the end is not that.
  if (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}=(?!=*$)/.test(text.slice(start, credentialEnd))) return undefined;
  // Then only spaces, tabs and closing punctuation (`{auth: ApiKey <key>}`) before the line ends.
  let after = credentialEnd;
  while (after < text.length && /[ \t.,;)}\]]/.test(text[after]!)) after++;
  if (after < text.length && text[after] !== '\n' && text[after] !== '\r') return undefined;
  const found = schemeAndCredential(text.slice(from, credentialEnd));
  return found ? { start: from + found.from, end: from + found.from + found.credential.length } : undefined;
}

/**
 * The assignment rule: a strong secret name (a password's, a secret's or a token's) followed by
 * `=` or `:` and a value, as in logs and config: `password=…`, `api_key: …`, `"token": "…"`. A
 * quoted value runs to its closing quote; an unquoted one to whitespace or `&`, needs 6+
 * characters, none of `( ) { } < > $` (code, not a value), and isn't a word like `null` or
 * `string`. A scheme and a credential (`auth: ApiKey <key>`, `token = "ApiKey <key>"`) keep the
 * scheme and lose the credential under a token name, and lose both under a password or secret
 * name.
 */
export function assignmentSpans(text: string, cut = false): Span[] {
  const spans: Span[] = [];
  // How far values have been read. An assignment starting inside one already read is part of that
  // value (`password=password=…`): skipped, so each character is read about once, not once for
  // every assignment before it.
  let readTo = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (match.index < readTo) continue;
    const name = match[2]!;
    const family = secretName(name, 'json');
    if (!family || !STRONG_FAMILIES.has(family)) continue;
    const from = match.index + match[0].length;
    const quote = text[from];
    if (quote === '"' || quote === "'") {
      const start = from + 1;
      let end = closingQuote(text, start, quote);
      // Past MAX_VALUE with no line break: a long value, redacted to wherever it ends.
      if (end === -2) end = longValueEnd(text, start, quote);
      // Cut off inside the value: it runs to the end of what was kept.
      else if (end < 0 && cut && !text.includes('\n', start)) end = text.length;
      // An unclosed quote isn't marked: a later match brings a quote of its own kind, which ends
      // the search, so a long search happens at most once per kind of quote.
      readTo = end;
      if (end <= start || STOP_WORDS.has(text.slice(start, end).toLowerCase())) continue;
      // Under a token name, a scheme and a credential (`auth = "ApiKey <key>"`): the credential,
      // the scheme kept, as in JSON. Under a password or secret name the whole value goes, so a
      // password with a space never shows its first word.
      const scheme =
        family === 'token' && end - start <= MAX_VALUE + 64
          ? schemeAndCredential(text.slice(start, end))
          : undefined;
      if (scheme) {
        const at = start + scheme.from;
        spans.push({ start: at, end: at + scheme.credential.length, kind: 'name', name });
        continue;
      }
      spans.push({ start, end, kind: 'name', name });
      continue;
    }
    // A quoted name and a whole number ending where a value ends: after a double-quoted name (JSON),
    // written back quoted so the JSON stays valid; after a single-quoted one, as it is.
    const scalar =
      match[1] !== ''
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
        ...(match[1] === '"' ? { replacement: `"${REDACTED}"` } : {}),
      });
      continue;
    }
    const end = unquotedEnd(text, from);
    readTo = end;
    const value = text.slice(from, end);
    // A scheme and a credential, unquoted, ending the line (`auth: ApiKey <key>`): the credential
    // under a token name, the scheme kept; both words under a password or secret name.
    const credential = credentialAfterScheme(text, from, end);
    if (credential) {
      readTo = credential.end;
      spans.push({
        start: family === 'token' ? credential.start : from,
        end: credential.end,
        kind: 'name',
        name,
      });
      continue;
    }
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
  /** A pair's secret name: `{"name":"Cookie","value":"…"}` or `["Cookie","…"]` in a list. */
  pair?: PairName;
  /** Inside a pair's value: the pair, which every value below here is masked under. */
  under?: PairName;
  /** In an array: the index of the item being read. */
  index?: number;
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

/** Keys that name a pair's value, in any case: `{"Key":"password","Value":"…"}`. */
const PAIR_NAME_KEYS: ReadonlySet<string> = new Set(['name', 'key', 'header', 'field']);
/**
 * Keys that name a pair only for passwords and secrets (`{"type":"password","value":"…"}`). These
 * keys often hold plain labels: `{"type":"token","value":"Hello"}` is a streamed word.
 */
const PAIR_WEAK_NAME_KEYS: ReadonlySet<string> = new Set([
  'type',
  'id',
  'label',
  'k',
  'param',
  'parameter',
  'property',
  'attribute',
]);
/** Keys holding a pair's value, in any case. */
const PAIR_VALUE_KEYS: ReadonlySet<string> = new Set(['value', 'val', 'values', 'v']);
/** Longest raw key that can be a pair key, with room for every letter written as `\uXXXX`. */
const MAX_PAIR_KEY = 64;
/** What a redaction records for a pair: its name is free text, which may itself hold a secret. */
const PAIR_LABEL = 'name/value pair';

/** A name/value pair with a secret name, judged once however many values it holds. */
/** Whether a key can hold the name of a name/value pair (`name`, `key`, `type`…), in any case. */
export function isPairNameKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PAIR_NAME_KEYS.has(lower) || PAIR_WEAK_NAME_KEYS.has(lower);
}

interface PairName {
  /** The name to record: a standard header's, else {@link PAIR_LABEL}. */
  label: string;
  family: SecretFamily;
  /** Whether its value is written as this header's: a cookie's names kept, a scheme kept. */
  header?: string;
}

/**
 * Where each name/value pair with a secret name starts, and that name. Found before the walk so a
 * value is masked even when it comes before its name. One pass, tolerant of a body cut short: an
 * object counts from its name, a `["name", value]` item of a list once it has two items.
 */
function pairNames(text: string): Map<number, PairName> {
  interface Open {
    kind: 'object' | 'array';
    start: number;
    inList: boolean;
    expectKey: boolean;
    nameKey?: 'strong' | 'weak';
    commas: number;
    first?: PairName;
  }
  const found = new Map<number, PairName>();
  const stack: Open[] = [];
  const closeTuple = (open: Open): void => {
    if (open.kind === 'array' && open.inList && open.commas === 1 && open.first !== undefined) {
      found.set(open.start, open.first);
    }
  };
  const secret = (raw: string, weak: boolean): PairName | undefined => {
    const name = decodeJsonString(raw)?.decoded;
    if (name === undefined) return undefined;
    const lower = name.toLowerCase();
    // Header names are matched in any case; word splitting would break `AuThOrIzAtIoN`.
    const family = secretName(HEADER_KEYS.has(lower) ? lower : name, 'header');
    if (!family || (weak && !SCALAR_FAMILIES.has(family))) return undefined;
    return {
      label: HEADER_KEYS.has(lower) ? name : PAIR_LABEL,
      family,
      ...(HEADER_KEYS.has(lower) ? { header: lower } : {}),
    };
  };
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const top = stack.at(-1);
    if (c === 0x22) {
      let end = i + 1;
      while (end < n && text.charCodeAt(end) !== 0x22) end += text.charCodeAt(end) === 0x5c ? 2 : 1;
      if (end >= n) break;
      const raw = text.slice(i + 1, end);
      if (top?.kind === 'object' && top.expectKey) {
        const key = raw.length <= MAX_PAIR_KEY ? decodeJsonString(raw)?.decoded.toLowerCase() : undefined;
        top.nameKey =
          key === undefined
            ? undefined
            : PAIR_NAME_KEYS.has(key)
              ? 'strong'
              : PAIR_WEAK_NAME_KEYS.has(key)
                ? 'weak'
                : undefined;
        top.expectKey = false;
      } else if (top?.kind === 'object' && top.nameKey) {
        const pair = secret(raw, top.nameKey === 'weak');
        if (pair && !found.has(top.start)) found.set(top.start, pair);
      } else if (top?.kind === 'array' && top.commas === 0) {
        top.first = secret(raw, false);
      }
      i = end;
    } else if (c === 0x7b || c === 0x5b) {
      if (stack.length >= MAX_DEPTH) break;
      stack.push({
        kind: c === 0x7b ? 'object' : 'array',
        start: i,
        inList: top?.kind === 'array',
        expectKey: c === 0x7b,
        commas: 0,
      });
    } else if (c === 0x7d || c === 0x5d) {
      const open = stack.pop();
      if (open) closeTuple(open);
    } else if (c === 0x2c && top) {
      top.commas++;
      if (top.kind === 'object') top.expectKey = true;
    }
  }
  for (const open of stack) closeTuple(open);
  return found;
}

/** Families whose numbers are secrets too (a PIN, a card code); tokens' aren't. */
const SCALAR_FAMILIES: ReadonlySet<SecretFamily> = new Set(['password', 'secret']);
/**
 * Families whose short or spaced strings are kept whole in JSON (a logprob's `"token": "Hello"`),
 * except a credential after a scheme (see `schemeAndCredential`).
 */
const LONG_ONLY_FAMILIES: ReadonlySet<SecretFamily> = new Set(['token', 'session']);

/**
 * A scheme and a credential (`ApiKey <key>`, `svc <key>`): one word of up to 32 characters, white
 * space, then one more run with none, which is the credential if it's 16+ characters of
 * `[A-Za-z0-9._~+/=-]` with letters and digits, or too long to judge (past 4,096 characters).
 * Where the credential starts, or undefined. If the first word is distinctive enough to be a token
 * itself, both words are returned as the credential. Read by hand, not by one pattern: a pattern over a
 * credential megabytes long overflows the stack.
 */
function schemeAndCredential(text: string): { from: number; credential: string } | undefined {
  let i = 0;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  const word = /^[A-Za-z][A-Za-z0-9_.-]{0,31}/.exec(text.slice(i, i + 33));
  if (!word) return undefined;
  i += word[0].length;
  const gap = i;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (i === gap || i === text.length) return undefined;
  let end = text.length;
  while (end > i && /\s/.test(text[end - 1]!)) end--;
  const credential = text.slice(i, end);
  const looksLike =
    credential.length > MAX_VALUE
      ? !/\s/.test(credential)
      : credential.length >= 16 &&
        /^[A-Za-z0-9._~+/=-]+$/.test(credential) &&
        /[A-Za-z]/.test(credential) &&
        /\d/.test(credential);
  if (!looksLike) return undefined;
  // A first word distinctive enough to be a token isn't a scheme: both words are the secret.
  const wordStart = gap - word[0].length;
  if (distinctive(word[0])) return { from: wordStart, credential: text.slice(wordStart, end) };
  return { from: i, credential };
}

/**
 * Spans in a JSON document, or undefined if it isn't one. Values under secret names are redacted
 * in place (a number becomes `"[redacted]"`); everything else stays byte for byte as it was. Then
 * the text rules and the known values run inside every string, and JSON inside a string is looked
 * into. Walked without building it, and without recursion.
 */
export function jsonSpans(text: string, known?: KnownValues, depth = 0, cut = false): Span[] | undefined {
  const spans: Span[] = [];
  const stack: Frame[] = [];
  const pairs = pairNames(text);
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
      i++;
    }
  };
  /** The secret name of the pair whose value is at the current position, if any. */
  const pairHere = (): PairName | undefined => {
    const frame = stack.at(-1);
    if (!frame) return undefined;
    if (frame.under !== undefined) return frame.under;
    if (frame.pair === undefined) return undefined;
    const isValue =
      frame.kind === 'object' ? PAIR_VALUE_KEYS.has((frame.key ?? '').toLowerCase()) : frame.index === 1;
    return isValue ? frame.pair : undefined;
  };
  /** The family a value at the current position takes, from its pair, key or container. */
  const familyHere = (): SecretFamily | undefined => {
    const frame = stack.at(-1);
    if (!frame) return undefined;
    const pair = pairHere();
    if (pair !== undefined) return pair.family;
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
    const pair = pairHere();
    if (pair !== undefined) return pair.label;
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
    // A header's value: a pair's, in any order or shape, under its name, or in an array under it.
    const pair = pairHere();
    if (pair && decoded.trim() === '') return true;
    if (pair && !pair.header) {
      // A pair's name says the whole value is the secret, whatever its length or spaces.
      spans.push({ start, end, kind: 'name', name: pair.label });
      if (known && STRONG_FAMILIES.has(pair.family)) addValue(known, decoded.trim());
      return true;
    }
    const header =
      pair?.header ??
      (frame?.kind === 'array' ? frame.headerKey : HEADER_KEYS.has(key.toLowerCase()) ? key : undefined);
    if (header && decoded !== '') {
      // As the header itself would be: a cookie's name kept, an authorization's scheme. The whole
      // string is written back, so escapes in its kept parts may change; it stays valid JSON.
      const redacted = redactHeader(header, decoded, known).value;
      if (redacted !== decoded) {
        spans.push({
          start,
          end,
          kind: 'name',
          name: pair?.label ?? header,
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
      // A scheme and a credential (`"auth": "ApiKey <key>"`): the credential, the scheme kept.
      // The shapes and known values below still look at the whole string.
      const scheme = schemeAndCredential(decoded);
      if (scheme) {
        spans.push({
          start: start + rawAt(scheme.from),
          end: start + rawAt(scheme.from + scheme.credential.length),
          kind: 'name',
          name: nameHere(),
        });
        if (known && ownStrong() && credentialLike(scheme.credential)) addValue(known, scheme.credential);
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
  /**
   * Where the walk can't go on. For a body cut short (`cut`), the spans found so far are kept,
   * and the rest from here gets the text rules; otherwise it isn't JSON.
   */
  const fail = (): Span[] | undefined => {
    if (!cut) return undefined;
    for (const span of plainSpans(text.slice(i), known, true))
      spans.push({ ...span, start: i + span.start, end: i + span.end });
    return spans;
  };
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
        if (c !== '"') return fail();
        const end = stringEnd();
        if (end < 0) return fail();
        const decodedKey = decodeJsonString(text.slice(i + 1, end - 1));
        if (decodedKey === undefined) return fail();
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
        if (text[i] !== ':') return fail();
        i++;
        frame.expectKey = false;
        needValue = true;
        continue;
      }
    } else if (needValue) {
      const family = familyHere();
      if (c === '{' || c === '[') {
        if (stack.length >= MAX_DEPTH) return fail();
        // An object under a secret name gives its direct values that name's rule; an array, its
        // items. Deeper containers judge by their own keys.
        const own = frame?.kind === 'object' ? nameRule(frame.key ?? '', 'json') : undefined;
        // An object in a secret-named array passes the rule on to its key, value or ID only.
        const inArray = c === '{' && frame?.kind === 'array' && frame.inherit !== undefined;
        const inherit = c === '[' || inArray ? family : own && own !== 'describes' ? own : undefined;
        const inheritName = inherit ? nameHere() : undefined;
        const under = pairHere();
        const pair = pairs.get(i);
        stack.push(
          c === '{'
            ? {
                kind: 'object',
                inherit,
                inheritName,
                under,
                pair,
                expectKey: true,
                ...(inArray ? { inheritOnly: VALUE_KEYS } : {}),
              }
            : {
                kind: 'array',
                inherit,
                inheritName,
                under,
                pair,
                index: 0,
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
        if (end < 0) {
          // Cut inside a string under a secret name: redacted to the end.
          if (cut && family && i + 1 < n)
            spans.push({ start: i + 1, end: n, kind: 'name', name: nameHere() });
          return fail();
        }
        if (!stringValue(i + 1, end - 1, family)) return fail();
        i = end;
      } else {
        const scalar = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
          text.slice(i, i + 400),
        );
        if (!scalar) return fail();
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
      if (!frame) return fail();
      if (c === ',') {
        i++;
        if (frame.kind === 'object') {
          frame.expectKey = true;
          frame.key = undefined;
          ws();
          if (text[i] !== '"') return fail();
        } else {
          frame.index = (frame.index ?? 0) + 1;
          needValue = true;
        }
        continue;
      }
      if ((c === '}' && frame.kind === 'object') || (c === ']' && frame.kind === 'array')) {
        stack.pop();
        i++;
        continue;
      }
      return fail();
    }
    if (stack.length === 0 && !needValue) {
      ws();
      return i >= n ? spans : fail();
    }
  }
  return (stack.length === 0 && !needValue) || cut ? spans : undefined;
}

// ---------------------------------------------------------------- tags (XML and HTML)

/** Tags and quoted attribute values up to 256 KB: a SAML form's hidden input runs to 20 KB. */
const MAX_TAG = 262_144;

interface Tag {
  index: number;
  name: string;
  /** What's between the name and the `>`: the attributes. */
  body: string;
  bodyStart: number;
  /** The index after the `>`. */
  end: number;
}

/** The first `>` in `text[from, to)`, or -1. */
function firstGreaterThan(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) if (text[i] === '>') return i;
  return -1;
}

/**
 * Where a tag whose attributes start at `from` ends (its `>`), or -1. A `>` inside a quoted
 * value (`data-x="a>b"`) is the value's. A quote counts only after `=` and any whitespace, as an
 * attribute's value starts, and only if it closes before the next `<`, so a `<` inside a quoted
 * value (`placeholder="<enter>"`) isn't read through: a known limit, as before. If the quotes
 * don't work out before the next `<` (`title="> He said "hi" <br>`), the tag ends at its first
 * `>`, as one read without quotes would. Nothing is read past the next `<`.
 */
function tagEnd(text: string, from: number): number {
  // Attributes up to MAX_TAG characters, then the `>`.
  const limit = Math.min(text.length, from + MAX_TAG + 1);
  let i = from;
  while (i < limit) {
    const c = text[i];
    if (c === '>') return i;
    if (c === '<') return firstGreaterThan(text, from, i);
    i++;
    if (c !== '=') continue;
    while (i < limit && /\s/.test(text[i]!)) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    let close = i + 1;
    while (close < limit && text[close] !== quote && text[close] !== '<') close++;
    if (close < limit && text[close] === quote) i = close + 1;
    else i++;
  }
  return firstGreaterThan(text, from, limit);
}

/**
 * The tags in text (`<name attributes>`), in order. Each is read no further than the next `<`, so
 * the text is read about once.
 */
function* tagsIn(text: string): Generator<Tag> {
  const start = /<([A-Za-z][\w:.-]{0,63})/g;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const bodyStart = match.index + match[0].length;
    const end = tagEnd(text, bodyStart);
    if (end < 0) continue;
    yield { index: match.index, name: match[1]!, body: text.slice(bodyStart, end), bodyStart, end: end + 1 };
    start.lastIndex = end + 1;
  }
}
/** Unquoted attribute values are read this far by the pattern; a longer one is read on in code. */
const MAX_UNQUOTED_ATTRIBUTE = 4096;
const ATTRIBUTE = new RegExp(
  `([A-Za-z_:][\\w:.-]{0,63})\\s*=\\s*(?:"([^"]{0,262144})"|'([^']{0,262144})'|([^\\s"'<>\`=]{1,${MAX_UNQUOTED_ATTRIBUTE}}))`,
  'g',
);

interface Attribute {
  name: string;
  value: string;
  start: number;
  end: number;
}

function attributesOf(tag: string, offset: number): Attribute[] {
  const out: Attribute[] = [];
  // The shared pattern, from the start: nothing else uses it while this runs.
  const pattern = ATTRIBUTE;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(tag); match; match = pattern.exec(tag)) {
    const group = match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
    let value = match[group]!;
    const quoted = group !== 4;
    const start = offset + match.index + match[0].length - value.length - (quoted ? 1 : 0);
    // An unquoted value at its bound runs on to whitespace or the tag's end: taken whole.
    if (!quoted && value.length === MAX_UNQUOTED_ATTRIBUTE) {
      let end = match.index + match[0].length;
      while (end < tag.length && !/[\s"'<>`]/.test(tag[end]!)) end++;
      value = tag.slice(start - offset, end);
      // The next attribute is looked for after it, not inside it.
      pattern.lastIndex = end;
    }
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
  for (const tag of tagsIn(text)) {
    const attributes = attributesOf(tag.body, tag.bodyStart);
    const named = attributes.find((a) => /^(?:name|key|property)$/i.test(a.name));
    // A password field is one whatever its name.
    const isPassword =
      /^input$/i.test(tag.name) &&
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

const CDATA_OPEN = '<![CDATA[';

/**
 * A search for `needle` from a position, remembering its last answer: a later search from inside
 * the stretch it read finds the same, so many searches from close together cost one.
 */
function rememberedSearch(text: string, needle: string): (from: number) => number {
  let searchedFrom = -1;
  let foundAt = -1;
  return (from) => {
    if (searchedFrom < 0 || from < searchedFrom || (foundAt >= 0 && from > foundAt)) {
      searchedFrom = from;
      foundAt = text.indexOf(needle, from);
    }
    return foundAt;
  };
}

/**
 * For text with comments in it, where the comments starting at a `<!--` run to: the next `<` after
 * them that doesn't start another, -1 if there's none, or the text's length if one never closes.
 * Every comment's end is found in one pass, when first needed, and where each end leads is
 * remembered, so each comment is walked once however many elements' text reaches it (as elements
 * inside one long comment all do).
 */
function commentWalker(text: string): (at: number) => number {
  let ends: number[] | undefined;
  const endFrom = (from: number): number => {
    if (!ends) {
      ends = [];
      for (let at = text.indexOf('-->'); at >= 0; at = text.indexOf('-->', at + 1)) ends.push(at);
    }
    let low = 0;
    let high = ends.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ends[middle]! < from) low = middle + 1;
      else high = middle;
    }
    return low < ends.length ? ends[low]! : -1;
  };
  const leadsTo = new Map<number, number>();
  return (at) => {
    const passed: number[] = [];
    let result: number;
    for (let comment = at; ;) {
      const end = endFrom(comment + 4);
      if (end < 0) {
        result = text.length;
        break;
      }
      const known = leadsTo.get(end);
      if (known !== undefined) {
        result = known;
        break;
      }
      passed.push(end);
      const next = text.indexOf('<', end + 3);
      if (next < 0 || !text.startsWith('<!--', next)) {
        result = next;
        break;
      }
      comment = next;
    }
    for (const end of passed) leadsTo.set(end, result);
    return result;
  };
}

/**
 * Elements whose text is a secret, redacted: by the element's name (`<Password>…</Password>`,
 * `<wsse:Password>`), or in XML by its `key` or `name` attribute (`<entry key="password">…</entry>`). In
 * HTML only a `<textarea>` with a secret `name` counts: a link or button named for a password
 * holds words, not one. Plain text or one CDATA section, after any whitespace; comments before the
 * close tag are redacted with it. Only text found by the element's own name is added to the known
 * values. Known limits: a comment before a CDATA section, and processing instructions
 * (`<?pi?>`) in the text, leave an element unread.
 */
export function xmlElementSpans(text: string, sink?: ValueSink, html = false): Span[] {
  const spans: Span[] = [];
  // The search for the end of a CDATA section past a window: many left unclosed cost one search.
  const cdataEndFrom = rememberedSearch(text, ']]>');
  const pastComments = commentWalker(text);
  for (const tag of tagsIn(text)) {
    // An element's start: its name, then attributes after whitespace, or none. In XML, not one
    // that closes itself (`<Password/>`, `<Password />`), which has no text; HTML ignores that `/`
    // (`<textarea name="password" />…</textarea>` still holds text).
    if (tag.body !== '' && !/^\s/.test(tag.body)) continue;
    if (!html && tag.body.endsWith('/')) continue;
    const name = tag.name;
    const byOwnName = html ? undefined : secretName(localName(name), 'json');
    let family: SecretFamily | undefined = byOwnName;
    let named: Attribute | undefined;
    if (!family) {
      const attributes = tag.body ? attributesOf(tag.body, tag.bodyStart) : [];
      named = html
        ? /^textarea$/i.test(name)
          ? attributes.find((a) => /^name$/i.test(a.name))
          : undefined
        : attributes.find((a) => /^(?:key|name)$/i.test(a.name));
      family = named ? secretName(named.value, 'form') : undefined;
    }
    if (!family) continue;
    // The text, searched for its end only so far: an unclosed one isn't read to the body's end.
    let start = tag.end;
    const windowEnd = start + 64 + CDATA_OPEN.length + MAX_VALUE + 3;
    const window = text.slice(start, windowEnd);
    // Text running past the window is a long value: redacted to where it ends, or to the text's
    // end if it never does (fails closed), never shown in part.
    const long = windowEnd < text.length;
    const lead = /^\s{0,64}/.exec(window)![0].length;
    let close: number;
    // Where the first comment in plain text starts, if there is one.
    let firstComment = -1;
    const cdata = window.startsWith(CDATA_OPEN, lead);
    if (cdata) {
      let cdataEnd = window.indexOf(']]>', lead + CDATA_OPEN.length);
      // A long section is redacted to its `]]>` even when another element's close follows it.
      let farEnd = false;
      if (cdataEnd < 0 && long) {
        const far = cdataEndFrom(windowEnd - 2);
        cdataEnd = far < 0 ? text.length - start : far - start;
        farEnd = true;
      }
      const after = start + cdataEnd + 3;
      const gap = /^\s{0,64}/.exec(text.slice(after, after + 64))![0].length;
      // Comments may come between the section and the close.
      let closeAt = after + gap;
      if (!farEnd && text.startsWith('<!--', closeAt)) closeAt = pastComments(closeAt);
      // A comment never closed runs to the text's end, and the section is redacted all the same,
      // as it is when the body ends right after the section (fails closed).
      const closed = closeAt === text.length || text.startsWith(`</${name}`, closeAt);
      if (cdataEnd < 0 || (!farEnd && (closeAt < 0 || !closed))) continue;
      close = start + cdataEnd;
      start += lead + CDATA_OPEN.length;
    } else {
      let lt = window.indexOf('<');
      // The next `<` is no further than the next element (or comment), so this search reads the
      // text about once.
      if (lt < 0 && long) {
        const far = text.indexOf('<', windowEnd);
        lt = far < 0 ? text.length - start : far - start;
      }
      // Comments before the close (`<Password>…<!-- note --></Password>`) are passed over and
      // redacted with the text. One never closed runs to the text's end, and so does the text.
      if (lt >= 0 && start + lt < text.length && text.startsWith('<!--', start + lt)) {
        firstComment = start + lt;
        const past = pastComments(start + lt);
        lt = past < 0 ? -1 : past - start;
      }
      const toEnd = lt >= 0 && start + lt === text.length;
      if (lt < 0 || (!toEnd && !text.startsWith(`</${name}`, start + lt))) continue;
      close = start + lt;
    }
    if (close === start) continue;
    // The value: plain text without its comments, which are redacted with it but aren't the value
    // (one left open runs to the end). A long one isn't stripped, which would be a pass over all
    // of it: it's taken to its first comment, or whole if a comment comes first. In CDATA, `<!--`
    // is just text.
    const raw = text.slice(start, close);
    const stripped = cdata
      ? raw
      : close - start <= MAX_VALUE + 1024
        ? raw.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        : firstComment >= 0 && text.slice(start, firstComment).trim() !== ''
          ? text.slice(start, firstComment)
          : raw;
    const value = stripped.trim();
    if (value === '') continue;
    // Named by an XML `name` attribute (`<property name="…password">`), only text that is one
    // token: `<string name="error_token">Your token expired</string>` is words.
    if (named && /^name$/i.test(named.name) && /\s/.test(value)) continue;
    spans.push({ start, end: close, kind: 'name', name: named?.value ?? localName(name) });
    if (sink && byOwnName && STRONG_FAMILIES.has(byOwnName)) addValue(sink, value);
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

/**
 * Whether a body of this media type is text, to be redacted: text of any kind, JSON, XML,
 * JavaScript, forms, multipart, and the like. Anything else (images, archives, protocol buffers)
 * isn't scanned. An unknown or missing type counts as text only to the caller who has looked at
 * the bytes.
 */
export function isTextual(mediaType: string | undefined): boolean {
  const type = (mediaType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('text/') || type.startsWith('multipart/')) return true;
  return /(?:^application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|x-ndjson|jsonl|json-seq|x-jsonlines|stream\+json|yaml|x-yaml|csv|graphql|graphql-response\+json|x-javascript|sql|xhtml\+xml|ld\+json|problem\+json|soap\+xml|atom\+xml|rss\+xml)$)|\+(?:json|xml)$/.test(
    type,
  );
}

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
    // A header folded onto more lines (`form-data;\r\n name="password"`) is read as one.
    const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
    const disposition = /^content-disposition:([^\r\n]{0,1024})/im.exec(unfolded)?.[1] ?? '';
    // `name=`, quoted or not, and not the end of `filename=`.
    const nameMatch = /(?:^|[;\s])name=(?:"([^"]{0,256})"|([^;\s]{1,256}))/i.exec(disposition);
    const name = nameMatch ? (nameMatch[1] ?? nameMatch[2]) : undefined;
    const isFile = /filename\*?=/i.test(disposition);
    const partType = /^content-type:[ \t]*([^\r\n]{1,256})/im.exec(unfolded)?.[1];
    if (bodyEnd > blank) {
      const family = name !== undefined ? secretName(name, 'form') : undefined;
      if (family) {
        // A secret-named field or file (an uploaded private key) is redacted whole.
        spans.push({ start: blank, end: bodyEnd, kind: 'name', name });
        if (known && !isFile && STRONG_FAMILIES.has(family)) addValue(known, text.slice(blank, bodyEnd));
      } else if (
        name !== undefined &&
        !isFile &&
        isKeyName(name) &&
        keyValueIsSecret(text.slice(blank, bodyEnd).trim(), text.slice(blank, bodyEnd).trim())
      ) {
        // A field named just `key` with an API key's look (see keyValueIsSecret); a file's
        // contents are left to the file's own rules.
        spans.push({ start: blank, end: bodyEnd, kind: 'name', name });
        const value = text.slice(blank, bodyEnd).trim();
        if (known && credentialLike(value)) addValue(known, value);
      } else if (isFile && partType && !/^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(partType)) {
        // A file sent with a type that isn't text. One that reads as text all the same (an `.env`
        // sent as `application/octet-stream`) is read as text with no type, as a part without a
        // Content-Type is: assignments and JSON too. Any other gets only the token shapes and the
        // known values. ESC is allowed, for colored logs.
        const body = text.slice(blank, bodyEnd);
        // eslint-disable-next-line no-control-regex -- control characters are what mark it as binary
        const readsAsText = !/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f\ufffd]/.test(body.slice(0, 4096));
        if (readsAsText) add(kindSpans(body, 'text/plain', known, notScanned, depth + 1), blank);
        else {
          notScanned.push('a file part that isn’t text');
          add(plainSpans(body, known, false), blank);
        }
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
function prefixedJsonSpans(text: string, known: KnownValues | undefined, cut = false): Span[] | undefined {
  const prefix = JSON_PREFIX.exec(text)![0].length;
  const spans = jsonSpans(prefix > 0 ? text.slice(prefix) : text, known, 0, cut);
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

/** XML's rules: the text rules, then elements and attributes with secret names. */
function xmlSpans(text: string, known: KnownValues | undefined): Span[] {
  const spans = plainSpans(text, known, true);
  for (const span of xmlElementSpans(text, known)) spans.push(span);
  for (const span of tagSpans(text, known)) spans.push(span);
  return spans;
}

/** Words programs use under secret-sounding names, as in `autocomplete: "current-password"`. */
const CODE_WORDS = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'application/json',
  'text/plain',
]);

/**
 * Whether a value in code looks like a secret rather than a word in the program: code is full of
 * `credentials: "include"` and `password: "Password"`, and brackets mean an expression. Too long
 * for `distinctive` still counts.
 */
function secretLooking(value: string): boolean {
  if (/[\s()]/.test(value) || value.startsWith('+') || CODE_WORDS.has(value.toLowerCase())) return false;
  return value.length > MAX_VALUE || distinctive(value);
}

/** A URL being built in code: the quote after `?token=` closes that string, so no value follows. */
const IN_URL_STRING = /[?&][A-Za-z0-9_.-]{1,64}[ \t]{0,4}=[ \t]{0,4}["']$/;

/** Whether an assignment in code holds a value: quoted and secret-looking, or a long number. */
function codeValue(text: string, span: Span): boolean {
  const value = text.slice(span.start, span.end);
  // A number under a double-quoted name.
  if (span.replacement !== undefined) return value.length >= 6;
  // A credential after a scheme inside a quoted value (`"ApiKey <key>"`): judged by where the
  // quote opens.
  const scheme = /(["'])[ \t]*[A-Za-z][A-Za-z0-9_.-]{0,31}[ \t]{1,64}$/.exec(
    text.slice(Math.max(0, span.start - 100), span.start),
  );
  const quoteAt = scheme ? span.start - scheme[0].length : span.start - 1;
  const before = text[quoteAt];
  if (before !== '"' && before !== "'") return false;
  if (IN_URL_STRING.test(text.slice(Math.max(0, quoteAt + 1 - 80), quoteAt + 1))) return false;
  return secretLooking(value);
}

/** A name and value inside a string of JSON in code: `JSON.parse("{\"token\":\"…\"}")`. */
const ESCAPED_ASSIGNMENT = /\\"([A-Za-z][A-Za-z0-9_.-]{0,63})\\"[ \t]{0,4}:[ \t]{0,4}\\"/g;

/**
 * Where an escaped value starting at `from` ends: `end` at its closing `\"`, or -1 if a real quote
 * or a line ends the string first; `stop`, how far was read. A run of backslashes before a quote
 * is read as the string does: an even number of them, once unescaped, leaves the quote closing the
 * value (`\"`, `\\\\\"`); an odd number makes it a quote inside the value (`\\\"`).
 */
function escapedEnd(text: string, from: number): { end: number; stop: number } {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === '\n') return { end: -1, stop: i };
    if (c !== '\\') {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === '\\') run++;
    if (run % 2 === 1 && text[i + run] === '"') {
      if ((run - 1) % 4 === 0) return { end: i + run - 1, stop: i + run - 1 };
      i += run + 1;
    } else {
      // An odd run escapes the character after it.
      i += run + (run % 2);
    }
  }
  return { end: -1, stop: text.length };
}

/** Strong secret names with escaped-quoted values; `cut`, a value may run past the end kept. */
function escapedAssignmentSpans(text: string, cut: boolean): Span[] {
  const spans: Span[] = [];
  let readTo = 0;
  for (const match of text.matchAll(ESCAPED_ASSIGNMENT)) {
    if (match.index < readTo) continue;
    const name = match[1]!;
    const family = secretName(name, 'json');
    if (!family || !STRONG_FAMILIES.has(family)) continue;
    const start = match.index + match[0].length;
    const { end, stop } = escapedEnd(text, start);
    readTo = stop;
    const close = end < 0 && cut && stop === text.length ? stop : end;
    if (close <= start) continue;
    const value = text.slice(start, close);
    if (!STOP_WORDS.has(value.toLowerCase()) && secretLooking(value)) {
      spans.push({ start, end: close, kind: 'name', name });
    }
  }
  return spans;
}

/** Strong secret names with a template literal for a value, with nothing substituted in it. */
function templateSpans(text: string, cut: boolean): Span[] {
  const spans: Span[] = [];
  let readTo = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (match.index < readTo) continue;
    const from = match.index + match[0].length;
    if (text[from] !== '`') continue;
    const family = secretName(match[2]!, 'json');
    if (!family || !STRONG_FAMILIES.has(family)) continue;
    const start = from + 1;
    const closed = text.indexOf('`', start);
    if (closed < 0 && !cut) break;
    const end = closed < 0 ? text.length : closed;
    readTo = end;
    const value = text.slice(start, end);
    if (!value.includes('${') && secretLooking(value))
      spans.push({ start, end, kind: 'name', name: match[2]! });
  }
  return spans;
}

const ENTITY_QUOTE = '&(?:quot|#34|#[xX]22);';
const ENTITY_ASSIGNMENT = new RegExp(
  `${ENTITY_QUOTE}([A-Za-z][A-Za-z0-9_.-]{0,63})${ENTITY_QUOTE}[ \\t]{0,4}:[ \\t]{0,4}${ENTITY_QUOTE}`,
  'g',
);

/** JSON in an HTML attribute, its quotes written as entities: `data-page="{&quot;token&quot;:…}"`. */
function entityAssignmentSpans(text: string, cut: boolean): Span[] {
  const spans: Span[] = [];
  const closing = new RegExp(`${ENTITY_QUOTE}|"`, 'g');
  let readTo = 0;
  for (const match of text.matchAll(ENTITY_ASSIGNMENT)) {
    if (match.index < readTo) continue;
    const name = match[1]!;
    const family = secretName(name, 'json');
    if (!family || !STRONG_FAMILIES.has(family)) continue;
    const start = match.index + match[0].length;
    closing.lastIndex = start;
    let close = closing.exec(text);
    // `\&quot;` is a quote inside the value.
    while (close && close[0] !== '"' && text[close.index - 1] === '\\') close = closing.exec(text);
    if (!close && !cut) break;
    const end = close ? close.index : text.length;
    readTo = end;
    if (close?.[0] === '"' || end <= start) continue;
    const value = text.slice(start, end);
    if (!STOP_WORDS.has(value.toLowerCase()) && secretLooking(value)) {
      spans.push({ start, end, kind: 'name', name });
    }
  }
  return spans;
}

/** Spans by the rules for a body's kind, known values included. */
function kindSpans(
  text: string,
  mediaType: string | undefined,
  known: KnownValues | undefined,
  notScanned: string[],
  depth = 0,
  cut = false,
): Span[] {
  const kind = bodyKind(mediaType);
  switch (kind) {
    case 'json':
      // JSON as a whole, else line by line (JSON objects one after another), else text.
      return prefixedJsonSpans(text, known, cut) ?? lineSpans(text, known, () => 0);
    case 'ndjson':
      return lineSpans(text, known, () => 0);
    case 'sse':
      // `data:` lines' values, with the one space after the colon left out.
      return lineSpans(text, known, (line) => (line.startsWith('data:') ? (line[5] === ' ' ? 6 : 5) : -1));
    case 'form': {
      // Some clients send JSON or XML labeled as a form; the window shows it as what it is. (\s
      // matches a BOM.) The same prefixes as JSON sent as text: `)]}'`, `for(;;);`, `while(1);`.
      if (/^\s*[[{)fw]/.test(text)) {
        const json = prefixedJsonSpans(text, known);
        if (json) return json;
      }
      // Only looks like JSON (broken, cut, one value per line, or a form whose first name
      // starts with a bracket): the form rules, each line as JSON or text, and JSON's as far as it
      // goes.
      if (/^\s*[[{)]/.test(text)) {
        const spans = formBodySpans(text, known);
        for (const span of lineSpans(text, known, () => 0)) spans.push(span);
        for (const span of prefixedJsonSpans(text, known, true) ?? []) spans.push(span);
        return spans;
      }
      if (/^\s*</.test(text)) {
        const spans = xmlSpans(text, known);
        for (const span of formBodySpans(text, known)) spans.push(span);
        return spans;
      }
      return formBodySpans(text, known);
    }
    case 'multipart':
      return multipartSpans(text, mediaType, known, notScanned, depth);
    case 'xml':
      return xmlSpans(text, known);
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
      // In a script, only quoted values: `password = getPassword()` is code.
      for (const span of assignmentSpans(text, cut)) {
        if (!inCode(span) || codeValue(text, span)) spans.push(span);
      }
      for (const span of escapedAssignmentSpans(text, cut)) if (inCode(span)) spans.push(span);
      for (const span of templateSpans(text, cut)) if (inCode(span)) spans.push(span);
      for (const span of entityAssignmentSpans(text, cut)) spans.push(span);
      for (const span of tagSpans(text, known)) spans.push(span);
      for (const span of xmlElementSpans(text, known, true)) spans.push(span);
      return spans;
    }
    case 'code': {
      const spans = plainSpans(text, known, false);
      for (const span of assignmentSpans(text, cut)) if (codeValue(text, span)) spans.push(span);
      for (const span of escapedAssignmentSpans(text, cut)) spans.push(span);
      for (const span of templateSpans(text, cut)) spans.push(span);
      return spans;
    }
    case 'opaque':
      notScanned.push('an encoded body');
      return [];
    default:
      // Text that is JSON, sent without saying so; else text.
      return (
        (/^\uFEFF?\s*[[{)fw]/.test(text) ? prefixedJsonSpans(text, known, cut) : undefined) ??
        plainSpans(text, known, true)
      );
  }
}

/** Whether a compressor's header starts at `i`: gzip, zstd, or zlib. */
function compressedAt(bytes: Uint8Array, i: number): boolean {
  const b0 = bytes[i];
  const b1 = bytes[i + 1];
  if (b0 === undefined || b1 === undefined) return false;
  if (b0 === 0x1f && b1 === 0x8b) return true;
  if (b0 === 0x28 && b1 === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) return true;
  // zlib as writers emit it: 78 then one of four levels (any checksum-valid pair is too loose).
  return b0 === 0x78 && (b1 === 0x01 || b1 === 0x5e || b1 === 0x9c || b1 === 0xda);
}

/**
 * Bytes a compressor wrote, sent without saying so: gzip, zstd or zlib at the start, or in a gRPC
 * frame marked compressed. Brotli and raw deflate have no header to know them by.
 */
export function looksCompressed(bytes: Uint8Array): boolean {
  return compressedAt(bytes, 0) || (bytes[0] === 1 && bytes.length > 5 && compressedAt(bytes, 5));
}

const latin1 = new TextDecoder('latin1');

/**
 * Whether bytes still show a secret byte for byte, read as the `strings` tool reads them: NULs
 * dropped (so UTF-16 and UTF-32 ASCII reads as ASCII) and every other byte that isn't printable
 * ASCII a line break (so random binary rarely makes a match by chance). Then the text rules, and
 * known values in that view and in the bytes as Latin-1. `type`: the rules to read it by, for a body
 * read as text (a script's, say, which leaves unquoted code alone); else plain text's. A match counts only if it isn't wholly in
 * `skip`, byte ranges already hidden. `cut`: only the start was kept, so a value may run to the
 * end. Learns nothing: binary isn't a place to learn values from.
 */
export function secretInBytes(
  bytes: Uint8Array,
  known: KnownValues,
  options: { skip?: ReadonlyArray<readonly [number, number]>; cut?: boolean; type?: string } = {},
): boolean {
  const hidden = [...(options.skip ?? [])].sort((a, b) => a[0] - b[0]);
  // Whether [start, end) lies in one hidden range (they're sorted, and apart once merged).
  const covered = (start: number, end: number): boolean => {
    let low = 0;
    let high = hidden.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const [s, e] = hidden[mid]!;
      if (e <= start) low = mid + 1;
      else if (s > start) high = mid - 1;
      else return end <= e;
    }
    return false;
  };
  if (hidden.length === 0 && known.inBytes(bytes)) return true;
  if (hidden.length > 0) {
    const blanked = Uint8Array.from(bytes);
    for (const [start, end] of hidden) blanked.fill(0x0a, start, end);
    if (known.inBytes(blanked)) return true;
  }
  // The printable view; where each of its characters came from is worked out only on a match.
  const printable = new Uint8Array(bytes.length);
  let n = 0;
  for (const byte of bytes) {
    if (byte === 0) continue;
    printable[n++] = (byte >= 0x20 && byte < 0x7f) || byte === 0x09 ? byte : 0x0a;
  }
  const strings = latin1.decode(printable.subarray(0, n));
  const found = [
    ...redactBody(strings, options.type ?? 'text/plain', undefined, { cut: options.cut === true }).spans,
    ...known.scan(strings),
  ].filter((s) => s.end > s.start);
  if (found.length > 0) {
    const from = new Uint32Array(n);
    for (let i = 0, k = 0; i < bytes.length; i++) if (bytes[i] !== 0) from[k++] = i;
    if (found.some((s) => !covered(from[s.start]!, from[s.end - 1]! + 1))) return true;
  }
  if (known.empty) return false;
  return known.scan(latin1.decode(bytes)).some((s) => s.end > s.start && !covered(s.start, s.end));
}

/**
 * A text body's redactions, by its media type. Values found by name are added to `known`, and
 * every known value found in the body is redacted too, before or after where it was learned.
 */
export function redactBody(
  text: string,
  mediaType: string | undefined,
  known?: KnownValues,
  options: { cut?: boolean } = {},
): BodyRedaction {
  const notScanned: string[] = [];
  const cut = options.cut === true;
  // Collected first, so a value found late in the body is also found earlier in it.
  if (known) kindSpans(text, mediaType, known, [], 0, cut);
  // Known values are looked for by each kind's rules: in JSON, inside its strings; in text, anywhere.
  const spans = kindSpans(text, mediaType, known, notScanned, 0, cut);
  // A body cut off inside a known value: what's left of it is hidden.
  if (known && cut) for (const span of known.cutTail(text)) spans.push(span);
  const merged = mergeSpans(spans);
  return {
    spans: merged,
    records: recordsOf(merged),
    ...(notScanned.length > 0 ? { notScanned: [...new Set(notScanned)].join('; ') } : {}),
  };
}
