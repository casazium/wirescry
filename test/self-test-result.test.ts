/** The packaged-app self-test's verdict (scripts/self-test-result.mjs), as the release workflow uses it. */
import { describe, expect, it } from 'vitest';
import { selfTestProblem } from '../scripts/self-test-result.mjs';

const options = { code: 0, maxStartMs: 30_000, expectPro: true };
const good = {
  developmentBuild: false,
  backendStartMs: 1200,
  plugins: [{ name: 'pro', active: true }],
};

describe('The packaged-app self-test', () => {
  it('passes a release build whose backend and Pro started', () => {
    expect(selfTestProblem(good, options)).toBeUndefined();
    expect(selfTestProblem({ ...good, plugins: [] }, { ...options, expectPro: false })).toBeUndefined();
  });

  it('fails a development build, which runs Pro without a license', () => {
    expect(selfTestProblem({ ...good, developmentBuild: true }, options)).toBe(
      'this is a development build, which runs Pro without a license',
    );
  });

  it('fails an app that doesn’t say what kind of build it is', () => {
    const unsaid: Partial<typeof good> = { ...good };
    delete unsaid.developmentBuild;
    expect(selfTestProblem(unsaid, options)).toBe("the app didn't say whether it's a development build");
    expect(selfTestProblem({ ...good, developmentBuild: 'no' }, options)).toBe(
      "the app didn't say whether it's a development build",
    );
  });

  it('still fails what it failed before', () => {
    expect(selfTestProblem(undefined, { ...options, code: 3 })).toBe('exited (code 3) without a result');
    expect(selfTestProblem({ error: 'boom' }, options)).toBe('boom');
    expect(selfTestProblem({ ...good, backendStartMs: 45_000 }, options)).toMatch(/took 45 s to start/);
    expect(selfTestProblem({ ...good, plugins: [] }, options)).toBe('Pro did not load; see the log');
    expect(
      selfTestProblem({ ...good, plugins: [{ name: 'pro', active: false, reason: 'no bytecode' }] }, options),
    ).toBe('Pro did not start: no bytecode');
  });
});
