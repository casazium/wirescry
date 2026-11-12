import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLogger, levelForOutput, lineSplitter } from '../src/main/logger';

describe('FileLogger', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-log-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes timestamped lines with level and source', async () => {
    const logger = new FileLogger(dir);
    logger.write('backend', 'error', 'first line\nsecond line\n');
    logger.close();
    const lines = (await readFile(logger.file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR \[backend\] first line$/);
    expect(lines[1]).toMatch(/ERROR \[backend\] second line$/);
  });

  it('redacts secrets, including ones added later', async () => {
    const logger = new FileLogger(dir, { secrets: ['first-secret-value'] });
    logger.addSecret('later-secret-value');
    logger.write('main', 'info', 'token first-secret-value and later-secret-value');
    logger.close();
    const text = await readFile(logger.file, 'utf8');
    expect(text).toContain('token [redacted] and [redacted]');
    expect(text).not.toContain('secret-value');
  });

  it('starts a new file past the size limit, keeping one old file', async () => {
    const logger = new FileLogger(dir, { maxBytes: 200 });
    for (let round = 0; round < 3; round++) {
      logger.write('main', 'info', `round ${round} ${'x'.repeat(120)}`);
      logger.flush();
    }
    logger.close();
    expect((await readdir(dir)).sort()).toEqual(['wirescry.log', 'wirescry.old.log']);
    expect(await readFile(logger.file, 'utf8')).toContain('round 2');
    expect(await readFile(path.join(dir, 'wirescry.old.log'), 'utf8')).toContain('round 1');
  });
});

describe('lineSplitter', () => {
  it('joins chunks into whole lines and skips blank ones', () => {
    const lines: string[] = [];
    const feed = lineSplitter((line) => lines.push(line));
    feed('par');
    feed('tial\nsecond\n\nthi');
    feed(Buffer.from('rd\n'));
    expect(lines).toEqual(['partial', 'second', 'third']);
  });
});

describe('levelForOutput', () => {
  it.each([
    // Node's deprecation notices, as electron-updater's in 0.1.28 (logged as ERROR then).
    [
      '(node:7604) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true, as the arguments are not escaped, only concatenated.\n(Use `Wirescry --trace-deprecation ...` to show where the warning was created)',
      'error',
      'info',
    ],
    ['(node:12) DeprecationWarning: Buffer() is deprecated', 'error', 'info'],
    ['(Use `Wirescry --trace-deprecation ...` to show where the warning was created)', 'error', 'info'],
    // The hint after another kind of warning stays at that warning's level.
    ['(Use `node --trace-warnings ...` to show where the warning was created)', 'error', 'warn'],
    // Other Node warnings stay warnings.
    ['(node:12) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.', 'error', 'warn'],
    ['(node:12) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental', 'error', 'warn'],
    ['(node:12) ExperimentalWarning: Type Stripping is an experimental feature', 'warn', 'warn'],
    ['(node:12) [DEP0005] DeprecationWarning: Buffer() is deprecated', 'warn', 'info'],
  ] as const)('%s: %s becomes %s', (text, level, expected) => {
    expect(levelForOutput(text, level)).toBe(expected);
  });

  it.each([
    // Real errors, and text that only mentions a warning, keep their level.
    ['went wrong', 'error'],
    ['Error: DeprecationWarning in a message', 'error'],
    ['Uncaught exception: TypeError: x is not a function', 'error'],
    ['  (node:12) DeprecationWarning: indented, so not Node', 'error'],
    ['(node:abc) DeprecationWarning: not a pid', 'error'],
    ['(node:12) Deprecation: no Warning suffix', 'error'],
    ['(Use this --trace-deprecation flag)', 'error'],
    ['(Use `app --trace-deprecation` to debug the crash above)', 'error'],
    ["DeprecationWarning: a library's own message", 'warn'],
  ] as const)('keeps %j at %s', (text, level) => {
    expect(levelForOutput(text, level)).toBe(level);
  });

  it('never raises info output', () => {
    expect(levelForOutput('(node:12) MaxListenersExceededWarning: x', 'info')).toBe('info');
  });
});
