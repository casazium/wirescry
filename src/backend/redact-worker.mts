/**
 * Redacts HAR entries for export in a worker thread, so a large body never stalls the proxy, which
 * runs in the backend's own thread (see src/backend/redactor.ts). One worker per export: its known
 * values are that export's alone.
 *
 * Its imports carry `.ts` and are pure, so Node runs it from source in tests.
 */
import { parentPort } from 'node:worker_threads';
import { KnownValues, SHARED_URL_SHARE } from '../shared/redact-body.ts';
import { collectHeaders, collectUrl, redactHarEntry, type EntryMeta } from './har-redact.ts';

type Json = Record<string, unknown>;

/** What's asked of the worker. */
export type RedactJob =
  /** URLs and headers to learn; then values an earlier worker learned, and whether it was full. */
  | { op: 'collect'; parts: Json[]; values?: string[]; full?: boolean }
  /** An entry redacted only to learn what its bodies name; answers with the values added. */
  | { op: 'learn'; entry: Json; meta: EntryMeta }
  | { op: 'redact'; entry: Json; meta: EntryMeta; giveBack?: boolean };
export type RedactRequest = RedactJob & { id: number };

export type RedactResponse =
  | { id: number; ok: true; collected: true }
  | { id: number; ok: true; learned: string[]; full: boolean }
  | {
      id: number;
      ok: true;
      /** The redacted entry as JSON text, ready to write. */
      text: string;
      values: number;
      notScanned: number;
      leftOut: number;
      /** Whether a known value was turned away for want of room. */
      full: boolean;
      /** How long the work took, in milliseconds. */
      ms: number;
    }
  | { id: number; ok: true; tooLarge: true }
  /** The entry's URL or headers couldn't be redacted: it's left out. */
  | { id: number; ok: true; dropped: true; error: string }
  | { id: number; ok: false; error: string };

const known = new KnownValues();

function handle(message: RedactRequest): RedactResponse {
  if (message.op === 'collect') {
    // Every entry's headers and trailers, then every URL: URLs of junk can't take the room header
    // values need.
    for (const learn of [
      (part: Json) => collectHeaders(part, known),
      (part: Json) => collectUrl(part, known, SHARED_URL_SHARE),
    ]) {
      for (const part of message.parts) {
        try {
          learn(part);
        } catch {
          // A part that can't be read: its entry is dropped when redacted (its URL or headers fail).
        }
      }
    }
    for (const value of message.values ?? []) known.add(value);
    if (message.full) known.markFull();
    return { id: message.id, ok: true, collected: true };
  }
  if (message.op === 'learn') {
    const before = known.size;
    try {
      redactHarEntry(message.entry, message.meta, known);
    } catch (error) {
      // Its URL or headers couldn't be redacted: the entry is dropped when written.
      return { id: message.id, ok: true, dropped: true, error: (error as Error).message };
    }
    return { id: message.id, ok: true, learned: known.list(before, Infinity), full: known.full };
  }
  const started = performance.now();
  let redacted;
  try {
    redacted = redactHarEntry(message.entry, message.meta, known, message.giveBack ?? true);
  } catch (error) {
    return { id: message.id, ok: true, dropped: true, error: (error as Error).message };
  }
  let text: string;
  try {
    text = JSON.stringify(redacted.entry);
  } catch (error) {
    // Longer than a string can be: the caller tries again with fewer bodies.
    if (error instanceof RangeError) return { id: message.id, ok: true, tooLarge: true };
    throw error;
  }
  return {
    id: message.id,
    ok: true,
    text,
    values: redacted.values,
    notScanned: redacted.notScanned,
    leftOut: redacted.leftOut,
    full: known.full,
    ms: performance.now() - started,
  };
}

parentPort?.on('message', (message: RedactRequest) => {
  let response: RedactResponse;
  try {
    response = handle(message);
  } catch (error) {
    response = { id: message.id, ok: false, error: (error as Error).message };
  }
  parentPort!.postMessage(response);
});
