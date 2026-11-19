import type { BodySide, ExchangeDetail } from '../shared/api';
import { compileQuery, MAX_QUERY_LENGTH, type BodyTerm } from '../shared/query';
import { memoKey, type BodyMemo, type MemoValue } from './body-memo';
import {
  searchBody,
  type BodySearchReport,
  type BodySearchResult,
  type BodySource,
  type Tick,
} from './body-search';
import type { BodyState } from './body-store';
import type { RequestStore } from './store';

/** One side's body, as body search reads it, with its state when known (for the memo). */
export type BodyAccessSource = BodySource & { state?: BodyState };

/** How body search reaches an exchange's stored bodies. */
export interface BodyAccess {
  /** One side's body, finished or still arriving, or undefined if it has none. */
  source(detail: ExchangeDetail, side: BodySide): BodyAccessSource | undefined;
}

/**
 * A body still arriving is searched again no sooner than this many times its last search's cost:
 * a large stream that doesn't match then costs at most about a tenth of the proxy's time. That's
 * per stream: several at once cost more, though searching still yields every few milliseconds.
 */
export const RESCAN_COST_FACTOR = 10;
/** The least time between searches of one arriving body, however cheap. */
export const MIN_RESCAN_MS = 10;

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
  /** Remembers what bodies held, across searches. */
  memo?: BodyMemo;
  /**
   * Asks for the exchange to be searched again at `at` (the search's clock): an arriving body
   * whose last part came while searching it again had to wait.
   */
  nudge?: (exchangeId: string, at: number) => void;
}

/** Progress at most this often. */
export const PROGRESS_MS = 250;

const NO_BODY: BodySearchResult = { found: new Set(), partial: false };

/** Searches one side's body, or answers from the memo when nothing about it has changed. */
async function searchSide(
  detail: ExchangeDetail,
  side: BodySide,
  needles: string[],
  tick: Tick,
  options: MatchOptions,
  stillThere: () => boolean,
): Promise<BodySearchResult> {
  if (needles.length === 0) return NO_BODY;
  const source = options.bodies?.source(detail, side);
  if (!source) return NO_BODY;
  const unique = [...new Set(needles)];
  const { memo } = options;
  const state = source.state;
  if (!memo || !state) return searchBody(source, unique, tick);

  const id = detail.summary.id;
  const key = memoKey(side, unique);
  const encoding = source.encoding ?? '';
  const now = options.now ?? (() => performance.now());
  const remembered = memo.get(id, key);
  if (remembered && remembered.serial === state.serial && remembered.encoding === encoding) {
    const found = new Set(remembered.found);
    const allFound = found.size === unique.length;
    if (remembered.kind === 'done') return { found, partial: remembered.partial };
    // Still arriving when searched. Partly searched is worked out from now: the store may have
    // stopped keeping its bytes since.
    const answer = (): BodySearchResult => ({
      found,
      partial: !allFound && (remembered.final || remembered.partial || state.stored < state.size),
    });
    if (remembered.final) return answer();
    if (remembered.stored === state.stored) {
      if (state.receiving) return answer();
      // Finished with nothing new: a plain body's answer is complete as it is. (A compressed
      // one is read again: cut off, it decoded only so far; finished, it may not decode at all.)
      if (encoding === '') {
        const done: MemoValue = { ...remembered, kind: 'done', partial: answer().partial };
        if (stillThere()) memo.offer(id, key, done);
        return answer();
      }
    }
    const due = remembered.scannedAt + Math.max(MIN_RESCAN_MS, RESCAN_COST_FACTOR * remembered.costMs);
    // The throttle bounds searching a growing body again and again; finishing happens once.
    if (state.receiving && now() < due) {
      options.nudge?.(id, due);
      return answer();
    }
  }

  // Another ask is already searching this body for these needles (a stream's updates come faster
  // than a large body's search): wait for it, then answer as the memo says, rather than pile up
  // searches that slow each other down.
  const flight = memo.inFlight(id, key);
  if (flight && flight.serial === state.serial && flight.encoding === encoding) {
    await flight.done.catch(() => undefined);
    await tick();
    return searchSide(detail, side, needles, tick, options, stillThere);
  }

  const done = (async (): Promise<BodySearchResult> => {
    const started = now();
    const report: BodySearchReport = { gone: false, final: false };
    const result = await searchBody(source, unique, tick, undefined, report);
    // About part of a body that went, or an exchange gone since: nothing to remember.
    if (report.gone || !stillThere()) return result;
    const common = { serial: state.serial, encoding, found: [...result.found], partial: result.partial };
    const value: MemoValue = state.receiving
      ? {
          ...common,
          kind: 'sofar',
          stored: state.stored,
          final: report.final,
          scannedAt: started,
          costMs: now() - started,
        }
      : { ...common, kind: 'done' };
    memo.offer(id, key, value);
    return result;
  })();
  memo.track(id, key, { serial: state.serial, encoding, done });
  return done;
}

/** Whether an exchange's bodies pass every body term, and whether that's from part of a body. */
async function matchBodies(
  detail: ExchangeDetail,
  terms: readonly BodyTerm[],
  tick: Tick,
  options: MatchOptions,
  stillThere: () => boolean,
): Promise<{ matches: boolean; partial: boolean }> {
  const search = (side: BodySide, needles: string[]): Promise<BodySearchResult> =>
    searchSide(detail, side, needles, tick, options, stillThere);
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
        const result = await matchBodies(
          detail,
          compiled.bodyTerms,
          tick,
          options,
          () => !signal?.aborted && store.get(id) !== undefined,
        );
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
