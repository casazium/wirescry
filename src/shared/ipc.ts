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
}

export type BackendMessage =
  | {
      type: 'ready';
      apiPort: number;
      proxyPort: number;
      /** The plugins built into this copy, such as Pro, and whether each started. */
      plugins: PluginStatus[];
    }
  | { type: 'error'; message: string }
  | CryptoRequest;

/** What the main process sends the backend. */
export type MainToBackendMessage = BackendStartMessage | CryptoReply;

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

export type BackendState =
  | { state: 'starting' }
  | { state: 'ready'; connection: BackendConnection }
  | { state: 'failed'; message: string };

export const IPC = {
  getBackendState: 'wirescry:get-backend-state',
  backendStateChanged: 'wirescry:backend-state-changed',
  exportCertificate: 'wirescry:export-certificate',
  saveTextFile: 'wirescry:save-text-file',
  openTextFile: 'wirescry:open-text-file',
} as const;

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
}
