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
