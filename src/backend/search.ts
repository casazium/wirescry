import type { BodySide, ExchangeDetail } from '../shared/api';
import { compileQuery, MAX_QUERY_LENGTH, type BodyTerm } from '../shared/query';
import { searchBody, type BodySearchResult, type BodySource, type Tick } from './body-search';
import type { RequestStore } from './store';

/** How body search reaches an exchange's stored bodies. */
export interface BodyAccess {
  /** One side's body, or undefined if it has none. */
  source(detail: ExchangeDetail, side: BodySide): BodySource | undefined;
}

/**
 * Searches one window has named and can cancel, at most; past this its oldest is canceled. The
 * window needs one or two; each running search costs the proxy a slice per turn.
 */
export const MAX_NAMED_SEARCHES = 8;
export const MAX_SEARCH_ID_LENGTH = 64;

/** Throws unless `id` is a name a window may give a search. */
export function checkSearchId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '' || id.length > MAX_SEARCH_ID_LENGTH)
    throw new Error(`searchId must be text of 1 to ${MAX_SEARCH_ID_LENGTH} characters`);
}

/** Why a search stopped before it finished. */
export type StopReason = 'canceled' | 'cleared' | 'closed' | 'stopped';

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
  /** Bodies, for body terms. Without it, every exchange has none. */
  bodies?: BodyAccess;
  /** Filled with the matching or not ids whose bodies were only partly searched for a body term. */
  partial?: Set<string>;
  /** Called with how many exchanges are done, at most every PROGRESS_MS and once at the end. */
  onProgress?: (done: number, total: number) => void;
}

/** Progress at most this often. */
export const PROGRESS_MS = 250;

const NO_BODY: BodySearchResult = { found: new Set(), partial: false };

/** Whether an exchange's bodies pass every body term, and whether that's from part of a body. */
async function matchBodies(
  detail: ExchangeDetail,
  terms: readonly BodyTerm[],
  bodies: BodyAccess | undefined,
  tick: Tick,
): Promise<{ matches: boolean; partial: boolean }> {
  const search = async (side: BodySide, needles: string[]): Promise<BodySearchResult> => {
    if (needles.length === 0) return NO_BODY;
    const source = bodies?.source(detail, side);
    return source ? searchBody(source, [...new Set(needles)], tick) : NO_BODY;
  };
  const request = await search(
    'request',
    terms.filter((t) => t.side !== 'response').map((t) => t.needle),
  );
  // A body~ term found in the request needs nothing from the response.
  const response = await search(
    'response',
    terms
      .filter((t) => t.side === 'response' || (t.side === 'both' && !request.found.has(t.needle)))
      .map((t) => t.needle),
  );
  let matches = true;
  let partial = false;
  for (const term of terms) {
    const inRequest = term.side !== 'response' && request.found.has(term.needle);
    const inResponse = term.side !== 'request' && response.found.has(term.needle);
    const found = inRequest || inResponse;
    if (term.negated === found) matches = false;
    if (!found) {
      if (term.side !== 'response' && request.partial) partial = true;
      if (term.side !== 'request' && response.partial) partial = true;
    }
  }
  return { matches, partial };
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
  const { signal, onProgress } = options;
  let sliceStart = now();
  // Between chunks of a body, too: one large body mustn't hold the proxy up.
  const tick: Tick = async () => {
    if (signal?.aborted) throw signal.reason;
    if (now() - sliceStart >= sliceMs) {
      await yieldNow();
      sliceStart = now();
      if (signal?.aborted) throw signal.reason;
    }
  };
  let lastProgress = now();
  let done = 0;
  for (const id of candidates) {
    if (signal?.aborted) throw signal.reason;
    const detail = store.get(id);
    // Body terms last, and only if everything else matched: they're the costly part.
    if (detail && compiled.matchesDetail(detail)) {
      if (compiled.bodyTerms.length === 0) matched.push(id);
      else {
        const result = await matchBodies(detail, compiled.bodyTerms, options.bodies, tick);
        // Still there: one deleted while its bodies were read isn't answered about. (One that
        // changed meanwhile is asked about again, from the window's batch.)
        if (store.get(id) !== undefined) {
          if (result.matches) matched.push(id);
          if (result.partial) options.partial?.add(id);
        }
      }
    }
    done++;
    if (onProgress && now() - lastProgress >= PROGRESS_MS) {
      lastProgress = now();
      onProgress(done, candidates.length);
    }
    if (now() - sliceStart >= sliceMs) {
      await yieldNow();
      sliceStart = now();
    }
  }
  if (signal?.aborted) throw signal.reason;
  onProgress?.(candidates.length, candidates.length);
  return matched;
}
