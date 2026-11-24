/**
 * The window's copy of the known values for View › Hide Secrets (src/renderer/src/known-sync.ts):
 * pages and pushes in order, epochs, repeats, gaps, failures tried again, and when it's covered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnownPage } from '../src/shared/api';
import { KnownSync, RETRY_FIRST_MS } from '../src/renderer/src/known-sync';
import type { Masking } from '../src/renderer/src/secrets';
import type { Command } from '../src/renderer/src/api-client';

// Fake tokens, made at run time so the file holds nothing a secret scanner flags.
const v = (n: number): string => `Zq9x${n}Tk7Lm2Pw4Rt8Vn6Yb3`;

type Reply = KnownPage | Error | Promise<unknown>;

/** A backend that answers getKnownValues from a script, and records what it was asked. */
function backend(replies: Array<Reply | ((command: Command) => Reply)>) {
  const asked: Command[] = [];
  const send = vi.fn(async (command: Command) => {
    asked.push(command);
    if (command.command === 'watchKnownValues') return { epoch: 'e1' };
    const next = replies.shift();
    if (next === undefined) return new Promise(() => undefined);
    const reply = typeof next === 'function' ? next(command) : next;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { send, asked, pages: () => asked.filter((c) => c.command === 'getKnownValues') };
}

const page = (epoch: string, from: number, values: string[], done = true, full = false): KnownPage => ({
  epoch,
  values,
  next: from + values.length,
  done,
  full,
});

function sync() {
  const seen: Masking[] = [];
  const known = new KnownSync((m) => seen.push(m));
  return { known, last: () => known.masking, seen };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('KnownSync: catching up', () => {
  it('asks for no values while off, only says it’s off, and is never covered', async () => {
    const { known, last } = sync();
    const b = backend([]);
    known.hello(b.send);
    await settle();
    expect(b.asked).toEqual([{ command: 'watchKnownValues', on: false }]);
    known.push({ epoch: 'e1', from: 0, values: [v(1)], full: false });
    expect(last().covered).toBe(false);
    expect(last().known.size).toBe(0);
  });

  it('pages until done, then is covered, values in order', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1), v(2)], false), page('e1', 2, [v(3)], true)]);
    known.setOn(true);
    expect(last().covered).toBe(false);
    known.hello(b.send);
    await settle();
    expect(b.asked[0]).toEqual({ command: 'watchKnownValues', on: true });
    expect(b.pages()).toEqual([
      { command: 'getKnownValues', after: 0 },
      { command: 'getKnownValues', epoch: 'e1', after: 2 },
    ]);
    expect(last().covered).toBe(true);
    expect(last().known.size).toBe(3);
  });

  it('adds pushes in order, ignoring repeats; a gap uncovers it and catches up from what it has', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)]), page('e1', 2, [v(3), v(4), v(5)])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    const version = last().version;
    // A repeat of what it has, then the tail.
    known.push({ epoch: 'e1', from: 0, values: [v(1), v(2)], full: false });
    expect(last().known.size).toBe(2);
    expect(last().version).toBeGreaterThan(version);
    expect(last().covered).toBe(true);
    // Number 4 when it has 2: a gap.
    known.push({ epoch: 'e1', from: 4, values: [v(5)], full: true });
    expect(last().covered).toBe(false);
    await settle();
    expect(b.pages().at(-1)).toEqual({ command: 'getKnownValues', epoch: 'e1', after: 2 });
    expect(last().covered).toBe(true);
    expect(last().known.size).toBe(5);
  });

  it('is uncovered on every hello, until a catch-up from what it has answers done', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)]), page('e1', 1, [])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    expect(last().covered).toBe(true);
    const again = backend([page('e1', 1, [], true)]);
    known.hello(again.send);
    expect(last().covered).toBe(false);
    await settle();
    // Told to watch on the new connection, then asked from what it had.
    expect(again.asked).toEqual([
      { command: 'watchKnownValues', on: true },
      { command: 'getKnownValues', epoch: 'e1', after: 1 },
    ]);
    expect(last().covered).toBe(true);
    expect(last().known.size).toBe(1);
  });

  it('starts over when the backend answers with another epoch (a restart), not keeping old values', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    const b2 = backend([page('e9', 0, [v(2)])]);
    known.hello(b2.send);
    await settle();
    expect(last().covered).toBe(true);
    expect(last().known.size).toBe(1);
    expect(last().known.scan(`x ${v(1)} y`)).toEqual([]);
    expect(last().known.scan(`x ${v(2)} y`)).toHaveLength(1);
  });

  it('keeps the old set shown while catching up on a rebuilt epoch, then swaps', async () => {
    const { known, last } = sync();
    let release!: (value: KnownPage) => void;
    const b = backend([
      page('e1', 0, [v(1)]),
      () => new Promise<KnownPage>((resolve) => (release = resolve)),
      page('e2', 5, [v(7)]),
    ]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    // The backend rebuilt its set: a push announces epoch e2, from its end.
    known.push({ epoch: 'e2', from: 5, values: [v(7)], full: false });
    await settle();
    expect(b.pages().at(-1)).toEqual({ command: 'getKnownValues', epoch: 'e2', after: 0 });
    // Still covered with the old set, which has the push's value too for rows arriving now.
    expect(last().covered).toBe(true);
    expect(last().known.scan(`a ${v(1)} b`)).toHaveLength(1);
    expect(last().known.scan(`a ${v(7)} b`)).toHaveLength(1);
    // Done up to 5, but the push named number 5: it asks on before swapping.
    release(page('e2', 0, [v(2), v(3), v(4), v(5), v(6)]));
    await settle();
    expect(b.pages().at(-1)).toEqual({ command: 'getKnownValues', epoch: 'e2', after: 5 });
    // Swapped: the new set, with the value pushed meanwhile; the old one's values gone.
    expect(last().covered).toBe(true);
    expect(last().known.size).toBe(6);
    expect(last().known.scan(`a ${v(1)} b`)).toEqual([]);
    expect(last().known.scan(`a ${v(7)} b`)).toHaveLength(1);
  });

  it('after a Clear, is uncovered and starts a new set', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)]), page('e2', 0, [])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    known.cleared();
    expect(last().covered).toBe(false);
    expect(last().known.size).toBe(0);
    await settle();
    expect(b.pages().at(-1)).toEqual({ command: 'getKnownValues', epoch: 'e1', after: 0 });
    expect(last().covered).toBe(true);
  });

  it('hides values a Clear’s new epoch pushes before the Clear is heard of', async () => {
    const { known, last } = sync();
    let release!: (value: KnownPage) => void;
    const b = backend([
      page('e1', 0, [v(1)]),
      () => new Promise<KnownPage>((resolve) => (release = resolve)),
      page('e2', 0, [v(9)]),
    ]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    known.push({ epoch: 'e2', from: 0, values: [v(9)], full: false });
    expect(last().covered).toBe(true);
    expect(last().known.scan(`a ${v(9)} b`)).toHaveLength(1);
    known.cleared();
    expect(last().covered).toBe(false);
    expect(last().known.size).toBe(0);
    // The page for the pushed epoch, asked before the Clear was heard of, is asked again.
    release(page('e2', 0, [v(9)]));
    await settle();
    expect(b.pages()).toContainEqual({ command: 'getKnownValues', epoch: 'e1', after: 0 });
    expect(last().covered).toBe(true);
    expect(last().known.scan(`a ${v(9)} b`)).toHaveLength(1);
  });

  it('carries full from pages and pushes', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)], true, true)]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    expect(last().full).toBe(true);
    known.push({ epoch: 'e1', from: 1, values: [], full: false });
    expect(last().full).toBe(false);
  });
});

describe('KnownSync: failing closed', () => {
  it('stays uncovered after an error, and tries again, waiting longer each time', async () => {
    vi.useFakeTimers();
    const { known, last } = sync();
    const b = backend([new Error('boom'), new Error('boom'), page('e1', 0, [v(1)])]);
    known.setOn(true);
    known.hello(b.send);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pages()).toHaveLength(1);
    expect(last().covered).toBe(false);
    // Not before the first wait.
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS - 1);
    expect(b.pages()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.pages()).toHaveLength(2);
    expect(last().covered).toBe(false);
    // The second wait is twice as long.
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS * 2 - 1);
    expect(b.pages()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.pages()).toHaveLength(3);
    expect(last().covered).toBe(true);
    // Each try after a failure says to watch again first.
    expect(b.asked.filter((c) => c.command === 'watchKnownValues')).toHaveLength(3);
  });

  it('treats a reply of the wrong shape as a failure', async () => {
    vi.useFakeTimers();
    const { known, last } = sync();
    for (const wrong of [
      null,
      { epoch: 'e1', values: 'x', next: 0, done: true, full: false },
      { epoch: 'e1', values: [1], next: 1, done: true, full: false },
      { epoch: 'e1', values: [v(1)], next: 0, done: true, full: false },
      { epoch: 'e1', values: [], next: 0, done: 'yes', full: false },
      { epoch: 7, values: [], next: 0, done: true, full: false },
    ]) {
      const b = backend([Promise.resolve(wrong)]);
      known.setOn(false);
      known.setOn(true);
      known.hello(b.send);
      await vi.advanceTimersByTimeAsync(0);
      expect(last().covered, JSON.stringify(wrong)).toBe(false);
    }
  });

  it('treats a page that skips values as a failure', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 3, [v(4)])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    expect(last().covered).toBe(false);
    expect(last().known.size).toBe(0);
  });

  it('treats a push of the wrong shape as a gap', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    known.push({ epoch: 'e1', from: 1, values: [3] });
    expect(last().covered).toBe(false);
  });

  it('treats a push whose values aren’t text as a gap, even when the rest is right', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    expect(last().covered).toBe(true);
    known.push({ epoch: 'e1', from: 1, values: [3], full: false });
    expect(last().covered).toBe(false);
  });

  it('ignores replies from an earlier watch: off then on starts afresh', async () => {
    const { known, last } = sync();
    let release!: (value: KnownPage) => void;
    const b = backend([
      () => new Promise<KnownPage>((resolve) => (release = resolve)),
      page('e2', 0, [v(2)]),
    ]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    known.setOn(false);
    expect(b.asked).toContainEqual({ command: 'watchKnownValues', on: false });
    known.setOn(true);
    await settle();
    // The earlier watch's answer comes late: ignored.
    release(page('e1', 0, [v(1)]));
    await settle();
    expect(last().known.scan(`a ${v(1)} b`)).toEqual([]);
    expect(last().known.scan(`a ${v(2)} b`)).toHaveLength(1);
    expect(last().covered).toBe(true);
  });

  it('says it’s off on every hello while off, as it may have been turned off while disconnected', async () => {
    const { known } = sync();
    const b = backend([]);
    known.hello(b.send);
    await settle();
    expect(b.asked).toEqual([{ command: 'watchKnownValues', on: false }]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    expect(b.asked.filter((c) => c.command === 'watchKnownValues' && c.on === false)).toHaveLength(1);
  });

  it('drops the set when switched off', async () => {
    const { known, last } = sync();
    const b = backend([page('e1', 0, [v(1)])]);
    known.setOn(true);
    known.hello(b.send);
    await settle();
    known.setOn(false);
    expect(last().covered).toBe(false);
    expect(last().known.size).toBe(0);
  });
});
