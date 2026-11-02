import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDecodeStream } from 'http-encoding';
import type { BodyContent, Header } from '../shared/api';

/** Bodies sent to the UI are cut to this size; the full body stays in the store. */
export const MAX_BODY_TO_UI = 5 * 1024 * 1024;

export function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** Reads up to `limit` bytes from a web stream, then stops it. */
async function readUpTo(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ data: Buffer; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (length <= limit) {
      const { done, value } = await reader.read();
      if (done) return { data: Buffer.concat(chunks), truncated: false };
      chunks.push(Buffer.from(value));
      length += value.length;
    }
  } finally {
    // Stops reading the file and decoding; harmless if the stream already finished.
    void reader.cancel().catch(() => undefined);
  }
  return { data: Buffer.concat(chunks).subarray(0, limit), truncated: true };
}

/**
 * Decodes a stored body (gzip, deflate, br, zstd) as a stream and keeps at most
 * `limit` decoded bytes, so a large body is never read into memory whole.
 * `open` returns a fresh stream of the stored bytes; it's called again to show
 * the raw bytes if decoding fails.
 */
export async function toBodyContent(
  open: () => Readable,
  size: number,
  headers: Header[] | undefined,
  limit = MAX_BODY_TO_UI,
): Promise<BodyContent> {
  const encoding = headerValue(headers, 'content-encoding');
  const contentType = headerValue(headers, 'content-type');
  const webStream = (): ReadableStream<Uint8Array> => Readable.toWeb(open()) as ReadableStream<Uint8Array>;

  let decodeError: string | undefined;
  let decoder: ReturnType<typeof createDecodeStream> = null;
  try {
    decoder = createDecodeStream(encoding);
  } catch {
    decodeError = `Unsupported encoding: ${encoding}`;
  }

  if (decoder) {
    try {
      const { data, truncated } = await readUpTo(webStream().pipeThrough(decoder), limit);
      return {
        base64: data.toString('base64'),
        size,
        decodedSize: truncated ? undefined : data.length,
        contentType,
        encoding,
        truncated,
      };
    } catch (error) {
      decodeError = `Couldn't decode ${encoding} body: ${(error as Error).message}`;
    }
  }

  const { data, truncated } = await readUpTo(webStream(), limit);
  return { base64: data.toString('base64'), size, contentType, encoding, decodeError, truncated };
}

/** What writing a body to a file did. */
export interface WrittenBody {
  /** Bytes written. */
  size: number;
  /** True if it was decoded (e.g. from gzip); false if written as stored. */
  decoded: boolean;
  /** Why it wasn't decoded, if it was encoded. */
  decodeError?: string;
}

/**
 * Writes a whole stored body to `file`, decoded where possible, streaming so a large body
 * is never held in memory. If decoding fails partway, the file is rewritten with the
 * stored bytes.
 */
export async function writeBodyToFile(
  open: () => Readable,
  headers: Header[] | undefined,
  file: string,
): Promise<WrittenBody> {
  const encoding = headerValue(headers, 'content-encoding');
  const write = async (stream: Readable): Promise<number> => {
    await pipeline(stream, createWriteStream(file));
    return (await stat(file)).size;
  };
  let decodeError: string | undefined;
  let decoder: ReturnType<typeof createDecodeStream> = null;
  try {
    decoder = createDecodeStream(encoding);
  } catch {
    decodeError = `Unsupported encoding: ${encoding}`;
  }
  if (decoder) {
    try {
      const web = (Readable.toWeb(open()) as ReadableStream<Uint8Array>).pipeThrough(decoder);
      return { size: await write(Readable.fromWeb(web as never)), decoded: true };
    } catch (error) {
      decodeError = `Couldn't decode ${encoding} body: ${(error as Error).message}`;
    }
  }
  return { size: await write(open()), decoded: false, ...(decodeError ? { decodeError } : {}) };
}
