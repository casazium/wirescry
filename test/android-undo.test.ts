/** The main process's wait for Android records to go, when Windows logs off. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasRecords, waitForNoRecordsSync } from '../src/main/android-undo';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-undo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Waiting for Android records to go', () => {
  it('returns at once when there are none, or no folder', () => {
    expect(hasRecords(path.join(dir, 'missing'))).toBe(false);
    expect(waitForNoRecordsSync(path.join(dir, 'missing'), 5000)).toBe(true);
  });

  it('ignores files that aren’t records', async () => {
    await writeFile(path.join(dir, 'x.json.123.tmp'), '');
    expect(waitForNoRecordsSync(dir, 5000)).toBe(true);
  });

  it('gives up after its time limit', async () => {
    await writeFile(path.join(dir, 'a.json'), '{}');
    const started = Date.now();
    expect(waitForNoRecordsSync(dir, 200)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns once another process deletes the last record, though this thread is blocked', async () => {
    const file = path.join(dir, 'a.json');
    await writeFile(file, '{}');
    const child = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').unlinkSync(${JSON.stringify(file)}), 300)`,
    ]);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const started = Date.now();
    expect(waitForNoRecordsSync(dir, 10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    await exited;
  });
});
