/**
 * View › Hide Secrets in the window: the switch, remembered across restarts, and masking what the
 * window shows of an exchange's summary and headers with HAR export's rules
 * (src/shared/redact.ts). Bodies are masked by the backend (getBody with `mask`).
 */
import { createContext } from 'react';
import type { ExchangeSummary, Header } from '../../shared/api';
import { applySpans, REDACTED, redactHeader, redactHeaders, redactUrl } from '../../shared/redact';
import { redactBody } from '../../shared/redact-body';

/** Whether View › Hide Secrets is on, for the views that mask what they show. */
export const SecretsHidden = createContext(false);

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

/** Text of a message (a status, an error, a reason) with anything that looks secret hidden. */
export function maskText(text: string): string {
  try {
    return applySpans(text, redactBody(text, 'text/plain').spans);
  } catch {
    return REDACTED;
  }
}

/** A URL, or a path and query, with its secrets hidden. */
export function maskUrl(url: string): string {
  try {
    return redactUrl(url).url;
  } catch {
    return REDACTED;
  }
}

/** Headers with their secrets hidden; a header that can't be read is hidden whole. */
export function maskHeaders(headers: readonly Header[]): Header[] {
  try {
    return redactHeaders(headers).headers;
  } catch {
    return headers.map(([name, value]) => {
      try {
        return [name, redactHeader(name, value).value];
      } catch {
        return [name, REDACTED];
      }
    });
  }
}

const masked = new WeakMap<ExchangeSummary, ExchangeSummary>();

/**
 * A summary as the window shows it with Hide Secrets on: its URL, path, messages and labels
 * masked. The same object for the same summary, so lists don't redraw for nothing. Plugin
 * badges keep their label but lose their title, which can say anything.
 */
export function maskSummary(summary: ExchangeSummary): ExchangeSummary {
  const cached = masked.get(summary);
  if (cached) return cached;
  const text = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : maskText(value);
  const out: ExchangeSummary = {
    ...summary,
    url: maskUrl(summary.url),
    path: maskUrl(summary.path),
    ...(summary.statusMessage !== undefined ? { statusMessage: text(summary.statusMessage) } : {}),
    ...(summary.contentType !== undefined
      ? { contentType: maskHeaders([['content-type', summary.contentType]])[0]![1] }
      : {}),
    ...(summary.grpcMessage !== undefined ? { grpcMessage: text(summary.grpcMessage) } : {}),
    ...(summary.closeReason !== undefined ? { closeReason: text(summary.closeReason) } : {}),
    ...(summary.failure
      ? {
          failure: {
            ...summary.failure,
            code: text(summary.failure.code)!,
            message: text(summary.failure.message)!,
            ...(summary.failure.detail !== undefined ? { detail: text(summary.failure.detail) } : {}),
          },
        }
      : {}),
    ...(summary.handledBy
      ? { handledBy: { ...summary.handledBy, label: text(summary.handledBy.label)! } }
      : {}),
    ...(summary.annotations
      ? { annotations: summary.annotations.map(({ title: _title, ...rest }) => (void _title, rest)) }
      : {}),
  };
  masked.set(summary, out);
  return out;
}
