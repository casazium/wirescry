import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { PluginStatus } from '../shared/api';
import type {
  BackendMessage,
  BackendStartMessage,
  BackendState,
  CryptoReply,
  CryptoRequest,
} from '../shared/ipc';

/** Encrypts text for plugins with the OS keychain: text in, base64 out, and back. */
export interface SecureStorage {
  encrypt(text: string): string;
  decrypt(base64: string): string;
}
import { lineSplitter, type FileLogger } from './logger';

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

/**
 * Starts the backend in its own process and restarts it if it crashes,
 * so heavy proxy work never blocks the window.
 */
export class BackendSupervisor extends EventEmitter<{ state: [BackendState] }> {
  /** Per-launch secret. The UI must present it to use the local API. */
  readonly token = randomBytes(32).toString('base64url');
  private child: UtilityProcess | undefined;
  private stopping = false;
  private restarts: number[] = [];
  private current: BackendState = { state: 'starting' };
  private storage: SecureStorage | undefined;
  /** Plugins the backend loaded, as of its last start. */
  plugins: PluginStatus[] = [];

  constructor(
    private readonly options: {
      dataDir: string;
      allowedOrigins: string[];
      pluginsEnabled: boolean;
      logger?: FileLogger;
      /**
       * Encryption for plugins' secure stores (safeStorage), or undefined if the OS has
       * no keychain to use. Called at each start, since safeStorage needs the app ready.
       */
      secureStorage?: () => SecureStorage | undefined;
      app: { version: string; releaseDate: string };
    },
  ) {
    super();
  }

  get state(): BackendState {
    return this.current;
  }

  start(): void {
    this.setState({ state: 'starting' });
    this.storage = this.options.secureStorage?.();
    const child = utilityProcess.fork(path.join(__dirname, 'backend.js'), [], {
      serviceName: 'Wirescry Backend',
      stdio: 'pipe',
    });
    this.child = child;
    // Send the backend's output to the log file, and to the terminal during development.
    const logger = this.options.logger;
    child.stdout?.on(
      'data',
      lineSplitter((line) => {
        logger?.write('backend', 'info', line);
        process.stdout.write(line + '\n');
      }),
    );
    child.stderr?.on(
      'data',
      lineSplitter((line) => {
        logger?.write('backend', 'error', line);
        process.stderr.write(line + '\n');
      }),
    );

    child.on('message', (message: BackendMessage) => {
      if (message.type === 'ready') {
        this.plugins = message.plugins;
        this.setState({
          state: 'ready',
          connection: { apiUrl: `ws://127.0.0.1:${message.apiPort}/`, token: this.token },
        });
        console.log(
          `[wirescry] backend ready: proxy on ${message.proxyPort}, api on ${message.apiPort}, ` +
            `plugins: ${message.plugins.map((p) => `${p.name} (${p.active ? 'running' : p.reason})`).join(', ') || 'none'}`,
        );
      } else if (message.type === 'crypto') {
        child.postMessage(this.crypto(message));
      } else if (message.type === 'error') {
        console.error('[wirescry] backend failed to start:', message.message);
        this.setState({ state: 'failed', message: message.message });
      }
    });

    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (this.stopping) return;
      console.error(`[wirescry] backend exited with code ${code}`);
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (this.restarts.length >= MAX_RESTARTS) {
        this.setState({ state: 'failed', message: `The backend keeps stopping (exit code ${code}).` });
        return;
      }
      this.restarts.push(now);
      setTimeout(() => this.start(), 500 * this.restarts.length);
    });

    const start: BackendStartMessage = {
      type: 'start',
      dataDir: this.options.dataDir,
      token: this.token,
      allowedOrigins: this.options.allowedOrigins,
      pluginsEnabled: this.options.pluginsEnabled,
      secureStorage: this.storage ? 'os' : 'none',
      app: this.options.app,
    };
    child.postMessage(start);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
  }

  private crypto(request: CryptoRequest): CryptoReply {
    const { id, op, data } = request;
    const storage = this.storage;
    try {
      if (!storage) throw new Error('No secure storage on this computer');
      if (typeof data !== 'string' || data.length > 4 * 1024 * 1024) throw new Error('Bad data');
      const result =
        op === 'encrypt' ? storage.encrypt(data) : op === 'decrypt' ? storage.decrypt(data) : undefined;
      if (result === undefined) throw new Error('Unknown operation');
      return { type: 'crypto-result', id, ok: true, data: result };
    } catch (error) {
      return { type: 'crypto-result', id, ok: false, error: (error as Error).message };
    }
  }

  private setState(state: BackendState): void {
    this.current = state;
    this.emit('state', state);
  }
}
