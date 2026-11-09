/**
 * What's wrong with a packaged app's self-test result (see self-test-packaged.mjs), or
 * undefined when it passed.
 *
 * @param {any} result What the app wrote, or undefined if it wrote nothing.
 * @param {{ code?: number | null, maxStartMs: number, expectPro: boolean }} options
 * @returns {string | undefined}
 */
export function selfTestProblem(result, { code, maxStartMs, expectPro }) {
  if (!result) return `exited (code ${code}) without a result`;
  if (result.error) return result.error;
  // A development build runs Pro without a license (import.meta.env.DEV): never ship one. Also
  // refused when the app doesn't say, as one built before this check wouldn't.
  if (result.developmentBuild !== false) {
    return result.developmentBuild === true
      ? 'this is a development build, which runs Pro without a license'
      : "the app didn't say whether it's a development build";
  }
  if (result.backendStartMs > maxStartMs) {
    return `the backend took ${Math.round(result.backendStartMs / 1000)} s to start (the limit is ${maxStartMs / 1000} s)`;
  }
  if (expectPro) {
    // Unlicensed is fine: Pro still starts, and locks its features itself.
    const pro = result.plugins?.find((p) => p.name === 'pro');
    if (!pro) return 'Pro did not load; see the log';
    if (!pro.active) return `Pro did not start: ${pro.reason}`;
  }
  return undefined;
}
