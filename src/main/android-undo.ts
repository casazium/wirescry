import { readdirSync } from 'node:fs';

/** Whether this folder holds any Android capture records (one .json file per device). */
export function hasRecords(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Blocks until the records folder is empty or `maxMs` has passed, for Windows logging off:
 * 'session-end' handlers must finish before returning, so the main process can't wait for the
 * backend's answer the usual way. The backend, a separate process, deletes each device's
 * record once the device is put back. True if every record went.
 */
export function waitForNoRecordsSync(dir: string, maxMs: number, stepMs = 50): boolean {
  const deadline = Date.now() + maxMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    if (!hasRecords(dir)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    Atomics.wait(sleeper, 0, 0, Math.min(stepMs, left));
  }
}
