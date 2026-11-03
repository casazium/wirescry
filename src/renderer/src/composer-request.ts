import type { BodyContent, ComposerRequest, ExchangeDetail, ExchangeSummary, Header } from '../../shared/api';
import type { UiComposerExtension, UiPluginApi } from '../../plugin-api/ui';
import { base64ToBytes } from './bytes';

/** What the composer's fields hold: headers as typed, one `Name: value` per line. */
export interface ComposerDraft {
  method: string;
  url: string;
  headersText: string;
  body: string;
}

export const EMPTY_DRAFT: ComposerDraft = { method: 'GET', url: '', headersText: '', body: '' };

/** The largest body the composer sends (as the backend's MAX_COMPOSER_BODY). */
export const MAX_DRAFT_BODY = 512 * 1024;

/** The most a request can take as JSON: each message to the backend is capped at 1 MB. */
export const MAX_SEND_JSON = 900 * 1024;

/** Throws if the request is too large to send in one message to the backend. */
export function checkSendSize(request: ComposerRequest): void {
  if (new TextEncoder().encode(JSON.stringify(request)).length > MAX_SEND_JSON) {
    throw new Error('This request is too large to send. Make the body or headers smaller.');
  }
}

/** Whether two drafts would send the same request. */
export function sameDraft(a: ComposerDraft, b: ComposerDraft): boolean {
  return a.method === b.method && a.url === b.url && a.headersText === b.headersText && a.body === b.body;
}

/** Headers the composer leaves out of a copied request: Wirescry sets them when it sends. */
const MANAGED = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export function headersToText(headers: Header[]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join('\n');
}

/** Each non-empty line as a header. A line without a colon is an error, with its line number. */
export function parseHeaders(text: string): { headers: Header[] } | { error: string } {
  const headers: Header[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':', line.startsWith(':') ? 1 : 0);
    if (colon <= 0) return { error: `Header line ${index + 1} needs a colon, as in Name: value.` };
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { headers };
}

/** The draft as a request, keeping what it can of lines that don't parse (for plugins). */
export function draftToRequest(draft: ComposerDraft): ComposerRequest {
  const headers: Header[] = [];
  for (const line of draft.headersText.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    headers.push(colon > 0 ? [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] : [line.trim(), '']);
  }
  return { method: draft.method, url: draft.url, headers, body: draft.body };
}

export function requestToDraft(request: ComposerRequest): ComposerDraft {
  return {
    method: request.method,
    url: request.url,
    headersText: headersToText(request.headers),
    body: request.body,
  };
}

/** The body as text, or undefined if it isn't UTF-8 text. */
function bodyText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * A captured request as a composer draft. `note` says what couldn't be kept, such as a
 * body that isn't text.
 */
export function draftFromExchange(
  summary: ExchangeSummary,
  detail: ExchangeDetail,
  body: BodyContent | null,
): { draft: ComposerDraft; note?: string } {
  let headers = detail.requestHeaders.filter(
    ([name]) => !name.startsWith(':') && !MANAGED.has(name.toLowerCase()),
  );
  let text = '';
  let note: string | undefined;
  if (body) {
    const decoded = bodyText(base64ToBytes(body.base64));
    if (body.truncated) note = 'The body was too large to copy, so it was left out.';
    else if (decoded === undefined) note = 'The body isn’t text, so it was left out.';
    else if (new TextEncoder().encode(decoded).length > MAX_DRAFT_BODY) {
      note = `The body is larger than ${MAX_DRAFT_BODY / 1024} KB, so it was left out.`;
    } else {
      text = decoded;
      // The body is copied decoded, so it goes out unencoded.
      if (body.decodedSize !== undefined) {
        headers = headers.filter(([name]) => name.toLowerCase() !== 'content-encoding');
      }
    }
  } else if (detail.requestBody?.size) {
    note = 'The body is no longer stored, so it was left out.';
  }
  return {
    draft: { method: summary.method, url: summary.url, headersText: headersToText(headers), body: text },
    ...(note ? { note } : {}),
  };
}

/** Runs each plugin's beforeSend in order, each getting the last one's result. */
export async function runBeforeSend(
  extensions: Array<{ plugin: string; extension: UiComposerExtension }>,
  request: ComposerRequest,
  apiFor: (plugin: string) => UiPluginApi,
): Promise<ComposerRequest> {
  let next = request;
  for (const { plugin, extension } of extensions) {
    if (!extension.beforeSend) continue;
    try {
      next = await extension.beforeSend(next, apiFor(plugin));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : `It couldn't be sent: ${String(error)}`, {
        cause: error,
      });
    }
    if (!next || typeof next !== 'object')
      throw new Error('It couldn’t be sent: a plugin returned no request.');
  }
  return next;
}

/** Whether Cancel can still stop this sent request: until its response has fully arrived. */
export function canCancel(
  summary: ExchangeSummary | undefined,
  stale: boolean,
  uncancellable: ReadonlySet<string>,
): boolean {
  return (
    !!summary &&
    summary.durationMs === undefined &&
    !summary.failure &&
    !stale &&
    !uncancellable.has(summary.id)
  );
}
