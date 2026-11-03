/** Messages between the Electron main process and the backend utility process. */
import type { PluginStatus } from './api';

export interface BackendStartMessage {
  type: 'start';
  dataDir: string;
  token: string;
  allowedOrigins: string[];
  /** This Wirescry's version, and when it was built (ISO 8601), for plugins. */
  app: { version: string; releaseDate: string };
  /** Whether plugins such as Pro may run. Pro checks its own license. */
  pluginsEnabled: boolean;
  /** For the packaged self-test: run src/backend/self-check.ts before reporting ready. */
  selfCheck?: boolean;
}

export type BackendMessage =
  | {
      type: 'ready';
      apiPort: number;
      proxyPort: number;
      /** The plugins built into this copy, such as Pro, and whether each started. */
      plugins: PluginStatus[];
      /** With selfCheck: the problems it found (none if all is well). */
      selfCheck?: string[];
    }
  | { type: 'error'; message: string }
  | CryptoRequest
  | HarReply;

/** What the main process sends the backend. */
export type MainToBackendMessage = BackendStartMessage | CryptoReply | HarRequest | BackendShutdownMessage;

/**
 * Main to backend: stop and delete stored bodies, then exit. Sent on quit instead of a
 * signal, since on Windows killing the process gives it no chance to clean up.
 */
export interface BackendShutdownMessage {
  type: 'shutdown';
}

/** Main to backend: write or read a HAR file at a path the user chose in a dialog. */
export type HarRequest =
  | { type: 'har'; id: number; op: 'export'; file: string; exchangeIds: string[] }
  | { type: 'har'; id: number; op: 'import'; file: string; name: string }
  /** Not a HAR file: one exchange's whole body, decoded where possible. */
  | { type: 'har'; id: number; op: 'body'; file: string; exchangeId: string; side: 'request' | 'response' };

/** Backend to main: how a HAR request went. */
export type HarReply =
  | { type: 'har-result'; id: number; ok: true; value: unknown }
  | { type: 'har-result'; id: number; ok: false; error: string };

/** What exporting a HAR file did: the file's name and how many exchanges it has, or nothing if canceled. */
export interface HarExportResult {
  name?: string;
  count?: number;
}

/** What importing a HAR file did, or nothing if canceled. */
export interface HarImportResult {
  name?: string;
  imported?: number;
  /** Entries that couldn't be read. */
  skipped?: number;
  /** Why some were skipped (the first few). */
  problems?: string[];
  /** Older exchanges dropped from the list to make room. */
  removed?: number;
}

/**
 * Backend to main: encrypt or decrypt with safeStorage, or ask whether it can ('available',
 * answered 'os' or 'none'). Asked only when a plugin is built in, so the free build never
 * touches the keychain.
 */
export interface CryptoRequest {
  type: 'crypto';
  id: number;
  op: 'encrypt' | 'decrypt' | 'available';
  /** Text to encrypt, or base64 to decrypt. */
  data: string;
}

/** Main to backend: the result, as base64 (encrypt) or text (decrypt). */
export type CryptoReply =
  | { type: 'crypto-result'; id: number; ok: true; data: string }
  | { type: 'crypto-result'; id: number; ok: false; error: string };

/** What the preload hands the UI so it can reach the backend. */
export interface BackendConnection {
  apiUrl: string;
  token: string;
}

/** The last time the backend was restarted: after it stopped unexpectedly, or by the user. */
export interface BackendRestart {
  /** When it stopped, in ms since the epoch. */
  at: number;
  /** Its exit code, if it crashed. */
  exitCode?: number | null;
  /** True if the user restarted it (after it failed). */
  byUser?: true;
}

export type BackendState =
  | { state: 'starting'; restart?: BackendRestart }
  /** `generation` counts backend starts, so a new backend can be told from the same one. */
  | { state: 'ready'; connection: BackendConnection; generation: number; restart?: BackendRestart }
  /** `message` is for people; the details are in the log. */
  | { state: 'failed'; message: string };

export const IPC = {
  getBackendState: 'wirescry:get-backend-state',
  backendStateChanged: 'wirescry:backend-state-changed',
  exportCertificate: 'wirescry:export-certificate',
  saveTextFile: 'wirescry:save-text-file',
  openTextFile: 'wirescry:open-text-file',
  chooseFilePath: 'wirescry:choose-file-path',
  exportHar: 'wirescry:export-har',
  importHar: 'wirescry:import-har',
  showMenu: 'wirescry:show-menu',
  saveBody: 'wirescry:save-body',
  menuCommand: 'wirescry:menu-command',
  menuState: 'wirescry:menu-state',
  restartBackend: 'wirescry:restart-backend',
  showLog: 'wirescry:show-log',
} as const;

export interface SaveBodyRequest {
  exchangeId: string;
  side: 'request' | 'response';
  /** Suggested file name, e.g. `users.json`. */
  name: string;
}

/** The saved file's name and what was written, or nothing if the user canceled. */
export interface SaveBodyResult {
  name?: string;
  size?: number;
  /** Set when an encoded body couldn't be decoded, so it was saved as stored. */
  decodeError?: string;
}

/** Commands from the app menu to the window. */
export type MenuCommand = 'import-har' | 'export-har' | 'toggle-recording' | 'clear' | 'find';

/** What the window tells the app menu, so its commands are enabled and ticked to match. */
export interface MenuState {
  connected: boolean;
  canExport: boolean;
  paused: boolean;
}

/** An item in a menu the UI shows with showMenu. */
export type MenuChoice = { id: string; label: string; enabled?: boolean } | { separator: true };

export interface SaveTextFileRequest {
  text: string;
  /** Suggested file name. */
  defaultName: string;
  /** Allowed extensions, without dots, e.g. ['json']. */
  extensions: string[];
}

/** The saved file's name, or nothing if the user canceled. */
export interface SaveTextFileResult {
  name?: string;
}

export interface OpenTextFileRequest {
  extensions: string[];
}

/** The chosen file's name and text, or nothing if the user canceled. */
export interface OpenTextFileResult {
  name?: string;
  text?: string;
}

export interface ChooseFilePathRequest {
  /** Limits the dialog to these extensions; any file if left out. */
  extensions?: string[];
}

/** The chosen file's full path, or nothing if the user canceled. */
export interface ChooseFilePathResult {
  path?: string;
}

/** Where the certificate was saved, or undefined if the user canceled. */
export interface ExportResult {
  path?: string;
}

/** The API the preload script exposes to the UI as `window.wirescry`. */
export interface WirescryBridge {
  getBackendState(): Promise<BackendState>;
  /** Returns a function that unsubscribes. */
  onBackendStateChanged(callback: (state: BackendState) => void): () => void;
  /** Asks where to save the CA certificate, then saves it. */
  exportCertificate(): Promise<ExportResult>;
  /** Asks where to save some text (e.g. exported rules), then saves it. */
  saveTextFile(request: SaveTextFileRequest): Promise<SaveTextFileResult>;
  /** Asks the user to pick a text file and returns it. */
  openTextFile(request: OpenTextFileRequest): Promise<OpenTextFileResult>;
  /** Asks the user to pick a file and returns its full path, without reading it. */
  chooseFilePath(request: ChooseFilePathRequest): Promise<ChooseFilePathResult>;
  /** Asks where to save, then writes these exchanges (in this order) as a HAR file. */
  exportHar(exchangeIds: string[]): Promise<HarExportResult>;
  /** Asks the user to pick a HAR file, then adds its exchanges to the traffic list. */
  importHar(): Promise<HarImportResult>;
  /** Listens for app menu commands. Returns a function that stops listening. */
  onMenuCommand(callback: (command: MenuCommand) => void): () => void;
  /** Tells the app menu what's possible now. */
  setMenuState(state: MenuState): void;
  /** Asks where to save one body of an exchange, then saves all of it. */
  saveBody(request: SaveBodyRequest): Promise<SaveBodyResult>;
  /** Shows a native menu at the mouse, then resolves with the chosen item's id, or nothing. */
  showMenu(choices: MenuChoice[]): Promise<string | undefined>;
  /** Starts the backend again after it failed. */
  restartBackend(): Promise<void>;
  /** Shows Wirescry's log file in the Finder or Explorer. */
  showLog(): Promise<void>;
}
