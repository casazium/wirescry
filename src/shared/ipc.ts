/** Messages between the Electron main process and the backend utility process. */

export interface BackendStartMessage {
  type: 'start';
  dataDir: string;
  token: string;
  allowedOrigins: string[];
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
  getBackendState: 'leverframe:get-backend-state',
  backendStateChanged: 'leverframe:backend-state-changed',
} as const;

/** The API the preload script exposes to the UI as `window.leverframe`. */
export interface LeverframeBridge {
  getBackendState(): Promise<BackendState>;
  /** Returns a function that unsubscribes. */
  onBackendStateChanged(callback: (state: BackendState) => void): () => void;
}
