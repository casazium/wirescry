import { existsSync, readdirSync } from 'node:fs';

/** Whether this folder holds any Android capture records (one .json file per device). */
export function hasRecords(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Sleeps without returning to the event loop. */
function blockFor(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Not allowed on this thread: spin instead.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // Waiting.
    }
  }
}

/**
 * Blocks until `file` exists or `maxMs` has passed, for Windows logging off: 'session-end'
 * handlers must finish before returning, so the main process can't wait for the backend's
 * answer the usual way. The backend, a separate process, writes the file when it's done. True
 * if it did in time.
 */
export function waitForFileSync(file: string, maxMs: number, stepMs = 25): boolean {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (existsSync(file)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    blockFor(Math.min(stepMs, left));
  }
}
