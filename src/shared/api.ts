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
  /** Set if the exchange failed before a response arrived. */
  error?: string;
}

export interface BrowserInfo {
  id: string;
  name: string;
}

export interface ProxyStatus {
  proxyPort: number;
  caFingerprint: string;
  browsers: BrowserInfo[];
}

/** Messages the backend pushes to the UI. */
export type ServerMessage =
  | { type: 'hello'; status: ProxyStatus; exchanges: ExchangeSummary[] }
  | { type: 'exchange'; exchange: ExchangeSummary }
  | { type: 'cleared' }
  | { type: 'result'; id: number; ok: true; value?: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

/** Commands the UI sends to the backend. Each gets a `result` reply. */
export type ClientCommand =
  { id: number; command: 'launchBrowser'; browserId: string } | { id: number; command: 'clear' };

/** WebSocket subprotocol prefix used to carry the API token. Browsers can't set headers on WebSockets. */
export const TOKEN_PROTOCOL_PREFIX = 'leverframe.token.';
export const API_PROTOCOL = 'leverframe.v1';
