/**
 * Types shared by the backend's local API and the UI that talks to it.
 * Keep this file free of Node or DOM imports so both sides can use it.
 */

/** One row in the traffic list. Bodies are deliberately not part of this. */
export interface ExchangeSummary {
  id: string;
  method: string;
  protocol: string;
  httpVersion: string;
  host: string;
  path: string;
  url: string;
  startedAt: number;
  /** Set once the response has been received. */
  status?: number;
  statusMessage?: string;
  /** Milliseconds from request start to response complete. */
  durationMs?: number;
  /** The response's media type without parameters, e.g. `application/json`. */
  contentType?: string;
  /** Response body size on the wire, in bytes. */
  responseSize?: number;
  /** Set if the exchange failed before a response arrived. */
  error?: string;
}

/** A header as sent on the wire. HTTP/2 pseudo-headers (`:method` etc.) are included. */
export type Header = [name: string, value: string];

/** Timestamps in milliseconds, all on the same clock as `startTimestamp`. */
export interface ExchangeTiming {
  startTimestamp: number;
  bodyReceivedTimestamp?: number;
  headersSentTimestamp?: number;
  responseSentTimestamp?: number;
  abortedTimestamp?: number;
}

export type BodySide = 'request' | 'response';

export interface BodyInfo {
  /** Bytes as sent on the wire, before decoding. */
  size: number;
  /** True if the body was too large to capture. */
  dropped?: boolean;
}

/** Everything about one exchange except the bodies, which are fetched separately. */
export interface ExchangeDetail {
  summary: ExchangeSummary;
  requestHeaders: Header[];
  responseHeaders?: Header[];
  timing: ExchangeTiming;
  requestBody?: BodyInfo;
  responseBody?: BodyInfo;
}

export interface BodyContent {
  /** Base64 of the decoded body, or of the raw body if decoding failed. Possibly truncated. */
  base64: string;
  /** Size on the wire. */
  size: number;
  /** Size after decoding, if it was decoded. */
  decodedSize?: number;
  contentType?: string;
  /** The Content-Encoding header, e.g. `gzip` or `br`. */
  encoding?: string;
  decodeError?: string;
  truncated: boolean;
}

export interface BrowserInfo {
  id: string;
  name: string;
  kind: 'chromium' | 'firefox';
}

export interface CertificateInfo {
  commonName: string;
  /** Base64 SHA-256 of the public key. */
  spkiFingerprint: string;
  /** ISO date. */
  validTo: string;
  /** Where the PEM certificate is stored, for use in commands. */
  path: string;
}

export interface ProxyStatus {
  proxyPort: number;
  /** The port the user chose, or null to pick one automatically. */
  proxyPortSetting: number | null;
  certificate: CertificateInfo;
  browsers: BrowserInfo[];
  /** Whether Leverframe's Firefox profile trusts the current certificate. */
  firefoxTrusted: boolean;
}

/** Messages the backend pushes to the UI. */
export type ServerMessage =
  | { type: 'hello'; status: ProxyStatus; exchanges: ExchangeSummary[]; paused: boolean }
  /** New or changed exchanges, batched. `removed` lists ids dropped to stay under the store's limit. */
  | { type: 'exchanges'; exchanges: ExchangeSummary[]; removed: string[] }
  | { type: 'cleared' }
  | { type: 'paused'; paused: boolean }
  /** Sent when the port, certificate or Firefox setup changes. */
  | { type: 'status'; status: ProxyStatus }
  | { type: 'result'; id: number; ok: true; value?: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

/** Commands the UI sends to the backend. Each gets a `result` reply. */
export type ClientCommand =
  | { id: number; command: 'launchBrowser'; browserId: string }
  | { id: number; command: 'clear' }
  | { id: number; command: 'setPaused'; paused: boolean }
  /** A port from 1024 to 65535, or null to pick one automatically. */
  | { id: number; command: 'setProxyPort'; port: number | null }
  | { id: number; command: 'resetCertificate' }
  | { id: number; command: 'getExchange'; exchangeId: string }
  | { id: number; command: 'getBody'; exchangeId: string; side: BodySide };

/** WebSocket subprotocol prefix used to carry the API token. Browsers can't set headers on WebSockets. */
export const TOKEN_PROTOCOL_PREFIX = 'leverframe.token.';
export const API_PROTOCOL = 'leverframe.v1';
