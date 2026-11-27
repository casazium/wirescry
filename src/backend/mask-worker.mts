/**
 * Masks bodies for the window while View › Hide Secrets is on, in a worker thread, so a large body
 * never stalls the proxy (see src/backend/masker.ts).
 *
 * It keeps the session's known values: those in every exchange's URL, headers and trailers, taught
 * as they arrive. Each body is masked with a set of its own over the session's: its own exchange's
 * values and what its bodies teach go in it, with room the session's values can't take, and one
 * job never adds to what the next finds.
 *
 * Its imports carry `.ts` and are pure, so Node runs it from source in tests.
 */
import { parentPort } from 'node:worker_threads';
import { KnownValues, OWN_URL_SHARE, REQUEST_BODY_SHARE, SHARED_URL_SHARE } from '../shared/redact-body.ts';
import { collectKnown } from './har-redact.ts';
import {
  learnFrom,
  maskBytes,
  maskFields,
  maskFormatted,
  maskMessages,
  maskSseItems,
  type MaskedBytes,
  type MaskedMessage,
  type MaskField,
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
  | { op: 'events'; own: Json; stream: Stream; items: SseItem[] }
  /** Summary and header fields of one exchange, with its own values and the session's. */
  | { op: 'fields'; own: Json; fields: MaskField[] };

/**
 * Which stream a page is from, so what's learned in one page is hidden in the next. `fresh` when
 * it's read from the start: nothing earlier to have learned from.
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
  /** `lost`: nothing was learned from this stream's earlier pages (see streamKnown). */
  | { id: number; ok: true; messages: MaskedMessage[]; full: boolean; lost: boolean }
  | { id: number; ok: true; items: SseItem[]; full: boolean; lost: boolean }
  | { id: number; ok: true; fields: string[]; full: boolean }
  | { id: number; ok: false; error: string };

const session = new KnownValues();

/** What each stream has learned, over the session's values, for the streams read most recently. */
const streams = new Map<string, { known: KnownValues }>();
const MAX_STREAMS = 20;

/**
 * A stream's known values: its exchange's and the session's, and what its pages taught. Never
 * forgotten while the worker runs (learning again from the start changes nothing); `lost` when a
 * page from partway through finds nothing learned (the worker restarted, or too many streams
 * since), so the caller can teach it the earlier pages.
 */
function streamKnown(stream: Stream, own: Json): { known: KnownValues; lost: boolean } {
  let entry = streams.get(stream.key);
  streams.delete(stream.key);
  const lost = !entry && !stream.fresh;
  // Over the session's values, so it finds what the session learns later too.
  entry ??= { known: new KnownValues(session) };
  // Its exchange's own values each time: response headers and trailers can arrive later. The URL's
  // share is counted for the stream's life.
  try {
    collectKnown(own, entry.known, OWN_URL_SHARE);
  } catch {
    // Nothing learned from them.
  }
  streams.set(stream.key, entry);
  if (streams.size > MAX_STREAMS) streams.delete(streams.keys().next().value!);
  return { known: entry.known, lost };
}

function handle(message: MaskRequest): MaskResponse {
  if (message.op === 'teach') {
    for (const part of message.parts) {
      try {
        collectKnown(part, session, SHARED_URL_SHARE);
      } catch {
        // A part that can't be read teaches nothing.
      }
    }
    return { id: message.id, ok: true, taught: true };
  }
  if (message.op === 'messages') {
    const { known, lost } = streamKnown(message.stream, message.own);
    const messages = maskMessages(message.messages, known);
    return { id: message.id, ok: true, messages, full: known.full, lost };
  }
  if (message.op === 'events') {
    const { known, lost } = streamKnown(message.stream, message.own);
    const items = maskSseItems(message.items, known);
    return { id: message.id, ok: true, items, full: known.full, lost };
  }
  // The exchange's own values, in a set over the session's, so the session's can't crowd them out.
  const known = new KnownValues(session);
  // Headers or a request body that can't be read teach nothing; the body is still masked.
  try {
    collectKnown(message.own, known, OWN_URL_SHARE);
  } catch {
    // Nothing learned from them.
  }
  if (message.op === 'mask' && message.request) {
    const { bytes, mediaType, cut } = message.request;
    try {
      // A share of the room: the rest is for what the body being masked teaches.
      known.share('request body', REQUEST_BODY_SHARE, () => learnFrom(bytes, mediaType, cut, known));
    } catch {
      // Nothing learned from it.
    }
  }
  if (message.op === 'fields') {
    return { id: message.id, ok: true, fields: maskFields(message.fields, known), full: known.full };
  }
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
