/** Why an exchange didn't get a response from the real server. */
export type FailureKind =
  'dns' | 'refused' | 'tls' | 'timeout' | 'reset' | 'unreachable' | 'client-closed' | 'other';

export interface ExchangeFailure {
  kind: FailureKind;
  /** The underlying error code, e.g. `ENOTFOUND`. */
  code: string;
  /** A plain-language explanation. */
  message: string;
  /** The original error message, if there was one. */
  detail?: string;
}

export const FAILURE_LABELS: Record<FailureKind, string> = {
  dns: 'DNS',
  refused: 'Refused',
  tls: 'TLS',
  timeout: 'Timeout',
  reset: 'Reset',
  unreachable: 'No route',
  'client-closed': 'Closed',
  other: 'Failed',
};

const TLS_EXPLANATIONS: Record<string, string> = {
  CERT_HAS_EXPIRED: "the server's certificate has expired",
  CERT_NOT_YET_VALID: "the server's certificate isn't valid yet",
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the server uses a self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: "the server's certificate chain includes an untrusted self-signed certificate",
  UNABLE_TO_GET_ISSUER_CERT: "the server's certificate was issued by an unknown authority",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the server's certificate was issued by an unknown authority",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's certificate can't be verified",
  ERR_TLS_CERT_ALTNAME_INVALID: "the server's certificate is for a different hostname",
  CERT_REVOKED: "the server's certificate has been revoked",
};

/**
 * Turns an upstream error code into a kind and an explanation.
 * `target` is the host (and port) the proxy tried to reach.
 */
export function describeFailure(code: string, target: string, detail?: string): ExchangeFailure {
  const make = (kind: FailureKind, message: string): ExchangeFailure => ({ kind, code, message, detail });
  switch (code) {
    case 'ENOTFOUND':
      return make('dns', `Couldn't find ${target}: the DNS lookup found no such host.`);
    case 'EAI_AGAIN':
      return make('dns', `Couldn't look up ${target}: DNS didn't answer. The network may be offline.`);
    case 'ECONNREFUSED':
      return make('refused', `${target} refused the connection. Nothing is listening on that port.`);
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return make('timeout', `Timed out connecting to ${target}.`);
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ERR_STREAM_PREMATURE_CLOSE':
      return make('reset', `${target} closed the connection unexpectedly.`);
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return make('unreachable', `Can't reach ${target}: there's no network route to it.`);
    case 'CLIENT_CLOSED':
      return make('client-closed', 'The client closed the connection before the response arrived.');
  }
  const tls = TLS_EXPLANATIONS[code];
  if (tls) return make('tls', `TLS failed with ${target}: ${tls}.`);
  if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_') || code === 'EPROTO') {
    return make('tls', `TLS failed with ${target}.`);
  }
  return make('other', `The request to ${target} failed (${code}).`);
}

/** Reads the error code from Mockttp's `passthrough-error:CODE` tag, if present. */
export function upstreamErrorCode(tags: readonly string[]): string | undefined {
  return tags.find((t) => t.startsWith('passthrough-error:'))?.slice('passthrough-error:'.length);
}
