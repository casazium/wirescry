/**
 * View › Hide Secrets in the window: the switch, remembered across restarts, and masking what the
 * window shows of an exchange's summary and headers with HAR export's rules
 * (src/shared/redact.ts), and the session's known values the backend sends (known-sync.ts), so a
 * token learned from `Authorization` is hidden where it repeats. Bodies are masked by the backend
 * (getBody with `mask`).
 *
 * Masking never learns: the rules run without a sink, and values come only from the backend. Until
 * the window has every value for what it shows (`covered`), the masked fields show "Checking…".
 *
 * Known limits: a value seen only in a body isn't known, so it can show in another row's URL (MCP
 * is the same); one learned after a row was shown is hidden once its push arrives; and while the
 * set is full, a row's own token can show in its own URL in the list (the detail hides it).
 */
import { createContext } from 'react';
import type { ExchangeDetail, ExchangeSummary, Header } from '../../shared/api';
import { applySpans, REDACTED, redactHeader, redactHeaders, redactUrl, type Span } from '../../shared/redact';
import { KnownValues, redactBody } from '../../shared/redact-body';

/** Whether View › Hide Secrets is on, for the views that mask what they show. */
export const SecretsHidden = createContext(false);

/** What a masked field shows until the window has the known values for it. */
export const CHECKING = 'Checking…';
/** Its accessible name. */
export const CHECKING_LABEL = 'Checking for secrets';
/** The detail's URL and header values until then. */
export const HIDING = 'Hiding secrets…';
/** What a masked field from before a backend restart shows: its values went with that backend. */
export const STALE = 'Can’t be checked for secrets: the proxy restarted';

/** The texts that stand for a value not shown. */
export function isPlaceholder(text: string): boolean {
  return text === CHECKING || text === HIDING || text === STALE;
}

/** The session's known values as the window has them. */
export interface Masking {
  /** Added to only from the backend's pushes and pages; never by masking. */
  known: KnownValues;
  /** Rises with each value added; a new Masking object each time anything changes. */
  version: number;
  /** The window has every value for every summary it has. */
  covered: boolean;
  /** The backend's set turned a value away, so one seen earlier may not be hidden. */
  full: boolean;
}

/** Nothing known yet: everything masked shows "Checking…". */
export const UNCOVERED: Masking = { known: new KnownValues(), version: 0, covered: false, full: false };

/** The window's known values, for the views that mask what they show. */
export const KnownSecrets = createContext<Masking>(UNCOVERED);

export const HIDE_SECRETS_KEY = 'wirescry.hideSecrets';

/**
 * Whether Hide Secrets was left on. Storage that can't be read means on: the badge shows, so the
 * user can turn it off, and nothing is shown that they meant hidden.
 */
export function readHideSecrets(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): boolean {
  try {
    return storage?.getItem(HIDE_SECRETS_KEY) === '1';
  } catch {
    return true;
  }
}

/** Remembers the switch; a storage error is ignored (it's on or off for this run anyway). */
export function writeHideSecrets(
  on: boolean,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
): void {
  try {
    if (on) storage?.setItem(HIDE_SECRETS_KEY, '1');
    else storage?.removeItem(HIDE_SECRETS_KEY);
  } catch {
    // Not remembered.
  }
}

/** Known values in a short field (a URL, a header), alone or joined to other text, from each set. */
function anywhereSpans(text: string, known: readonly KnownValues[]): Span[] {
  const spans: Span[] = [];
  for (const set of known) {
    for (const span of set.scan(text, true)) spans.push(span);
    for (const span of set.anywhere(text)) spans.push(span);
  }
  return spans;
}

/** Known values in message text, from each set: standing alone, or anywhere if 16+ long. */
function scanSpans(text: string, known: readonly KnownValues[]): Span[] {
  const spans: Span[] = [];
  for (const set of known) for (const span of set.scan(text)) spans.push(span);
  return spans;
}

/** Text of a message (a status, an error, a reason) with anything that looks secret hidden. */
export function maskText(text: string, known: readonly KnownValues[]): string {
  try {
    const ruled = applySpans(text, redactBody(text, 'text/plain').spans);
    return applySpans(ruled, scanSpans(ruled, known));
  } catch {
    return REDACTED;
  }
}

/** A URL, a path and query, or a host, with its secrets hidden. */
export function maskUrl(url: string, known: readonly KnownValues[]): string {
  try {
    const ruled = redactUrl(url).url;
    return applySpans(ruled, anywhereSpans(ruled, known));
  } catch {
    return REDACTED;
  }
}

/** A short field no rule reads (a host, a method): known values only. */
function maskField(text: string, known: readonly KnownValues[]): string {
  try {
    return applySpans(text, anywhereSpans(text, known));
  } catch {
    return REDACTED;
  }
}

/** Headers with their secrets hidden, names and values; a header that can't be read is hidden whole. */
export function maskHeaders(headers: readonly Header[], known: readonly KnownValues[]): Header[] {
  let ruled: Header[];
  try {
    ruled = redactHeaders(headers).headers;
  } catch {
    ruled = headers.map(([name, value]) => {
      try {
        return [name, redactHeader(name, value).value];
      } catch {
        return [name, REDACTED];
      }
    });
  }
  return ruled.map(([name, value]) => [maskField(name, known), maskField(value, known)]);
}

/** A message as the window shows it with Hide Secrets on: masked, or "Checking…" until it can be. */
export function maskMessage(text: string, masking: Masking): string {
  return masking.covered ? maskText(text, [masking.known]) : CHECKING;
}

/** How each kind of a summary's fields is shown. */
interface FieldMasks {
  /** A URL or a path. */
  url(value: string): string;
  /** A host or a method. */
  field(value: string): string;
  /** A content type. */
  type(value: string): string;
  /** A message or a label. */
  text(value: string): string;
}

/** A summary with its shown fields masked. */
function summaryWith(summary: ExchangeSummary, masks: FieldMasks): ExchangeSummary {
  const message = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : masks.text(value);
  return {
    ...summary,
    url: masks.url(summary.url),
    path: masks.url(summary.path),
    host: masks.field(summary.host),
    method: masks.field(summary.method),
    ...(summary.statusMessage !== undefined ? { statusMessage: message(summary.statusMessage) } : {}),
    ...(summary.contentType !== undefined ? { contentType: masks.type(summary.contentType) } : {}),
    ...(summary.grpcMessage !== undefined ? { grpcMessage: message(summary.grpcMessage) } : {}),
    ...(summary.closeReason !== undefined ? { closeReason: message(summary.closeReason) } : {}),
    ...(summary.failure
      ? {
          failure: {
            ...summary.failure,
            code: message(summary.failure.code)!,
            message: message(summary.failure.message)!,
            ...(summary.failure.detail !== undefined ? { detail: message(summary.failure.detail) } : {}),
          },
        }
      : {}),
    ...(summary.handledBy
      ? { handledBy: { ...summary.handledBy, label: message(summary.handledBy.label)! } }
      : {}),
    // Plugin badges keep a masked label and lose their title, which can say anything.
    ...(summary.annotations
      ? {
          annotations: summary.annotations.map(
            ({ title: _title, ...rest }) => (void _title, { ...rest, label: message(rest.label)! }),
          ),
        }
      : {}),
  };
}

/** Every field shown as this text. */
const allAs = (text: string): FieldMasks => ({
  url: () => text,
  field: () => text,
  type: () => text,
  text: () => text,
});

/** A summary's fields masked with these sets of known values. */
function maskedWith(summary: ExchangeSummary, known: readonly KnownValues[]): ExchangeSummary {
  return summaryWith(summary, {
    url: (value) => maskUrl(value, known),
    field: (value) => maskField(value, known),
    type: (value) => maskHeaders([['content-type', value]], known)[0]![1],
    text: (value) => maskText(value, known),
  });
}

const masked = new WeakMap<ExchangeSummary, { masking: Masking; out: ExchangeSummary }>();

/**
 * A summary as the window shows it with Hide Secrets on: its URL, path, host, method, messages and
 * labels masked, or "Checking…" while not covered. The same object for the same summary and
 * Masking, so lists don't redraw for nothing.
 */
export function maskSummary(summary: ExchangeSummary, masking: Masking): ExchangeSummary {
  const cached = masked.get(summary);
  if (cached?.masking === masking) return cached.out;
  const out = masking.covered ? maskedWith(summary, [masking.known]) : summaryWith(summary, allAs(CHECKING));
  masked.set(summary, { masking, out });
  return out;
}

/** As maskSummary, with an exchange's own values first (see ownValues). */
export function maskSummaryWith(
  summary: ExchangeSummary,
  masking: Masking,
  own: KnownValues | undefined,
): ExchangeSummary {
  if (!own || !masking.covered) return maskSummary(summary, masking);
  return maskedWith(summary, [own, masking.known]);
}

const stale = new WeakMap<ExchangeSummary, ExchangeSummary>();

/** A summary from before a backend restart: its values went with that backend, so nothing is checked. */
export function staleSummary(summary: ExchangeSummary): ExchangeSummary {
  let out = stale.get(summary);
  if (!out) {
    out = summaryWith(summary, allAs(STALE));
    stale.set(summary, out);
  }
  return out;
}

/**
 * The values an exchange's own URL, headers and trailers hold, learned as HAR export learns them:
 * hidden in its detail even when the session's set is full.
 */
export function ownValues(detail: ExchangeDetail): KnownValues {
  const own = new KnownValues();
  // Headers first: a URL of junk can't take the room their values need.
  for (const list of [
    detail.requestHeaders,
    detail.responseHeaders,
    detail.requestTrailers,
    detail.responseTrailers,
  ]) {
    try {
      if (list) redactHeaders(list, own);
    } catch {
      // Nothing learned from them.
    }
  }
  try {
    redactUrl(detail.summary.url, own);
  } catch {
    // Nothing learned from it.
  }
  return own;
}
