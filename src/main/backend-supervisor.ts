import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { BackendMessage, BackendStartMessage, BackendState } from '../shared/ipc';

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

  constructor(private readonly options: { dataDir: string; allowedOrigins: string[] }) {
    super();
  }

  get state(): BackendState {
    return this.current;
  }

  start(): void {
    this.setState({ state: 'starting' });
    const child = utilityProcess.fork(path.join(__dirname, 'backend.js'), [], {
      serviceName: 'Leverframe Backend',
      stdio: 'inherit',
    });
    this.child = child;

    child.on('message', (message: BackendMessage) => {
      if (message.type === 'ready') {
        this.setState({
          state: 'ready',
          connection: { apiUrl: `ws://127.0.0.1:${message.apiPort}/`, token: this.token },
        });
        console.log(`[leverframe] backend ready: proxy on ${message.proxyPort}, api on ${message.apiPort}`);
      } else if (message.type === 'error') {
        console.error('[leverframe] backend failed to start:', message.message);
        this.setState({ state: 'failed', message: message.message });
      }
    });

    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (this.stopping) return;
      console.error(`[leverframe] backend exited with code ${code}`);
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
    };
    child.postMessage(start);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
  }

  private setState(state: BackendState): void {
    this.current = state;
    this.emit('state', state);
  }
}
