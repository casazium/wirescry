/**
 * What body search has found in each body, so a body isn't read again for the same search when
 * nothing about it has changed: a finished body is read once, and one still arriving is read
 * again only once it has grown, and no more often than its last search's cost allows.
 *
 * Kept per exchange, then per side and set of needles (a side's needles are searched together),
 * with the body's serial and encoding in each value: a value for a replaced body, or one whose
 * encoding has turned out different (its headers came after the first search), is stale.
 */

interface Common {
  /** The body it's about. */
  serial: number;
  /** The Content-Encoding it was decoded with ('' for none). */
  encoding: string;
  /** The needles found. */
  found: readonly string[];
}

/** Searched when the body had finished. */
export interface DoneValue extends Common {
  kind: 'done';
  partial: boolean;
}

/** Searched while the body was still arriving. */
export interface SoFarValue extends Common {
  kind: 'sofar';
  /** Bytes stored when it was searched. */
  stored: number;
  /** Every needle found, or the limit reached: reading more can't change the answer. */
  final: boolean;
  /** When it was searched, and how long that took, in the search's clock. */
  scannedAt: number;
  costMs: number;
}

export type MemoValue = DoneValue | SoFarValue;

/** Whether `next` should replace `current`: a newer or more complete answer about the same body. */
export function isNewer(next: MemoValue, current: MemoValue | undefined): boolean {
  if (!current) return true;
  if (current.serial !== next.serial || current.encoding !== next.encoding) return true;
  if (current.kind === 'done') return false;
  if (next.kind === 'done') return true;
  return next.scannedAt > current.scannedAt;
}

/** The key for one side's needles: the same set, in any order, gives the same key. */
export function memoKey(side: string, needles: readonly string[]): string {
  return `${side}:${JSON.stringify([...new Set(needles)].sort())}`;
}

export class BodyMemo {
  private readonly byExchange = new Map<string, Map<string, MemoValue>>();

  /** At most this many exchanges' values; the oldest exchange's go first. */
  constructor(private readonly maxExchanges = 10_000) {}

  get(exchangeId: string, key: string): MemoValue | undefined {
    return this.byExchange.get(exchangeId)?.get(key);
  }

  /** Stores `value` if it's newer than what's there (compared now, not when its search began). */
  offer(exchangeId: string, key: string, value: MemoValue): void {
    let values = this.byExchange.get(exchangeId);
    if (!isNewer(value, values?.get(key))) return;
    if (!values) {
      values = new Map();
      this.byExchange.set(exchangeId, values);
      if (this.byExchange.size > this.maxExchanges) {
        const oldest = this.byExchange.keys().next().value!;
        this.byExchange.delete(oldest);
      }
    }
    values.set(key, value);
  }

  forget(exchangeId: string): void {
    this.byExchange.delete(exchangeId);
  }

  clear(): void {
    this.byExchange.clear();
  }

  /** How many exchanges have values. For tests. */
  get size(): number {
    return this.byExchange.size;
  }
}
