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
import {
  learnFrom,
  maskBytes,
  maskFormatted,
  maskMessages,
  maskSseItems,
  type MaskedBytes,
  type MaskedMessage,
  type MessageBytes,
} from './mask-body.ts';
import type { SseItem } from '../shared/sse.ts';

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
    }
  /** A page of a WebSocket's messages, in order. */
  | { op: 'messages'; own: Json; stream: Stream; messages: MessageBytes[] }
  /** A page of a Server-Sent Events stream's items, in order. */
  | { op: 'events'; own: Json; stream: Stream; items: SseItem[] };

/**
 * Which stream a page is from, so what's learned in one page is hidden in the next. `fresh` when
 * the window reads it from the start: it reads in order, so what it was shown stays the same.
 */
export interface Stream {
  key: string;
  fresh: boolean;
}
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
  | { id: number; ok: true; messages: MaskedMessage[]; full: boolean }
  | { id: number; ok: true; items: SseItem[]; full: boolean }
  | { id: number; ok: false; error: string };

const session = new KnownValues();

/** What each stream has learned, for the streams read most recently. */
const streams = new Map<string, KnownValues>();
const MAX_STREAMS = 20;

/** A stream's known values: its exchange's and the session's, and what its pages taught. */
function streamKnown(stream: Stream, own: Json): KnownValues {
  let known = stream.fresh ? undefined : streams.get(stream.key);
  streams.delete(stream.key);
  if (!known) {
    known = new KnownValues();
    try {
      collectKnown(own, known);
    } catch {
      // Nothing learned from them.
    }
  }
  // The session's values, those taught since the last page too.
  known.addAll(session);
  streams.set(stream.key, known);
  if (streams.size > MAX_STREAMS) streams.delete(streams.keys().next().value!);
  return known;
}

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
  if (message.op === 'messages') {
    const known = streamKnown(message.stream, message.own);
    return { id: message.id, ok: true, messages: maskMessages(message.messages, known), full: known.full };
  }
  if (message.op === 'events') {
    const known = streamKnown(message.stream, message.own);
    return { id: message.id, ok: true, items: maskSseItems(message.items, known), full: known.full };
  }
  const known = new KnownValues();
  // Headers or a request body that can't be read teach nothing; the body is still masked.
  try {
    collectKnown(message.own, known);
  } catch {
    // Nothing learned from them.
  }
  if (message.request) {
    const { bytes, mediaType, cut } = message.request;
    try {
      learnFrom(bytes, mediaType, cut, known);
    } catch {
      // Nothing learned from it.
    }
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
