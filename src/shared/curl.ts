import type { Header } from './api';

/** Headers curl works out for itself, or that would break a replay. */
const SKIPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive']);

/** Quotes a string for POSIX shells. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface CurlInput {
  method: string;
  url: string;
  headers: Header[];
  /** The body exactly as sent. */
  body?: Uint8Array;
}

function asText(body: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    // Control characters (other than whitespace) won't survive a shell command line.
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Builds a curl command that repeats a request. */
export function toCurl({ method, url, headers, body }: CurlInput): string {
  // Each entry becomes one line of the command, e.g. `-H 'Accept: */*'`.
  const parts = ['curl'];
  const hasBody = body !== undefined && body.length > 0;
  if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) {
    parts.push(`-X ${shellQuote(method)}`);
  }
  parts.push(shellQuote(url));

  for (const [name, value] of headers) {
    // HTTP/2 pseudo-headers (`:authority` etc.) are covered by the method and URL.
    if (name.startsWith(':') || SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }

  if (hasBody) {
    const text = asText(body);
    if (text !== undefined) {
      parts.push(`--data-raw ${shellQuote(text)}`);
    } else {
      // A binary body can't go on the command line. Save it to body.bin first.
      parts.push('--data-binary @body.bin');
    }
  }
  return parts.join(' \\\n  ');
}
