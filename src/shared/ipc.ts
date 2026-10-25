/** Messages between the Electron main process and the backend utility process. */

export interface BackendStartMessage {
  type: 'start';
  dataDir: string;
  token: string;
  allowedOrigins: string[];
  /** Whether plugins such as Pro may run. Pro checks its own license. */
  pluginsEnabled: boolean;
}

export type BackendMessage =
  { type: 'ready'; apiPort: number; proxyPort: number } | { type: 'error'; message: string };

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
