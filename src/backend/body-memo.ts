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
  /** Partly searched as far as that search could tell (e.g. an encoding it can't undo). */
  partial: boolean;
  /** When it was searched, and how long that took, in the search's clock. */
  scannedAt: number;
  costMs: number;
}

export type MemoValue = DoneValue | SoFarValue;

/** Whether `next` should replace `current`: a newer or more complete answer about the same body. */
export function isNewer(next: MemoValue, current: MemoValue | undefined): boolean {
  if (!current) return true;
  // About an older body than the one there (a slow search of a body replaced since): no.
  if (next.serial < current.serial) return false;
  if (current.serial !== next.serial || current.encoding !== next.encoding) return true;
  if (current.kind === 'done') return false;
  if (next.kind === 'done') return true;
  return next.scannedAt > current.scannedAt;
}

/** The key for one side's needles: the same set, in any order, gives the same key. */
export function memoKey(side: string, needles: readonly string[]): string {
  return `${side}:${JSON.stringify([...new Set(needles)].sort())}`;
}

/** A search of one body under way: another ask about the same body waits for it. */
export interface InFlight {
  serial: number;
  encoding: string;
  done: Promise<unknown>;
}

/** Sets of needles remembered per exchange, at most; past this its oldest goes. */
export const MAX_KEYS_PER_EXCHANGE = 8;

export class BodyMemo {
  private readonly byExchange = new Map<string, Map<string, MemoValue>>();
  private readonly running = new Map<string, InFlight>();

  /** At most this many exchanges' values; the oldest exchange's go first. */
  constructor(private readonly maxExchanges = 10_000) {}

  get(exchangeId: string, key: string): MemoValue | undefined {
    return this.byExchange.get(exchangeId)?.get(key);
  }

  /** The search under way for this body and needles, if any. */
  inFlight(exchangeId: string, key: string): InFlight | undefined {
    return this.running.get(`${exchangeId}\n${key}`);
  }

  /** Notes a search under way until it settles. */
  track(exchangeId: string, key: string, flight: InFlight): void {
    const at = `${exchangeId}\n${key}`;
    this.running.set(at, flight);
    const done = (): void => {
      if (this.running.get(at) === flight) this.running.delete(at);
    };
    flight.done.then(done, done);
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
    if (!values.has(key) && values.size >= MAX_KEYS_PER_EXCHANGE) {
      values.delete(values.keys().next().value!);
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

/**
 * Asks once for an exchange to be searched again at a given time: an arriving body whose search
 * had to wait for its throttle, so a last part that came meanwhile is found. One wait per
 * exchange at a time; none after `stop`.
 */
export class Nudger {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    /** Called at the time asked for, if the exchange's wait wasn't forgotten meanwhile. */
    private readonly fire: (exchangeId: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Fires for `exchangeId` at `at` (in `now`'s clock), unless it's already waiting. */
  schedule(exchangeId: string, at: number): void {
    if (this.stopped || this.timers.has(exchangeId)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(exchangeId);
        this.fire(exchangeId);
      },
      Math.max(0, at - this.now()),
    );
    timer.unref?.();
    this.timers.set(exchangeId, timer);
  }

  forget(exchangeId: string): void {
    clearTimeout(this.timers.get(exchangeId));
    this.timers.delete(exchangeId);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** For good: nothing fires, and nothing more is scheduled. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  /** How many exchanges are waiting. For tests. */
  get size(): number {
    return this.timers.size;
  }
}
