import { decodeBuffer } from 'http-encoding';
import type { BodyContent, Header } from '../shared/api';

/** Bodies sent to the UI are cut to this size; the full body stays in the store. */
export const MAX_BODY_TO_UI = 5 * 1024 * 1024;

export function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** Decodes a stored body (gzip, deflate, br, zstd) and prepares it for the UI. */
export async function toBodyContent(raw: Buffer, headers: Header[] | undefined): Promise<BodyContent> {
  const encoding = headerValue(headers, 'content-encoding');
  const contentType = headerValue(headers, 'content-type');

  let data = raw;
  let decodedSize: number | undefined;
  let decodeError: string | undefined;
  if (encoding && encoding.toLowerCase() !== 'identity') {
    try {
      data = await decodeBuffer(raw, encoding);
      decodedSize = data.length;
    } catch (error) {
      decodeError = `Couldn't decode ${encoding} body: ${(error as Error).message}`;
    }
  }

  const truncated = data.length > MAX_BODY_TO_UI;
  return {
    base64: (truncated ? data.subarray(0, MAX_BODY_TO_UI) : data).toString('base64'),
    size: raw.length,
    decodedSize,
    contentType,
    encoding,
    decodeError,
    truncated,
  };
}
