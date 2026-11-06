/**
 * Types shared by the backend's local API and the UI that talks to it.
 * Keep this file free of Node or DOM imports so both sides can use it.
 */
import type { ExchangeFailure } from './failure';
import type { ShellKind } from './terminal-env';

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
  /** Set if the real server couldn't be reached, or the client gave up. */
  failure?: ExchangeFailure;
  /** True for a WebSocket connection. */
  websocket?: boolean;
  /** WebSocket close code, once the connection has closed. */
  closeCode?: number;
  /** WebSocket close reason, if the closing side gave one. */
  closeReason?: string;
  /** Number of WebSocket messages so far, in both directions. */
  messageCount?: number;
  /** Set when a plugin rule (e.g. a Pro mock rule) handled this request. */
  handledBy?: HandledBy;
  /** True for an exchange loaded from a HAR file rather than captured. */
  imported?: true;
  /** True for a request sent from Wirescry's composer. */
  composed?: true;
  /** Badges plugins put on it, e.g. whether it matches an API spec. At most one per plugin. */
  annotations?: PluginAnnotation[];
  /**
   * The device it came from, when that wasn't this computer: set by a proxy listener that
   * serves one device (e.g. an Android phone). Unset for the computer's own traffic.
   */
  source?: ExchangeSource;
}

/** A device whose traffic reaches Wirescry through a listener of its own. */
export interface ExchangeSource {
  kind: 'android';
  /** Stable for the device, so a filter can pick it. */
  id: string;
  /** What the traffic list shows, e.g. "Pixel 8". */
  label: string;
}

/** A badge a plugin puts on an exchange: shown in the traffic list, with `title` on hover. */
export interface ExchangeAnnotation {
  /** Short: at most 16 characters. */
  label: string;
  tone: 'ok' | 'warn' | 'info';
  /** At most 200 characters. */
  title?: string;
}

export interface PluginAnnotation extends ExchangeAnnotation {
  plugin: string;
}

/**
 * A request written in the composer. Text bodies only. Headers are sent as written, except
 * that Content-Length, Transfer-Encoding, Connection and Host are set by Wirescry.
 */
export interface ComposerRequest {
  method: string;
  /** An absolute http:// or https:// URL. */
  url: string;
  headers: Header[];
  body: string;
}

/** A plugin rule that handled a request. */
export interface HandledBy {
  plugin: string;
  ruleId: string;
  label: string;
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
  /** Bytes kept. Less than `size` if the body was larger than Wirescry stores. */
  stored: number;
  /** True if the connection closed before the whole body arrived. */
  incomplete?: boolean;
}

/** Everything about one exchange except the bodies, which are fetched separately. */
export interface ExchangeDetail {
  summary: ExchangeSummary;
  requestHeaders: Header[];
  responseHeaders?: Header[];
  timing: ExchangeTiming;
  requestBody?: BodyInfo;
  responseBody?: BodyInfo;
  /** For an imported exchange: the file it came from. Its bodies are stored decoded. */
  importedFrom?: string;
}

/** One WebSocket message, without its content. */
export interface WebSocketMessage {
  /** Position in the connection, from 0. */
  index: number;
  /** True if the client (the app being debugged) sent it; false if the server did. */
  fromClient: boolean;
  isBinary: boolean;
  /** Milliseconds since the connection started. */
  time: number;
  /** Size in bytes. Content over 64 KB is cut short. */
  size: number;
}

export interface WebSocketMessages {
  /** Each message with its content as base64 (cut to 64 KB). */
  messages: Array<WebSocketMessage & { base64: string }>;
  /** Messages dropped from the start to stay within Wirescry's memory budget. */
  dropped: number;
  /** Messages seen on this connection. */
  total: number;
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

export type FormatLanguage = 'html' | 'xml' | 'js' | 'css';

/** A body pretty-printed by the backend. */
export type FormattedBody =
  | { ok: true; language: FormatLanguage; text: string }
  /** Not formatted, e.g. too large, not a supported type, or it took too long. */
  | { ok: false; reason: string };

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

export interface TerminalInfo {
  id: string;
  name: string;
}

export interface PluginStatus {
  name: string;
  /** False when the plugin is installed but not running, e.g. Pro without a license. */
  active: boolean;
  /** Why it isn't active. */
  reason?: string;
}

export interface ProxyStatus {
  proxyPort: number;
  /** The port the user chose, or null to pick one automatically. */
  proxyPortSetting: number | null;
  certificate: CertificateInfo;
  browsers: BrowserInfo[];
  /** Whether Wirescry's Firefox profile trusts the current certificate. */
  firefoxTrusted: boolean;
  /** The operating system the backend runs on. */
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  /** Terminals Wirescry can open with interception set up. */
  terminals: TerminalInfo[];
  /** The variables those terminals get, for setting up an existing terminal by hand. */
  terminalEnv: Record<string, string>;
  /** Scripts that set those variables, per shell, for the one-line setup. A shell is missing if its script couldn't be written. */
  terminalScripts: Partial<Record<ShellKind, string>>;
  /** Plugins built into this copy of Wirescry, such as Pro. Empty in the free build. */
  plugins: PluginStatus[];
  /** Whether containers started from Wirescry terminals are set up. */
  docker: DockerStatus;
}

/** Docker setup, as the Setup page shows it. */
export interface DockerStatus {
  /**
   * ready: Wirescry terminals point DOCKER_HOST at Wirescry, which sets up new containers.
   * remote: the user's Docker runs on another machine, which Wirescry doesn't set up.
   * none: no Docker found. failed: Docker was found, but Wirescry couldn't set itself up for it.
   * unsupported: a kind of Docker Wirescry doesn't set up yet (e.g. colima, rootless Docker).
   * off: the user turned Docker setup off.
   */
  state: 'ready' | 'remote' | 'none' | 'failed' | 'unsupported' | 'off';
  /** The user's Docker daemon, e.g. unix:///var/run/docker.sock. */
  daemon?: string;
  /** Why it failed, or why it isn't set up, for states "failed" and "unsupported". */
  error?: string;
  /** The last container created through Wirescry this session, and what Wirescry did with it. */
  lastContainer?: { name?: string; image?: string; setUp: boolean; reason?: string };
  /**
   * Docker Engine on Linux only: a firewall that's on here (ufw), which blocks containers from
   * reaching the proxy unless its rules allow Docker's networks, and the commands that do.
   */
  firewall?: { name: 'ufw'; commands: string[] };
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
  /** An event from a plugin's backend half to its UI. */
  | { type: 'plugin'; plugin: string; event: string; data: unknown }
  | { type: 'result'; id: number; ok: true; value?: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

/** Commands the UI sends to the backend. Each gets a `result` reply. */
export type ClientCommand =
  | { id: number; command: 'launchBrowser'; browserId: string }
  /** Deletes the exchanges with these ids, or every exchange when `ids` is left out. */
  | { id: number; command: 'clear'; ids?: string[] }
  /** Looks for installed browsers again. Replies with the BrowserInfo list, and sends a status. */
  | { id: number; command: 'rescanBrowsers' }
  /** Sends a request from the composer through the proxy. Replies with `{ exchangeId }` once it's recorded. */
  | { id: number; command: 'composeSend'; request: ComposerRequest }
  /** Stops a composed request still waiting for its response. Replies with whether there was one. */
  | { id: number; command: 'composeCancel'; exchangeId: string }
  | { id: number; command: 'setPaused'; paused: boolean }
  /** A port from 1024 to 65535, or null to pick one automatically. */
  | { id: number; command: 'setProxyPort'; port: number | null }
  /** Turns setting up Docker containers on or off. Off, new terminals don't get DOCKER_HOST, and the relay passes containers on as written. */
  | { id: number; command: 'setDockerSetup'; enabled: boolean }
  | { id: number; command: 'resetCertificate' }
  | { id: number; command: 'launchTerminal'; terminalId: string }
  /** WebSocket messages with index greater than `after` (default: from the start). */
  | { id: number; command: 'getWebSocketMessages'; exchangeId: string; after?: number }
  /** A call from a plugin's UI to its backend half. */
  | { id: number; command: 'plugin'; plugin: string; name: string; args?: unknown }
  | { id: number; command: 'getExchange'; exchangeId: string }
  | { id: number; command: 'getBody'; exchangeId: string; side: BodySide }
  | { id: number; command: 'formatBody'; exchangeId: string; side: BodySide };

/** WebSocket subprotocol prefix used to carry the API token. Browsers can't set headers on WebSockets. */
export const TOKEN_PROTOCOL_PREFIX = 'wirescry.token.';
export const API_PROTOCOL = 'wirescry.v1';
