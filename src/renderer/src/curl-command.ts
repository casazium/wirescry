import type { BodyContent, ExchangeDetail, ExchangeSummary } from '../../shared/api';
import { toCurl } from '../../shared/curl';
import type { Command } from './api-client';
import { base64ToBytes } from './bytes';

/** A curl command that repeats this exchange's request. */
export function curlCommand(
  summary: ExchangeSummary,
  detail: ExchangeDetail,
  requestBody: BodyContent | null | undefined,
): string {
  let headers = detail.requestHeaders;
  let body: Uint8Array | undefined;
  if (requestBody) {
    body = base64ToBytes(requestBody.base64);
    // The UI has the decoded body, so send it unencoded.
    if (requestBody.decodedSize !== undefined) {
      headers = headers.filter(([name]) => name.toLowerCase() !== 'content-encoding');
    }
  }
  return toCurl({ method: summary.method, url: summary.url, headers, body });
}

/** Fetches what's needed, then builds the curl command; for when the details aren't loaded. */
export async function fetchCurlCommand(
  summary: ExchangeSummary,
  send: (command: Command) => Promise<unknown>,
): Promise<string> {
  const detail = (await send({ command: 'getExchange', exchangeId: summary.id })) as ExchangeDetail;
  const body = detail.requestBody?.size
    ? ((await send({ command: 'getBody', exchangeId: summary.id, side: 'request' })) as BodyContent | null)
    : null;
  return curlCommand(summary, detail, body);
}
