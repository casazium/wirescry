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
  /** SHA-256 of the whole certificate, colon-separated hex: what Android's Settings shows. */
  sha256: string;
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
  /** Android devices over ADB. Missing while Android setup is off (it's experimental for now). */
  android?: AndroidStatus;
}

/** Android setup, as the Setup page shows it. */
export interface AndroidStatus {
  /**
   * ready: talking to the ADB server. starting: looking for it. no-adb: no server running and
   * no adb found to start one. failed: something else went wrong (`error` says what).
   */
  state: 'ready' | 'starting' | 'no-adb' | 'failed';
  error?: string;
  /** The ADB server's protocol version, e.g. 41. */
  serverVersion?: number;
  /** The adb Wirescry started the server with, if it had to. */
  startedWith?: string;
  devices: AndroidDevice[];
  /**
   * Devices Wirescry set up that aren't connected now: they have no internet until they're
   * connected here and put back (or fixed by hand).
   */
  notConnected?: Array<{ label: string; capturing: boolean; emulator?: boolean }>;
}

/** A device the ADB server lists. Its strings come from the device: show them as text only. */
export interface AndroidDevice {
  /** The ADB transport serial, e.g. emulator-5554. Reused by other devices later, so only for now. */
  serial: string;
  /**
   * ready: connected and allowed. unauthorized: waiting for "Allow USB debugging?" on the device.
   * connecting: about to be ready. offline: not answering. no-permissions: Linux can't open the
   * USB device (udev rules). other: anything else (`stateText`, e.g. bootloader or recovery).
   */
  state: 'ready' | 'unauthorized' | 'connecting' | 'offline' | 'no-permissions' | 'other';
  stateText?: string;
  /** A name to show, e.g. "Pixel 8" or the emulator's AVD name. */
  label: string;
  emulator: boolean;
  /** Connected over Wi-Fi (wireless debugging or `adb connect`): capture asks first. */
  wireless?: boolean;
  apiLevel?: number;
  /** Who the device is across reconnects (opaque), once its properties are read. */
  id?: string;
  /** Why Wirescry can't set this device up, e.g. an Android version that's too old. */
  unsupported?: string;
  /** Why its properties couldn't be read. */
  error?: string;
  /** While Wirescry routes the device's traffic through itself. */
  capture?: {
    /** The port on the device its proxy setting points at (127.0.0.1:devicePort). */
    devicePort: number;
    /** The port on this computer the device's traffic arrives on. */
    hostPort: number;
    /** Whether the device may reach this computer and its local networks. */
    localAccess: boolean;
  };
  /** Wirescry set this device up before and didn't undo it (it quit or crashed): offer Resume and Restore. */
  leftover?: boolean;
  /** Its proxy points at 127.0.0.1 with nothing behind it that Wirescry knows of: offer Clear. */
  strayProxy?: string;
  /** Wirescry's certificate on this device: whether a browser there trusts it, and whether it was copied over. */
  certificate?: { trusted: boolean; sent: boolean };
  /** What Wirescry is doing to it right now. */
  busy?: 'capturing' | 'stopping' | 'sending';
  /** What went wrong with the last thing Wirescry did to it, or what the user should know. */
  note?: string;
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
  /** Looks for the ADB server again, starting it with the user's adb if none runs. Only while Android setup is on. */
  | { id: number; command: 'androidRefresh' }
  /**
   * Routes a device's traffic through Wirescry. Replies `{ needsConfirmation: proxy }` instead if
   * the device already uses another proxy; send again with `replaceProxy` set to that proxy to
   * go ahead (if the device's proxy has changed meanwhile, it asks again). For a device on Wi-Fi it
   * first replies `{ needsWirelessConfirmation: true }`; send again with `confirmWireless`.
   */
  | {
      id: number;
      command: 'androidCapture';
      deviceId: string;
      replaceProxy?: string;
      confirmWireless?: boolean;
    }
  /** Captures again a device an earlier run left set up, if its proxy still points where Wirescry set it. */
  | { id: number; command: 'androidResume'; deviceId: string }
  /** Puts a capturing device back as it was. Also undoes what's left from an earlier run (Restore). */
  | { id: number; command: 'androidStop'; deviceId: string }
  /** Sets a device's proxy back to none, when it points at 127.0.0.1 and Wirescry didn't set it. */
  | { id: number; command: 'androidClearProxy'; deviceId: string }
  /** Whether a device may reach this computer and its local networks while capturing. */
  | { id: number; command: 'androidSetLocalAccess'; deviceId: string; allowed: boolean }
  /** Copies Wirescry's certificate to a device's Downloads and opens Security settings there. */
  | { id: number; command: 'androidSendCertificate'; deviceId: string }
  /** Opens Wirescry's setup page in a browser on a capturing device, which checks the certificate is trusted. */
  | { id: number; command: 'androidCheckCertificate'; deviceId: string }
  /** Opens the device's list of certificates the user installed. */
  | { id: number; command: 'androidShowCertificates'; deviceId: string }
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
