/** What's wrong with a packaged app's self-test result, or undefined when it passed. */
export function selfTestProblem(
  result: unknown,
  options: { code?: number | null; maxStartMs: number; expectPro: boolean },
): string | undefined;
