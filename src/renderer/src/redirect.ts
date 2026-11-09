/** Where a redirect points, and the request that followed it, for the details pane. */
import type { ExchangeSummary, Header } from '../../shared/api';

/**
 * The absolute URL a redirect response points to: its Location, resolved against the request's
 * URL. Nothing for a response that isn't a redirect (304 Not Modified isn't one) or has no
 * Location. A Location that can't be read as a URL is given as it is.
 */
export function redirectTarget(
  summary: Pick<ExchangeSummary, 'status' | 'url'>,
  responseHeaders: Header[],
): string | undefined {
  const { status } = summary;
  if (status === undefined || status < 300 || status > 399 || status === 304) return undefined;
  const location = responseHeaders.find(([name]) => name.toLowerCase() === 'location')?.[1].trim();
  if (!location) return undefined;
  try {
    return new URL(location).href;
  } catch {
    // Relative: resolved against the request's URL.
  }
  try {
    return new URL(location, summary.url).href;
  } catch {
    return location;
  }
}

/** A URL as it's requested: the part after "#" never reaches the server. */
function requested(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * How long before a redirect counts as answered its follow-up may start: timing jitter only.
 * A redirect's body is tiny, so it arrives with the headers, and redirects sent together can be
 * answered a few milliseconds apart.
 */
const FOLLOW_SLACK_MS = 5;
/** Clients follow within milliseconds; a request for the URL much later is a new visit. */
export const FOLLOW_WINDOW_MS = 10_000;

/**
 * The request that followed a redirect: the first one for its target from the same client
 * (this computer or the same device; captured, imported or composed alike) that started once
 * the redirect's response could have arrived, and within FOLLOW_WINDOW_MS of it. Any method,
 * since clients change POST to GET after a 302 or 303. Summaries don't keep Location, so with
 * several redirects to one URL at once, this is the best guess.
 */
export function followingRequest(
  exchanges: readonly ExchangeSummary[],
  from: ExchangeSummary,
  target: string,
): ExchangeSummary | undefined {
  const wanted = requested(target);
  if (wanted === undefined) return undefined;
  const answered = from.startedAt + (from.durationMs ?? 0);
  const earliest = Math.max(from.startedAt, answered - FOLLOW_SLACK_MS);
  const latest = answered + FOLLOW_WINDOW_MS;
  let found: ExchangeSummary | undefined;
  for (const exchange of exchanges) {
    if (exchange.id === from.id || exchange.startedAt < earliest || exchange.startedAt > latest) continue;
    if (exchange.source?.id !== from.source?.id) continue;
    if (!!exchange.imported !== !!from.imported || !!exchange.composed !== !!from.composed) continue;
    if (requested(exchange.url) !== wanted) continue;
    if (!found || exchange.startedAt < found.startedAt) found = exchange;
  }
  return found;
}
