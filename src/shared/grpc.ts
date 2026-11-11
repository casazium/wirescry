/**
 * gRPC basics the free app needs: telling a gRPC call apart, and reading its result.
 * Keep this file free of Node or DOM imports so both sides can use it.
 *
 * A gRPC call ends with a status: `grpc-status` (a number) and an optional `grpc-message`, in
 * the response's trailers, or in its headers when the server answered with nothing else
 * ("Trailers-Only", the usual shape of an error). See grpc/grpc doc/PROTOCOL-HTTP2.md.
 */
import type { Header } from './api';

/** The standard status codes' names (grpc/grpc doc/statuscodes.md), by number. */
export const GRPC_STATUS_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

export const GRPC_OK = 0;
export const GRPC_CANCELLED = 1;

/**
 * Short labels for the list's narrow status column (the full name is in its tooltip and the
 * details). Each fits in 64 px at 13 px system-ui.
 */
const GRPC_STATUS_LABELS: readonly string[] = [
  'OK',
  'Canceled',
  'Unknown',
  'Invalid',
  'Deadline',
  'Not found',
  'Exists',
  'Denied',
  'Limited',
  'Precond.',
  'Aborted',
  'Range',
  'Unimpl.',
  'Internal',
  'Unavail.',
  'Data loss',
  'Unauth.',
];

/** A short label for a status, for the list: "Not found"; another code as "gRPC 42". */
export function grpcStatusLabel(code: number): string {
  return GRPC_STATUS_LABELS[code] ?? `gRPC ${code}`;
}

/** A status code's name, such as NOT_FOUND; a code outside the standard ones by its number. */
export function grpcStatusName(code: number): string {
  return GRPC_STATUS_NAMES[code] ?? `code ${code}`;
}

/** True for gRPC's content types: application/grpc, +proto, +json, and gRPC-Web's. */
export function isGrpcContentType(mediaType: string | undefined): boolean {
  return mediaType !== undefined && /^application\/grpc(?:-web(?:-text)?)?(?:\+[\w.-]+)?$/i.test(mediaType);
}

/** The value of the first header with this name (any case), if any. */
function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  return headers?.find(([n]) => n.toLowerCase() === name)?.[1];
}

/**
 * Decodes `grpc-message`'s percent-encoding (UTF-8). gRPC says a reader must not fail on bad
 * encoding, so anything that doesn't decode is kept as it was.
 */
export function decodeGrpcMessage(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // Decode each run of valid escapes on its own, keeping the rest as written.
    return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

export interface GrpcResult {
  /** The status code, such as 5 for NOT_FOUND. */
  status: number;
  /** The server's message, decoded, if it sent one. */
  message?: string;
}

/** Longest message kept on the summary; the full one is in the headers or trailers. */
export const MAX_GRPC_MESSAGE = 1000;

/**
 * The call's result: from the trailers, or from the headers when the server sent no trailers
 * (Trailers-Only). Undefined if neither has a valid `grpc-status`.
 */
export function grpcResultOf(
  headers: Header[] | undefined,
  trailers: Header[] | undefined,
): GrpcResult | undefined {
  for (const source of [trailers, headers]) {
    const raw = headerValue(source, 'grpc-status')?.trim();
    if (raw === undefined) continue;
    // A decimal number; anything else isn't a status this can show.
    if (!/^\d{1,3}$/.test(raw)) return undefined;
    const message = headerValue(source, 'grpc-message');
    return {
      status: Number(raw),
      ...(message ? { message: decodeGrpcMessage(message).slice(0, MAX_GRPC_MESSAGE) } : {}),
    };
  }
  return undefined;
}

/**
 * True for a gRPC result that's an error. CANCELLED isn't: clients routinely cancel a call they're
 * done with, such as a stream they've read enough of.
 */
export function isGrpcError(status: number | undefined): boolean {
  return status !== undefined && status !== GRPC_OK && status !== GRPC_CANCELLED;
}

const TIMEOUT_UNITS: Record<string, number> = {
  H: 3_600_000,
  M: 60_000,
  S: 1000,
  m: 1,
  u: 0.001,
  n: 0.000_001,
};

/**
 * A call's deadline from `grpc-timeout` (up to 8 digits and a unit: H, M, S, m, u, n), in
 * milliseconds. Undefined if the value isn't one.
 */
export function grpcTimeoutMs(value: string | undefined): number | undefined {
  const match = /^(\d{1,8})([HMSmun])$/.exec(value?.trim() ?? '');
  return match ? Number(match[1]) * TIMEOUT_UNITS[match[2]!]! : undefined;
}

/** A deadline in plain words: "250 ms", "5 s", "2 min", "1.5 h". */
export function describeGrpcTimeout(value: string | undefined): string | undefined {
  const ms = grpcTimeoutMs(value);
  if (ms === undefined) return undefined;
  if (ms === 0) return '0 ms';
  if (ms < 1) return 'under 1 ms';
  // One decimal place; a value that rounds up to the next unit is said in that unit.
  const round = (n: number) => Math.round(n * 10) / 10;
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  if (round(ms / 1000) < 60) return `${round(ms / 1000)} s`;
  if (round(ms / 60_000) < 60) return `${round(ms / 60_000)} min`;
  return `${round(ms / 3_600_000)} h`;
}

/** Bytes shown of a binary header's value; the rest is cut. */
export const MAX_BINARY_HEADER_BYTES = 64;

/**
 * A binary (`-bin`) header's value as hex bytes. gRPC sends these base64-encoded, padded or not,
 * with several values joined by commas. Undefined if it isn't base64.
 */
export function binaryHeaderHex(value: string): string | undefined {
  const parts = value.split(',').map((part) => part.trim());
  const hexes: string[] = [];
  for (const part of parts) {
    const data = part.replace(/=+$/, '');
    // Base64 characters, a length base64 can have, and padding only where it belongs.
    if (!/^[A-Za-z0-9+/]*$/.test(data) || data.length % 4 === 1) return undefined;
    if (part.length > data.length && (part.length % 4 !== 0 || part.length - data.length > 2))
      return undefined;
    const size = Math.floor((data.length * 3) / 4);
    // Decode only what's shown: 4 characters make 3 bytes.
    const shown = data.slice(0, Math.ceil(MAX_BINARY_HEADER_BYTES / 3) * 4);
    let bytes: number[];
    try {
      // atob takes base64 with or without padding (forgiving-base64).
      bytes = [...atob(shown)].map((c) => c.charCodeAt(0)).slice(0, MAX_BINARY_HEADER_BYTES);
    } catch {
      return undefined;
    }
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    hexes.push(size > MAX_BINARY_HEADER_BYTES ? `${hex} … (${size} bytes)` : hex);
  }
  return hexes.join(', ');
}
