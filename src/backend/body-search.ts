import { createDecodeStream } from 'http-encoding';
import type { StoredRange } from './body-store';
import { foldText } from '../shared/query';

/** At most this much of a body's decoded content is searched. */
export const MAX_SEARCHED_BYTES = 64 * 1024 * 1024;

/** Stored bytes read at a time. */
const RANGE_BYTES = 1024 * 1024;

/** One stored body, as body search reads it. */
export interface BodySource {
  /**
   * Up to `max` stored bytes from `start`. Undefined if the body is gone: deleted, cleared or
   * replaced (the store checks on every read), or unreadable.
   */
  read(start: number, max: number): Promise<StoredRange | undefined>;
  /** The Content-Encoding to undo, if any (none for a body stored decoded, like an import). */
  encoding: string | undefined;
}

export interface BodySearchResult {
  /** The needles found. */
  found: Set<string>;
  /**
   * True if some needle wasn't found and part of the body couldn't be searched: past the
   * search's limit, not all kept by Wirescry, or a finished body that couldn't be decoded.
   */
  partial: boolean;
}

/** Runs between chunks: may yield to let the proxy run, and throws if the search was stopped. */
export type Tick = () => Promise<void>;

/**
 * Searches one body for `needles` (folded with foldText), decoding it first as the body view
 * does. Reads in pieces, so a large body is never held whole, and stops once every needle is
 * found. Text is UTF-8, decoded across chunk boundaries, and a match can span two chunks.
 */
export async function searchBody(
  source: BodySource,
  needles: readonly string[],
  tick: Tick,
  limit = MAX_SEARCHED_BYTES,
): Promise<BodySearchResult> {
  const found = new Set<string>();
  const pending = new Set(needles);
  if (pending.size === 0) return { found, partial: false };
  const overlap = Math.max(...[...pending].map((n) => n.length)) - 1;

  // What the reads saw, for deciding what "partial" means.
  let serial: number | undefined;
  let receiving = false;
  let notAllKept = false;
  // Set when the search was stopped, so a stream error caused by it isn't taken for a bad body.
  let stopped: unknown;
  const step = async (): Promise<void> => {
    try {
      await tick();
    } catch (error) {
      stopped = error;
      throw error;
    }
  };

  /** The stored bytes, read a piece at a time; ends early if the body goes. */
  const stored = (): ReadableStream<Uint8Array> => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const range = await source.read(offset, RANGE_BYTES);
        if (!range || (serial !== undefined && range.serial !== serial)) {
          // Gone, or replaced by another body: nothing more of this one.
          controller.close();
          return;
        }
        serial = range.serial;
        receiving = range.receiving;
        notAllKept = range.stored < range.size;
        if (range.bytes.length === 0) {
          controller.close();
          return;
        }
        offset += range.bytes.length;
        controller.enqueue(range.bytes);
      },
    });
  };

  const check = (text: string): void => {
    for (const needle of pending) {
      if (text.includes(needle)) {
        found.add(needle);
        pending.delete(needle);
      }
    }
  };

  /**
   * Searches a stream's bytes as text; true if it stopped at the limit. `stop` ends a decoding
   * stream early from its input side: canceling a decoder's output instead can leave a rejected
   * promise inside Node's stream adapter, unhandled.
   */
  const scan = async (stream: ReadableStream<Uint8Array>, stop?: () => void): Promise<boolean> => {
    const reader = stream.getReader();
    // Once stopped, the stream ends with an error nobody reads: that's expected.
    reader.closed.catch(() => undefined);
    let ended = false;
    const text = new TextDecoder();
    let carry = '';
    let searched = 0;
    try {
      while (pending.size > 0) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          check(carry + foldText(text.decode()));
          return false;
        }
        const room = limit - searched;
        const chunk = value.length > room ? value.subarray(0, room) : value;
        searched += chunk.length;
        const window = carry + foldText(text.decode(chunk, { stream: true }));
        check(window);
        if (searched >= limit) return pending.size > 0;
        carry = overlap > 0 ? window.slice(-overlap) : '';
        await step();
      }
      return false;
    } finally {
      // Stops reading (and decoding) if it hasn't finished.
      if (!ended) {
        if (stop) {
          stop();
          reader.releaseLock();
        } else void reader.cancel().catch(() => undefined);
      }
    }
  };

  let decoder: ReturnType<typeof createDecodeStream> | undefined;
  try {
    decoder = createDecodeStream(source.encoding);
  } catch {
    decoder = undefined; // An encoding Wirescry can't undo.
  }

  let atLimit = false;
  let undecodable = decoder === undefined;
  if (decoder !== undefined) {
    try {
      if (decoder) {
        const pipe = new AbortController();
        atLimit = await scan(stored().pipeThrough(decoder, { signal: pipe.signal }), () => pipe.abort());
      } else atLimit = await scan(stored());
    } catch (error) {
      if (stopped !== undefined) throw stopped;
      if (error !== undefined && decoder === null) throw error;
      // A body still arriving ends mid-stream: what decoded is what there is so far.
      undecodable = !receiving;
    }
  }
  if (undecodable && pending.size > 0) {
    // Can't be decoded: search what was stored, as it is.
    try {
      atLimit = await scan(stored());
    } catch (error) {
      if (stopped !== undefined) throw stopped;
      throw error;
    }
  }
  const partial = pending.size > 0 && (atLimit || notAllKept || undecodable);
  return { found, partial };
}
