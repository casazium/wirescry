/** The main process's wait for the backend to put Android devices back, when Windows logs off. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasRecords, waitForFileSync } from '../src/main/android-undo';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-undo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Waiting for the backend while Windows logs off', () => {
  it('knows whether there are records to put back', async () => {
    expect(hasRecords(path.join(dir, 'missing'))).toBe(false);
    await writeFile(path.join(dir, 'x.json.123.tmp'), '');
    await writeFile(path.join(dir, 'undone-1'), '');
    expect(hasRecords(dir)).toBe(false);
    await writeFile(path.join(dir, `${'a'.repeat(32)}.json`), '{}');
    expect(hasRecords(dir)).toBe(true);
  });

  it('returns at once when the backend is already done', async () => {
    await writeFile(path.join(dir, 'undone-1'), '');
    const started = Date.now();
    expect(waitForFileSync(path.join(dir, 'undone-1'), 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('gives up after its time limit', () => {
    const started = Date.now();
    expect(waitForFileSync(path.join(dir, 'undone-1'), 200)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('notices the backend finishing in another process, though this thread is blocked', async () => {
    const file = path.join(dir, 'undone-1');
    const child = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(file)}, ''), 300)`,
    ]);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const started = Date.now();
    expect(waitForFileSync(file, 10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    await exited;
  });
});
