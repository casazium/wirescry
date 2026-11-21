/**
 * Masks bodies for the window while View › Hide Secrets is on, in a worker thread, so a large body
 * never stalls the proxy (see src/backend/masker.ts).
 *
 * It keeps the session's known values: those in every exchange's URL, headers and trailers, taught
 * as they arrive. Each body is masked with a fresh set: its own exchange's values first, then the
 * session's, so one job never changes what the next finds.
 *
 * Its imports carry `.ts` and are pure, so Node runs it from source in tests.
 */
import { parentPort } from 'node:worker_threads';
import { KnownValues } from '../shared/redact-body.ts';
import { collectKnown } from './har-redact.ts';
import { learnFrom, maskBytes, maskFormatted, type MaskedBytes } from './mask-body.ts';

type Json = Record<string, unknown>;

export interface BodyBytes {
  bytes: Uint8Array;
  mediaType: string;
  /** Only its start was kept. */
  cut: boolean;
}

export type MaskJob =
  /** Exchanges' URLs, headers and trailers, as HAR entries' parts (har-redact's knownPart). */
  | { op: 'teach'; parts: Json[] }
  | {
      op: 'mask';
      /** The exchange's own URL, headers and trailers. */
      own: Json;
      /** For a response: its request's body, whose values are learned first. */
      request?: BodyBytes;
      body: BodyBytes;
      /** The body formatted, to mask the same way. */
      formatted?: string;
    };
export type MaskRequest = MaskJob & { id: number };

export type MaskResponse =
  | { id: number; ok: true; taught: true }
  | {
      id: number;
      ok: true;
      masked:
        | Exclude<MaskedBytes, { literals: string[] }>
        | Omit<Extract<MaskedBytes, { literals: string[] }>, 'literals'>;
      /** The formatted text masked; null if it can't be shown. */
      formatted?: string | null;
      /** A value was turned away for want of room, so one seen earlier may not be hidden. */
      full: boolean;
    }
  | { id: number; ok: false; error: string };

const session = new KnownValues();

function handle(message: MaskRequest): MaskResponse {
  if (message.op === 'teach') {
    for (const part of message.parts) {
      try {
        collectKnown(part, session);
      } catch {
        // A part that can't be read teaches nothing.
      }
    }
    return { id: message.id, ok: true, taught: true };
  }
  const known = new KnownValues();
  collectKnown(message.own, known);
  if (message.request) {
    const { bytes, mediaType, cut } = message.request;
    learnFrom(bytes, mediaType, cut, known);
  }
  known.addAll(session);
  const { bytes, mediaType, cut } = message.body;
  const result = maskBytes(bytes, mediaType, cut, known);
  let formatted: string | null | undefined;
  if (message.formatted !== undefined) {
    formatted =
      'hidden' in result
        ? null
        : (maskFormatted(message.formatted, mediaType, result.literals, known) ?? null);
  }
  if ('hidden' in result) return { id: message.id, ok: true, masked: result, formatted, full: known.full };
  const { literals: _literals, ...masked } = result;
  void _literals;
  return {
    id: message.id,
    ok: true,
    masked,
    ...(formatted !== undefined ? { formatted } : {}),
    full: known.full,
  };
}

parentPort?.on('message', (message: MaskRequest) => {
  let response: MaskResponse;
  try {
    response = handle(message);
  } catch (error) {
    response = { id: message.id, ok: false, error: (error as Error).message };
  }
  parentPort!.postMessage(response);
});
