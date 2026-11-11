/**
 * A Server-Sent Events stream's events, read as they arrive: each look reads only the bytes that
 * came since the last one, undoes the Content-Encoding as it goes, parses them, and keeps the
 * newest items. Kept per open stream, and forgotten when unused. Looks at one stream run one after
 * another, and each is limited, as they run on the backend's own thread.
 */
import type { Transform } from 'node:stream';
import { TextDecoder } from 'node:util';
import zlib from 'node:zlib';
import type { BodySide, ExchangeDetail, SseEventsView } from '../shared/api';
import { isEventStream, SseParser, type SseItem } from '../shared/sse';
import type { StoredRange } from './body-store';

/** Items kept: the newest. */
export const MAX_SSE_ITEMS = 2000;
/** Characters of items kept per stream, at most: older ones go first. */
const MAX_KEPT_CHARS = 4 * 1024 * 1024;
/** Bytes of the stored body read per look: a stream opened late catches up over a few looks. */
export const SSE_READ_PER_LOOK = 4 * 1024 * 1024;
/** Read at a time: small, so compressed data can't grow much past the limit below at once. */
const CHUNK = 64 * 1024;
/** Bytes of decompressed text per look, at most. */
const MAX_DECODED_PER_LOOK = 16 * 1024 * 1024;
const MAX_CURSORS = 20;
const UNUSED_MS = 60_000;

export interface SseReaderHost {
  getExchange(id: string): ExchangeDetail | undefined;
  readRange(
    id: string,
    side: BodySide,
    start: number,
    maxBytes: number,
  ): Promise<(StoredRange & { decoded: boolean }) | undefined>;
}

interface Cursor {
  serial: number;
  offset: number;
  /** The Content-Encoding to undo; its decoder is made once the first bytes show which kind. */
  encoding?: string;
  decoder?: Transform;
  text: TextDecoder;
  parser: SseParser;
  kept: SseItem[];
  keptChars: number;
  total: number;
  receiving: boolean;
  problem?: string;
  usedAt: number;
}

export class SseReader {
  private readonly cursors = new Map<string, Cursor>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly host: SseReaderHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Items after `after` (an index), newest kept. Null if the exchange is gone or isn't an event stream. */
  read(exchangeId: string, after: number): Promise<SseEventsView | null> {
    const previous = this.queues.get(exchangeId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.readNow(exchangeId, after));
    this.queues.set(exchangeId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(exchangeId) === next) this.queues.delete(exchangeId);
      });
    return next;
  }

  /** Lets go of one stream, e.g. when its exchange is deleted. */
  delete(exchangeId: string): void {
    this.drop(exchangeId);
  }

  /** Lets go of every stream, e.g. when the list is cleared. */
  clear(): void {
    for (const cursor of this.cursors.values()) cursor.decoder?.destroy();
    this.cursors.clear();
  }

  private async readNow(exchangeId: string, after: number): Promise<SseEventsView | null> {
    this.sweep(exchangeId);
    const detail = this.host.getExchange(exchangeId);
    if (!detail || !isEventStream(detail.summary.contentType)) return null;
    let cursor = this.cursors.get(exchangeId);
    if (cursor) cursor.usedAt = this.now();
    let looked = 0;
    let decoded = 0;
    let restarted = false;
    /** Dropped while this look waited (cleared, deleted, let go of): nothing to give. */
    const gone = (): boolean => cursor !== undefined && this.cursors.get(exchangeId) !== cursor;
    let more = false;
    for (;;) {
      if (looked >= SSE_READ_PER_LOOK || decoded >= MAX_DECODED_PER_LOOK) {
        // Stopped by this look's limits, not by the end of what has arrived: there's more to read.
        more = true;
        break;
      }
      const offset = cursor?.offset ?? 0;
      const range = await this.host.readRange(exchangeId, 'response', offset, CHUNK);
      if (!range) {
        // No body yet, or it's gone.
        if (cursor) this.drop(exchangeId);
        return {
          serial: 0,
          items: [],
          total: 0,
          receiving: detail.summary.responding === true || detail.summary.durationMs === undefined,
        };
      }
      if (cursor && range.serial !== cursor.serial) {
        // The body was replaced: start again (once per look).
        this.drop(exchangeId);
        cursor = undefined;
        if (restarted) return { serial: range.serial, items: [], total: 0, receiving: range.receiving };
        restarted = true;
        if (offset !== 0) continue;
      }
      cursor ??= this.open(exchangeId, detail, range);
      cursor.receiving = range.receiving;
      // Stopped by a problem (an encoding it can't undo, data that won't decompress): nothing more is read.
      if (cursor.problem) break;
      if (range.bytes.length === 0) {
        if (range.size > range.stored && offset >= range.stored) {
          cursor.problem = `Wirescry kept only the first ${sizeText(range.stored)} of this stream, so later events aren't shown.`;
        }
        break;
      }
      looked += range.bytes.length;
      cursor.offset += range.bytes.length;
      let bytes: Uint8Array = range.bytes;
      if (cursor.encoding && !cursor.decoder) {
        cursor.decoder = decoderFor(cursor.encoding, range.bytes);
        if (!cursor.decoder) {
          cursor.problem = `It's compressed with ${cursor.encoding}, which Wirescry can't undo as it arrives.`;
          break;
        }
      }
      if (cursor.decoder) {
        try {
          // A fixed limit per piece: more than this from 64 KB isn't a stream, it's a bomb.
          bytes = await feed(cursor.decoder, range.bytes, MAX_DECODED_PER_LOOK);
        } catch (error) {
          if (gone()) return { serial: 0, items: [], total: 0, receiving: false };
          cursor.problem = `Its Content-Encoding couldn't be undone (${(error as Error).message}), so later events aren't shown.`;
          break;
        }
      }
      if (gone()) return { serial: 0, items: [], total: 0, receiving: false };
      decoded += bytes.length;
      this.add(cursor, cursor.parser.push(cursor.text.decode(bytes, { stream: true })));
    }
    if (!cursor) return { serial: 0, items: [], total: 0, receiving: true };
    cursor.usedAt = this.now();
    // Most recently used last, so the least recently used goes first; never one being read.
    this.cursors.delete(exchangeId);
    this.cursors.set(exchangeId, cursor);
    for (const id of [...this.cursors.keys()]) {
      if (this.cursors.size <= MAX_CURSORS) break;
      // Not one a look is reading (this one is too, so it stays).
      if (!this.queues.has(id)) this.drop(id);
    }
    return {
      serial: cursor.serial,
      items: cursor.kept.filter((item) => item.index > after),
      total: cursor.total,
      receiving: cursor.receiving,
      ...(more && !cursor.problem ? { more: true } : {}),
      ...(cursor.problem ? { problem: cursor.problem } : {}),
    };
  }

  private open(
    exchangeId: string,
    detail: ExchangeDetail,
    range: StoredRange & { decoded: boolean },
  ): Cursor {
    const cursor: Cursor = {
      serial: range.serial,
      offset: 0,
      // A BOM at the start is dropped, as the spec says.
      text: new TextDecoder('utf-8'),
      parser: new SseParser(),
      kept: [],
      keptChars: 0,
      total: 0,
      receiving: range.receiving,
      usedAt: this.now(),
    };
    const encoding = range.decoded
      ? undefined
      : detail.responseHeaders
          ?.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1]
          ?.trim()
          .toLowerCase();
    if (encoding && encoding !== 'identity') {
      if (KNOWN_ENCODINGS.has(encoding)) cursor.encoding = encoding;
      else
        cursor.problem = `It's compressed with ${encoding.slice(0, 40)}, which Wirescry can't undo as it arrives.`;
    }
    this.cursors.set(exchangeId, cursor);
    return cursor;
  }

  private add(cursor: Cursor, items: SseItem[]): void {
    for (const item of items) {
      cursor.total++;
      cursor.kept.push(item);
      cursor.keptChars += charsOf(item);
    }
    let drop = 0;
    while (
      drop < cursor.kept.length - 1 &&
      (cursor.kept.length - drop > MAX_SSE_ITEMS || cursor.keptChars > MAX_KEPT_CHARS)
    ) {
      cursor.keptChars -= charsOf(cursor.kept[drop]!);
      drop++;
    }
    if (drop > 0) cursor.kept.splice(0, drop);
  }

  /** Lets go of streams unused for a while; not one another look is reading, but this one, about to be read afresh. */
  private sweep(current: string): void {
    const now = this.now();
    for (const [id, cursor] of this.cursors) {
      if (now - cursor.usedAt > UNUSED_MS && (id === current || !this.queues.has(id))) this.drop(id);
    }
  }

  private drop(id: string): void {
    this.cursors.get(id)?.decoder?.destroy();
    this.cursors.delete(id);
  }
}

function charsOf(item: SseItem): number {
  return item.kind === 'event'
    ? item.data.length + item.type.length
    : item.kind === 'comment'
      ? item.text.length
      : 8;
}

const KNOWN_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** A decoder for an encoding, from its first bytes: "deflate" is sometimes sent raw, without zlib's header. */
function decoderFor(encoding: string, first: Uint8Array): Transform | undefined {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate': {
      const zlibHeader =
        first.length >= 2 && (first[0]! & 0x0f) === 8 && ((first[0]! << 8) | first[1]!) % 31 === 0;
      return zlibHeader ? zlib.createInflate() : zlib.createInflateRaw();
    }
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd':
      return typeof zlib.createZstdDecompress === 'function' ? zlib.createZstdDecompress() : undefined;
    default:
      return undefined;
  }
}

/** Writes compressed bytes to a decoder and gives what it has decompressed so far, at most `max`. */
function feed(decoder: Transform, chunk: Uint8Array, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let length = 0;
    const onData = (data: Buffer): void => {
      length += data.length;
      if (length > max) {
        cleanup();
        decoder.destroy();
        reject(new Error('it decompresses to far more than was sent'));
        return;
      }
      out.push(data);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      decoder.off('data', onData);
      decoder.off('error', onError);
    };
    decoder.on('data', onData);
    decoder.on('error', onError);
    decoder.write(chunk);
    (decoder as unknown as zlib.Zlib).flush(() => {
      cleanup();
      resolve(Buffer.concat(out));
    });
  });
}
