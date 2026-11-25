/**
 * The window's copy of the session's known values for View › Hide Secrets (see
 * src/backend/window-known.ts), and whether it covers every summary the window has.
 *
 * Values come only from the backend: pages of getKnownValues while catching up, then pushes in
 * the `exchanges` messages, added in useBackend's message handler before the summaries they came
 * with. They're added in order of their numbers; a repeat is ignored, a gap means catching up.
 *
 * It fails closed: until a catch-up for the current epoch answers `done` (after switching on, every
 * reconnect, a Clear, a gap, an error or a reply of the wrong shape), `covered` is false and the
 * window shows "Checking…". A failed catch-up is tried again, waiting longer each time.
 */
import type { KnownPage, KnownPush } from '../../shared/api';
import { KnownValues } from '../../shared/redact-body';
import type { Command } from './api-client';
import { UNCOVERED, type Masking } from './secrets';

/** The first wait before trying a failed catch-up again, and the longest. */
export const RETRY_FIRST_MS = 250;
export const RETRY_MOST_MS = 8_000;

interface Epoch {
  epoch: string | undefined;
  known: KnownValues;
  /** How many numbered values it has: the next one's number. */
  have: number;
  /** The highest number heard of, plus one: done with fewer than this isn't done. */
  heard: number;
}

const fresh = (epoch?: string): Epoch => ({ epoch, known: new KnownValues(), have: 0, heard: 0 });

const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A page as the backend sends it, or undefined if it isn't one. */
export function asPage(value: unknown): KnownPage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const page = value as Record<string, unknown>;
  if (!isString(page.epoch) || !Array.isArray(page.values) || !page.values.every(isString)) return undefined;
  if (!isCount(page.next) || page.next < page.values.length) return undefined;
  if (typeof page.done !== 'boolean' || typeof page.full !== 'boolean') return undefined;
  return page as unknown as KnownPage;
}

/** A push as the backend sends it, or undefined if it isn't one. */
export function asPush(value: unknown): KnownPush | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const push = value as Record<string, unknown>;
  if (!isString(push.epoch) || !isCount(push.from) || typeof push.full !== 'boolean') return undefined;
  if (!Array.isArray(push.values) || !push.values.every(isString)) return undefined;
  return push as unknown as KnownPush;
}

/** Adds the values numbered from `from` that `into` doesn't have yet; false if there's a gap. */
function addTail(into: Epoch, from: number, values: readonly string[]): boolean {
  into.heard = Math.max(into.heard, from + values.length);
  if (from > into.have) return false;
  for (let i = into.have - from; i < values.length; i++) into.known.add(values[i]!);
  into.have = Math.max(into.have, from + values.length);
  return true;
}

export class KnownSync {
  private on = false;
  /** Bumped when switched on or off: replies from an earlier watch are ignored. */
  private watch = 0;
  private current: Epoch = fresh();
  /** A rebuilt set being caught up on, while `current` is still shown. */
  private next: Epoch | undefined;
  private covered = false;
  private full = false;
  private version = 0;
  private send: ((command: Command) => Promise<unknown>) | undefined;
  /** The connection that was last told to watch, in this watch. */
  private told: ((command: Command) => Promise<unknown>) | undefined;
  private fetching: { run: number; send: (command: Command) => Promise<unknown> } | undefined;
  /** Another catch-up is needed once the one running ends. */
  private again = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;

  constructor(private readonly onChange: (masking: Masking) => void) {}

  /** Switches watching on (catching up) or off (dropping the set). */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.watch += 1;
    this.told = undefined;
    this.reset();
    if (on) this.catchUp();
    else void this.send?.({ command: 'watchKnownValues', on: false }).catch(() => undefined);
    this.emit();
  }

  /** A hello on a connection: uncovered until a catch-up from what the window has answers done. */
  hello(send: (command: Command) => Promise<unknown>): void {
    this.send = send;
    this.covered = false;
    this.next = undefined;
    this.cancelRetry();
    this.failures = 0;
    if (this.on) this.catchUp();
    // Off: says so on every connection, in case it was turned off while disconnected.
    else void send({ command: 'watchKnownValues', on: false }).catch(() => undefined);
    this.emit();
  }

  /** The connection is gone: nothing more to ask until the next hello. */
  disconnect(): void {
    this.send = undefined;
    this.covered = false;
    this.cancelRetry();
    this.emit();
  }

  /** The whole list was cleared: the backend started a new, empty epoch. */
  cleared(): void {
    if (!this.on) return;
    this.current = fresh(this.current.epoch);
    this.next = undefined;
    this.covered = false;
    this.version += 1;
    this.catchUp();
    this.emit();
  }

  /** Values sent with the summaries in an `exchanges` message: added before they're shown. */
  push(value: unknown): void {
    if (!this.on || value === undefined) return;
    const push = asPush(value);
    if (!push) return this.lost();
    const { current, next } = this;
    if (push.epoch === current.epoch) {
      if (!addTail(current, push.from, push.values)) return this.lost();
      this.full = push.full;
    } else if (next && push.epoch === next.epoch) {
      // Shown with the old set meanwhile: these are for summaries arriving now.
      for (const v of push.values) current.known.add(v);
      // A gap is filled by the pages being fetched.
      addTail(next, push.from, push.values);
    } else if (this.covered && current.epoch !== undefined) {
      // Rebuilt: catch up on the new epoch, showing the old set (and these values) until done.
      for (const v of push.values) current.known.add(v);
      this.next = fresh(push.epoch);
      addTail(this.next, push.from, push.values);
      this.catchUp();
    } else {
      // Not covered: the catch-up running or to come answers with the epoch it's on.
      return;
    }
    if (push.values.length > 0) this.version += 1;
    this.emit();
  }

  /** What the window masks with now. */
  get masking(): Masking {
    return this.snapshot;
  }

  private snapshot: Masking = UNCOVERED;

  private emit(): void {
    const { snapshot } = this;
    const known = this.on ? this.current.known : UNCOVERED.known;
    const covered = this.on && this.covered;
    if (
      snapshot.known === known &&
      snapshot.version === this.version &&
      snapshot.covered === covered &&
      snapshot.full === this.full
    )
      return;
    this.snapshot = { known, version: this.version, covered, full: this.full };
    this.onChange(this.snapshot);
  }

  private reset(): void {
    // A catch-up still out belongs to the last watch: its answer changes nothing.
    this.fetching = undefined;
    this.current = fresh();
    this.next = undefined;
    this.covered = false;
    this.full = false;
    this.version += 1;
    this.cancelRetry();
    this.failures = 0;
  }

  /** A push that doesn't follow on: uncovered, and catch up. */
  private lost(): void {
    this.covered = false;
    this.next = undefined;
    this.catchUp();
    this.emit();
  }

  private cancelRetry(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
  }

  /** Fetches pages until one says done. */
  private catchUp(): void {
    if (!this.on || !this.send) return;
    // One catch-up at a time on a connection and watch; one asked for meanwhile runs after it.
    if (this.fetching?.run === this.watch && this.fetching.send === this.send) {
      this.again = true;
      return;
    }
    this.cancelRetry();
    this.again = false;
    const token = { run: this.watch, send: this.send };
    this.fetching = token;
    void this.fetch(token.send, token.run).then(
      () => {
        // Replies for an earlier watch or connection change nothing.
        if (this.fetching !== token) return;
        this.fetching = undefined;
        this.failures = 0;
        if (this.again) this.catchUp();
      },
      () => {
        if (this.fetching !== token) return;
        this.fetching = undefined;
        // Covered by the old set during a rebuild; otherwise not covered until it works.
        if (!this.next) this.covered = false;
        this.emit();
        const wait = Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** this.failures);
        this.failures += 1;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.catchUp();
        }, wait);
      },
    );
  }

  private async fetch(send: (command: Command) => Promise<unknown>, run: number): Promise<void> {
    // Said on each new connection, and after a failure: collecting may have stopped meanwhile.
    if (this.told !== send || this.failures > 0) {
      await send({ command: 'watchKnownValues', on: true });
      if (run !== this.watch) return;
      this.told = send;
    }
    for (;;) {
      if (run !== this.watch || send !== this.send) return;
      const target = this.next ?? this.current;
      const reply = await send({
        command: 'getKnownValues',
        ...(target.epoch !== undefined ? { epoch: target.epoch } : {}),
        after: target.have,
      });
      if (run !== this.watch || send !== this.send) return;
      const page = asPage(reply);
      if (!page) throw new Error('Not a page of known values.');
      // The same target, unless a push or a Clear changed it meanwhile: then ask again.
      if (target !== (this.next ?? this.current)) continue;
      let into = target;
      if (page.epoch !== target.epoch) {
        // A new epoch, answered from 0: a rebuild while covered keeps the old set shown.
        into = fresh(page.epoch);
        if (target === this.current && this.covered) this.next = into;
        else if (target === this.next) this.next = into;
        else {
          this.current = into;
          this.version += 1;
        }
      }
      if (!addTail(into, page.next - page.values.length, page.values)) {
        throw new Error('A page of known values that doesn’t follow on.');
      }
      if (page.values.length > 0 && into === this.current) this.version += 1;
      this.full = page.full;
      // Done, unless a push meanwhile named values past what it has: ask on for those.
      if (page.done && into.have >= into.heard) {
        if (into === this.next) {
          this.current = into;
          this.next = undefined;
          this.version += 1;
        }
        this.covered = true;
        this.emit();
        return;
      }
      this.emit();
    }
  }
}
