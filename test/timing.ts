/**
 * Timing helpers for the "stays linear" tests: how much longer a run on eight times the input
 * takes. Linear work comes out near 8, quadratic near 64.
 */
import { expect } from 'vitest';

/** How long one call of `run` takes, in milliseconds. */
export const timeOnce = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

/**
 * How much longer `large` takes than `small`, from the fastest timing of each. They're timed in
 * turn, five of each to a round, so a busy spell slows both alike. A shared CI machine can still
 * slow one side through a whole round, so while the ratio is at `limit` or more, another round is
 * timed, up to `rounds` rounds in all. The fastest timings are kept across rounds: noise only ever
 * makes a run slower, so more timings bring the ratio closer to the true one, never below it.
 */
export function growth(
  small: () => void,
  large: () => void,
  {
    limit,
    rounds = 3,
    time = timeOnce,
  }: { limit: number; rounds?: number; time?: (run: () => void) => number },
): number {
  let fastSmall = Infinity;
  let fastLarge = Infinity;
  let ratio = Infinity;
  for (let round = 0; round < rounds && ratio >= limit; round++) {
    for (let i = 0; i < 5; i++) {
      fastSmall = Math.min(fastSmall, time(small));
      fastLarge = Math.min(fastLarge, time(large));
    }
    ratio = fastLarge / fastSmall;
  }
  return ratio;
}

/** Fails unless `large` takes less than `limit` times as long as `small` (see growth). */
export function expectGrowthUnder(small: () => void, large: () => void, limit: number): void {
  expect(growth(small, large, { limit })).toBeLessThan(limit);
}
