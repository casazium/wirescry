/**
 * The session's known values for the window's View › Hide Secrets: values learned from every
 * stored exchange's URL, headers and trailers (as HAR export's collectKnown learns them), so the
 * window can hide a token learned from `Authorization` where it repeats in a URL or another header.
 *
 * Kept on the backend's own thread, and only while the window watches: off, nothing is collected,
 * so the proxy pays nothing. Turning on catches up on the stored exchanges in chunks of a few
 * milliseconds; after that each exchange the update batcher sends is learned from as it goes, and
 * the values it taught go in the same message, ahead of it. Each URL and header list is learned
 * from once (by identity), so streaming updates, badges and nudges cost nothing.
 *
 * Values are numbered in the order learned within an epoch. The window catches up with pages
 * (`page`) until one says `done`; pushes (`take`) start from that page's `next`. When the set is
 * full and much of the traffic it came from has gone, it's rebuilt from what's stored, in the
 * background, under a new epoch.
 */
import type { ExchangeDetail, Header, KnownPage, KnownPush } from '../shared/api';
import { redactHeaders, redactUrl } from '../shared/redact';
import { KnownValues, SHARED_URL_SHARE } from '../shared/redact-body';

/** Where the stored exchanges come from. */
export interface KnownSource {
  /** Stored exchanges' ids, oldest first. */
  ids(): string[];
  get(id: string): ExchangeDetail | undefined;
}

export interface WindowKnownOptions {
  /** Sends what the update batcher holds now, with the values its exchanges taught. */
  flush(): void;
  /** How long one chunk of catching up may take (default 5 ms). */
  chunkMs?: number;
  /** Exchanges that must leave the store before a full set is rebuilt (default 1,000). */
  rebuildAfter?: number;
  /** The least time between rebuilds (default a minute). */
  rebuildEveryMs?: number;
  /** The time, for rebuilds; and a clock for chunks. For tests. */
  now?: () => number;
  clock?: () => number;
}

/** About this much text per page. */
export const MAX_PAGE_CHARS = 1_000_000;

/** A set of known values and which of each exchange's fields it has learned from. */
class Learner {
  readonly known = new KnownValues();
  /** By exchange: its URL, and its four header lists by identity. */
  private readonly seen = new Map<string, { url?: string; lists: Array<readonly Header[] | undefined> }>();

  learn(exchange: ExchangeDetail): void {
    const id = exchange.summary.id;
    let seen = this.seen.get(id);
    if (!seen) this.seen.set(id, (seen = { lists: [] }));
    const lists = [
      exchange.requestHeaders,
      exchange.responseHeaders,
      exchange.requestTrailers,
      exchange.responseTrailers,
    ];
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i];
      if (!list || seen.lists[i] === list) continue;
      seen.lists[i] = list;
      try {
        redactHeaders(list, this.known);
      } catch {
        // Headers that can't be read teach nothing.
      }
    }
    // After the headers, and only a share of the set: URLs of junk can't take the room header
    // values need.
    const url = exchange.summary.url;
    if (url && seen.url !== url) {
      seen.url = url;
      try {
        this.known.share('url', SHARED_URL_SHARE, () => redactUrl(url, this.known));
      } catch {
        // A URL that can't be read teaches nothing.
      }
    }
  }

  forget(id: string): void {
    this.seen.delete(id);
  }
}

export class WindowKnown {
  /** Undefined while not watching. */
  private learner: Learner | undefined;
  private epoch: string | undefined;
  private epochs = 0;
  private readonly startedAt = Date.now().toString(36);
  /** Values numbered below this have been pushed; undefined until a page answered `done`. */
  private pushedTo: number | undefined;
  private fullSent = false;
  /** A new epoch to tell the window about, after a rebuild. */
  private announce = false;
  /** Whether the pass over stored exchanges has finished, and the promise that it will. */
  private passDone = true;
  private passFinished: Promise<void> = Promise.resolve();
  /** Bumped to stop a pass or a rebuild that's running. */
  private run = 0;
  /** A rebuild in progress: its set, and exchanges changed meanwhile. */
  private building: { learner: Learner; dirty: Set<string> } | undefined;
  /** Exchanges that left the store since the set was built. */
  private gone = 0;
  private builtAt = 0;
  private readonly chunkMs: number;
  private readonly rebuildAfter: number;
  private readonly rebuildEveryMs: number;
  private readonly now: () => number;
  private readonly clock: () => number;

  constructor(
    private readonly source: KnownSource,
    private readonly options: WindowKnownOptions,
  ) {
    this.chunkMs = options.chunkMs ?? 5;
    this.rebuildAfter = options.rebuildAfter ?? 1_000;
    this.rebuildEveryMs = options.rebuildEveryMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
  }

  get watching(): boolean {
    return this.learner !== undefined;
  }

  /** The current set, for tests. */
  get values(): KnownValues | undefined {
    return this.learner?.known;
  }

  /**
   * Turns collecting on (keeping the epoch if it's on already) or off. The epoch, while on. One
   * flag for the backend: there is one window, so one watcher. A second window would need a count.
   */
  watch(on: boolean): string | undefined {
    if (!on) {
      this.stopWork();
      this.learner = undefined;
      this.epoch = undefined;
      this.pushedTo = undefined;
      return undefined;
    }
    if (this.learner) return this.epoch;
    this.begin();
    this.startPass();
    return this.epoch;
  }

  /** Learns from an exchange's URL, headers and trailers, those not already learned from. */
  collect(exchange: ExchangeDetail): void {
    if (!this.learner) return;
    this.learner.learn(exchange);
    this.building?.dirty.add(exchange.summary.id);
  }

  /** An exchange left the store. */
  forget(id: string): void {
    if (!this.learner) return;
    this.learner.forget(id);
    this.building?.learner.forget(id);
    this.building?.dirty.delete(id);
    this.gone += 1;
  }

  /**
   * The whole list was cleared: a new, empty epoch. Pushes go on from 0, so exchanges arriving
   * before the window hears of the Clear bring their values (it adds those to what it shows).
   */
  clear(): void {
    if (!this.learner) return;
    const pushing = this.pushedTo !== undefined;
    this.stopWork();
    this.begin();
    if (pushing) this.pushedTo = 0;
  }

  /** Values learned since the last push, for the update batcher; undefined if none to send. */
  take(): KnownPush | undefined {
    const learner = this.learner;
    if (!learner || this.pushedTo === undefined) return undefined;
    this.maybeRebuild();
    const known = this.learner!.known;
    if (known.size === this.pushedTo && known.full === this.fullSent && !this.announce) return undefined;
    const from = this.pushedTo;
    const values = known.list(from, Infinity);
    this.pushedTo = from + values.length;
    this.fullSent = known.full;
    this.announce = false;
    return { epoch: this.epoch!, from, values, full: known.full };
  }

  /**
   * Values from `after` in `epoch`, or from 0 in the current one if `epoch` isn't it. Waits for the
   * pass over stored exchanges when there's nothing else to give, and flushes the batcher first,
   * so what the window has been sent is covered.
   */
  async page(epoch: string | undefined, after: number): Promise<KnownPage> {
    for (;;) {
      if (!this.learner) throw new Error('Known values aren’t being collected.');
      const from = epoch === this.epoch ? after : 0;
      if (from > this.learner.known.size) throw new Error('after is past the values known');
      if (from < this.learner.known.size || this.passDone) break;
      await this.passFinished;
    }
    this.options.flush();
    const known = this.learner.known;
    const from = epoch === this.epoch ? after : 0;
    const values = known.list(from, MAX_PAGE_CHARS);
    const next = from + values.length;
    const done = this.passDone && next === known.size;
    if (done && this.pushedTo === undefined) {
      // Pushes start from here: everything before it is in this page or an earlier one.
      this.pushedTo = next;
      this.fullSent = known.full;
    }
    return { epoch: this.epoch!, values, next, done, full: known.full };
  }

  /** Stops any work in progress (the backend is stopping). */
  stop(): void {
    this.stopWork();
  }

  /** A new epoch with an empty set, all of it collected (nothing stored yet, or a pass to come). */
  private begin(): void {
    this.learner = new Learner();
    this.epoch = `${this.startedAt}-${++this.epochs}`;
    this.pushedTo = undefined;
    this.fullSent = false;
    this.announce = false;
    this.passDone = true;
    this.passFinished = Promise.resolve();
    this.gone = 0;
    this.builtAt = this.now();
  }

  private stopWork(): void {
    this.run += 1;
    this.building = undefined;
    this.passDone = true;
  }

  /** Learns from every stored exchange, a few milliseconds at a time. */
  private startPass(): void {
    const run = ++this.run;
    const learner = this.learner!;
    this.passDone = false;
    this.passFinished = this.chunked(run, learner).then((finished) => {
      if (finished && run === this.run) this.passDone = true;
    });
  }

  /** Learns from every stored exchange into `learner` in chunks; false if stopped. */
  private chunked(run: number, learner: Learner): Promise<boolean> {
    const ids = this.source.ids();
    let i = 0;
    return new Promise((resolve) => {
      const step = (): void => {
        if (run !== this.run) return resolve(false);
        const until = this.clock() + this.chunkMs;
        while (i < ids.length) {
          const exchange = this.source.get(ids[i++]!);
          if (exchange) learner.learn(exchange);
          if (this.clock() >= until) break;
        }
        if (i < ids.length) setImmediate(step);
        else resolve(true);
      };
      setImmediate(step);
    });
  }

  /** Rebuilds a full set from what's stored, when enough has gone and not too often. */
  private maybeRebuild(): void {
    const learner = this.learner;
    if (!learner || !learner.known.full || this.building || !this.passDone) return;
    if (this.gone < this.rebuildAfter || this.now() - this.builtAt < this.rebuildEveryMs) return;
    const run = this.run;
    const building = { learner: new Learner(), dirty: new Set<string>() };
    this.building = building;
    void this.chunked(run, building.learner).then((finished) => {
      if (!finished || run !== this.run || this.building !== building) return;
      // What the batcher holds goes out under the old epoch; its exchanges are now marked changed.
      this.options.flush();
      for (const id of building.dirty) {
        const exchange = this.source.get(id);
        if (exchange) building.learner.learn(exchange);
      }
      this.building = undefined;
      this.learner = building.learner;
      this.epoch = `${this.startedAt}-${++this.epochs}`;
      // Pushes go on, from the new set's end; the window catches up on the rest with pages.
      this.pushedTo = building.learner.known.size;
      this.fullSent = building.learner.known.full;
      this.announce = true;
      this.gone = 0;
      this.builtAt = this.now();
      this.options.flush();
    });
  }
}
