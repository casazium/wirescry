import { compileQuery, MAX_QUERY_LENGTH } from '../shared/query';
import type { RequestStore } from './store';

/** Searches the window has named and can cancel, at most; past this the oldest is canceled. */
export const MAX_NAMED_SEARCHES = 32;
export const MAX_SEARCH_ID_LENGTH = 64;

/** Throws unless `id` is a name a window may give a search. */
export function checkSearchId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '' || id.length > MAX_SEARCH_ID_LENGTH)
    throw new Error(`searchId must be text of 1 to ${MAX_SEARCH_ID_LENGTH} characters`);
}

/** Why a search stopped before it finished. */
export type StopReason = 'canceled' | 'cleared' | 'closed';

/** Thrown by a search whose signal aborted, with why. */
export class SearchStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`Search ${reason}`);
  }
}

export interface MatchOptions {
  /** Stops the search, which then throws its reason (a SearchStopped). */
  signal?: AbortSignal;
  /** Work this long, in milliseconds, before letting the proxy run. */
  sliceMs?: number;
  /** Lets other work run; replaceable in tests. */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

const SLICE_MS = 8;

/**
 * The ids of the exchanges that match the whole search query (header terms included), among
 * `ids` or all of them. Ids no longer in the store are skipped.
 *
 * Header values can be large, and this runs in the proxy's own process, so it works in short
 * slices and yields between them: traffic keeps flowing while a search runs.
 */
export async function matchExchanges(
  store: RequestStore,
  query: string,
  ids?: readonly string[],
  options: MatchOptions = {},
): Promise<string[]> {
  if (query.length > MAX_QUERY_LENGTH) throw new Error('The search is too long');
  const { sliceMs = SLICE_MS, now = () => performance.now() } = options;
  const yieldNow = options.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const compiled = compileQuery(query);
  // The ids now; anything added while this runs comes to the UI in a batch, which asks again.
  // Each once, in the order given.
  const candidates = ids ? [...new Set(ids)] : store.list().map((e) => e.id);
  const matched: string[] = [];
  const { signal } = options;
  let sliceStart = now();
  for (const id of candidates) {
    if (signal?.aborted) throw signal.reason;
    const detail = store.get(id);
    if (detail && compiled.matchesDetail(detail)) matched.push(id);
    if (now() - sliceStart >= sliceMs) {
      await yieldNow();
      sliceStart = now();
    }
  }
  if (signal?.aborted) throw signal.reason;
  return matched;
}
