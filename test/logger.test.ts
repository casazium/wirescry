import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLogger, lineSplitter } from '../src/main/logger';

describe('FileLogger', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-log-test-'));
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
    expect((await readdir(dir)).sort()).toEqual(['leverframe.log', 'leverframe.old.log']);
    expect(await readFile(logger.file, 'utf8')).toContain('round 2');
    expect(await readFile(path.join(dir, 'leverframe.old.log'), 'utf8')).toContain('round 1');
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
