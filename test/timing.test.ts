/** The timing helpers the "stays linear" tests use, mostly with made-up timings so they're exact. */
import { describe, expect, it } from 'vitest';
import { expectGrowthUnder, growth, timeOnce } from './timing';

const small = (): void => {};
const large = (): void => {};

/** Gives the timings in turn: each round asks for small, large, small, large, … five times. */
const fakeTime = (rounds: Array<[number, number]>) => {
  const calls: Array<'small' | 'large'> = [];
  let call = 0;
  const time = (run: () => void): number => {
    const which = run === small ? 'small' : 'large';
    calls.push(which);
    const [s, l] = rounds[Math.floor(call++ / 10)] ?? [1, 1];
    return which === 'small' ? s : l;
  };
  return { time, calls };
};

/** Work that takes a little while: until the clock has moved on by `ms`. */
const busy = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Wait.
  }
};

describe('growth', () => {
  it('gives the ratio from one round when it’s under the limit, timing the two in turn', () => {
    const { time, calls } = fakeTime([[10, 80]]);
    expect(growth(small, large, { limit: 20, time })).toBe(8);
    expect(calls).toEqual(Array.from({ length: 5 }, () => ['small', 'large']).flat());
  });

  it('takes the fastest of each of the five', () => {
    let call = 0;
    const timings = [30, 300, 10, 250, 20, 80, 15, 90, 12, 85];
    const time = (): number => timings[call++] ?? 0;
    expect(growth(small, large, { limit: 20, time })).toBe(8);
  });

  it('times another round when a busy one goes over, and gives the ratio of the fastest', () => {
    const { time, calls } = fakeTime([
      [10, 211],
      [10, 85],
    ]);
    expect(growth(small, large, { limit: 20, time })).toBe(8.5);
    expect(calls).toHaveLength(20);
  });

  it('keeps the fastest timings across rounds, not the best round’s ratio', () => {
    // Round by round the ratios are 30, 11 and 11; the fastest timings, 10 and 300, give 30.
    const { time, calls } = fakeTime([
      [10, 300],
      [30, 330],
      [30, 330],
    ]);
    expect(growth(small, large, { limit: 20, time })).toBe(30);
    expect(calls).toHaveLength(30);
  });

  it('gets under the limit when a busy round slowed only the large side', () => {
    const { time } = fakeTime([
      [10, 300],
      [12, 90],
    ]);
    expect(growth(small, large, { limit: 20, time })).toBe(9);
  });

  it('stays over the limit for work that grows too fast, after the rounds it’s given', () => {
    const { time, calls } = fakeTime([
      [10, 640],
      [10, 640],
      [10, 640],
      [10, 80],
    ]);
    expect(growth(small, large, { limit: 20, time })).toBe(64);
    expect(calls).toHaveLength(30);
  });

  it('times only as many rounds as it’s asked to', () => {
    const { time, calls } = fakeTime([
      [10, 640],
      [10, 80],
    ]);
    expect(growth(small, large, { limit: 20, rounds: 1, time })).toBe(64);
    expect(calls).toHaveLength(10);
  });

  it('counts a ratio right at the limit as over it', () => {
    const { time, calls } = fakeTime([
      [10, 200],
      [10, 80],
    ]);
    expect(growth(small, large, { limit: 20, time })).toBe(8);
    expect(calls).toHaveLength(20);
  });

  it('gives no number under the limit when the small run takes no time', () => {
    expect(growth(small, large, { limit: 20, time: fakeTime([[0, 0]]).time })).toBeNaN();
    expect(growth(small, large, { limit: 20, time: fakeTime([[0, 5]]).time })).toBe(Infinity);
  });

  it('times the real work when given no clock', () => {
    let smallRuns = 0;
    let largeRuns = 0;
    const ratio = growth(
      () => {
        smallRuns++;
        busy(1);
      },
      () => {
        largeRuns++;
        busy(3);
      },
      { limit: 1000 },
    );
    expect([smallRuns, largeRuns]).toEqual([5, 5]);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(1000);
  });
});

describe('expectGrowthUnder', () => {
  it('passes for work that grows in proportion', () => {
    expect(() =>
      expectGrowthUnder(
        () => busy(1),
        () => busy(2),
        50,
      ),
    ).not.toThrow();
  });

  it('fails for work that grows past the limit, every round', () => {
    expect(() =>
      expectGrowthUnder(
        () => busy(0.5),
        () => busy(10),
        5,
      ),
    ).toThrow(/to be less than 5/);
  });
});

describe('timeOnce', () => {
  it('runs the work once and gives how long it took', () => {
    let runs = 0;
    const took = timeOnce(() => {
      runs++;
      busy(2);
    });
    expect(runs).toBe(1);
    expect(took).toBeGreaterThanOrEqual(2);
    expect(took).toBeLessThan(1000);
  });
});
