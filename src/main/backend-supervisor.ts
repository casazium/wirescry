import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { PluginStatus } from '../shared/api';
import backendV8Flags from '../shared/backend-v8-flags.json';
import type {
  BackendMessage,
  BackendStartMessage,
  BackendState,
  CryptoReply,
  CryptoRequest,
  BackendShutdownMessage,
  BackendRestart,
  HarRequest,
  AndroidUndoMessage,
} from '../shared/ipc';
import { ANDROID_RECORDS_DIR } from '../shared/ipc';
import { hasRecords, waitForNoRecordsSync } from './android-undo';

/** How long a HAR export or import may take (large captures, slow disks). */
const HAR_TIMEOUT_MS = 10 * 60 * 1000;

type HarJob = HarRequest extends infer R ? (R extends HarRequest ? Omit<R, 'type' | 'id'> : never) : never;

/** Encrypts text for plugins with the OS keychain: text in, base64 out, and back. */
export interface SecureStorage {
  encrypt(text: string): Promise<string>;
  decrypt(base64: string): Promise<string>;
}
import { lineSplitter, type FileLogger } from './logger';

/** How long the backend gets to stop cleanly on quit before it's killed. */
const SHUTDOWN_TIMEOUT_MS = 3000;
/** How long to wait for a killed backend to exit. */
const KILL_TIMEOUT_MS = 1000;
const MAX_RESTARTS = 5;

/**
 * V8 flags for the backend, given when its process starts. The first lets Pro's rules use
 * linear-time regexes (the `l` flag); the others are what Pro's bytecode was compiled with
 * (scripts/pro-bytecode), or V8 rejects it. They must be set at launch: changing a V8 flag
 * once the process is running breaks every V8 context made afterwards, so a worker thread
 * or a decompression stream aborts the whole backend. Nothing may change them at run time.
 */
export const BACKEND_V8_FLAGS: readonly string[] = backendV8Flags;
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
  /** The last restart, reported with each state until the next one. */
  private lastRestart: BackendRestart | undefined;
  /** Set when the backend reports it couldn't start, so its exit isn't treated as a crash. */
  private startFailed = false;
  /** Counts starts, reported with 'ready'. */
  private generation = 0;
  private nextHarId = 0;
  private readonly harWaiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextAndroidId = 0;
  private readonly androidWaiting = new Map<number, () => void>();
  /** The keychain, worked out on the first request after each start (null: none). */
  private storage: SecureStorage | null | undefined;
  /** Plugins the backend loaded, as of its last start. */
  plugins: PluginStatus[] = [];
  /** With the selfCheck option: the problems the backend's self-check found at its last start. */
  selfCheckProblems: string[] | undefined;
  /** The last start's steps, from its ready message. */
  startupSteps: Array<[step: string, ms: number]> | undefined;

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
      /** For the packaged self-test: have the backend check itself before it reports ready. */
      selfCheck?: boolean;
      /** Shows an OS notification the backend asked for. */
      notify?: (title: string, body: string) => void;
    },
  ) {
    super();
  }

  get state(): BackendState {
    return this.current;
  }

  start(): void {
    this.startFailed = false;
    this.generation += 1;
    const generation = this.generation;
    this.setState({ state: 'starting', ...this.restartInfo() });
    this.storage = undefined;
    const child = utilityProcess.fork(path.join(__dirname, 'backend.js'), [], {
      serviceName: 'Wirescry Backend',
      stdio: 'pipe',
      execArgv: [`--js-flags=${BACKEND_V8_FLAGS.join(' ')}`],
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
        this.selfCheckProblems = message.selfCheck;
        this.startupSteps = message.startup;
        this.setState({
          state: 'ready',
          connection: { apiUrl: `ws://127.0.0.1:${message.apiPort}/`, token: this.token },
          generation,
          ...this.restartInfo(),
        });
        console.log(
          `[wirescry] backend ready: proxy on ${message.proxyPort}, api on ${message.apiPort}, ` +
            `plugins: ${message.plugins.map((p) => `${p.name} (${p.active ? 'running' : p.reason})`).join(', ') || 'none'}`,
        );
      } else if (message.type === 'har-result') {
        const waiting = this.harWaiting.get(message.id);
        if (!waiting) return;
        this.harWaiting.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(new Error(message.error));
      } else if (message.type === 'notify') {
        this.options.notify?.(String(message.title).slice(0, 200), String(message.body).slice(0, 1000));
      } else if (message.type === 'android-undone') {
        this.androidWaiting.get(message.id)?.();
        this.androidWaiting.delete(message.id);
      } else if (message.type === 'crypto') {
        void this.crypto(message).then((reply) => {
          // A restarted backend doesn't get the old one's answers.
          if (this.child === child) child.postMessage(reply);
        });
      } else if (message.type === 'error') {
        // The full error goes to the log; people get its first line.
        console.error('[wirescry] backend failed to start:', message.message);
        this.startFailed = true;
        const first =
          message.message
            .split('\n')[0]
            ?.replace(/^Error: /, '')
            .trim() || 'Unknown error';
        this.setState({ state: 'failed', message: `Wirescry's proxy couldn't start: ${first}` });
      }
    });

    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      this.failHarJobs('The backend stopped while working on the file.');
      if (this.stopping) return;
      console.error(`[wirescry] backend exited with code ${code}`);
      // It couldn't start, and said why: trying again would fail the same way.
      if (this.startFailed) return;
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (this.restarts.length >= MAX_RESTARTS) {
        this.setState({
          state: 'failed',
          message: `Wirescry's proxy keeps stopping (exit code ${code}), so it hasn't been restarted again.`,
        });
        return;
      }
      this.restarts.push(now);
      this.lastRestart = { at: now, exitCode: code };
      setTimeout(() => {
        if (!this.stopping) this.start();
      }, 500 * this.restarts.length);
    });

    const start: BackendStartMessage = {
      type: 'start',
      dataDir: this.options.dataDir,
      token: this.token,
      allowedOrigins: this.options.allowedOrigins,
      pluginsEnabled: this.options.pluginsEnabled,
      app: this.options.app,
      selfCheck: this.options.selfCheck,
    };
    child.postMessage(start);
  }

  /** Starts the backend again after it failed. Does nothing while it's running. */
  restart(): void {
    if (this.child || this.stopping || this.current.state !== 'failed') {
      console.warn('[wirescry] not restarting the backend: it is still running or Wirescry is quitting');
      return;
    }
    this.restarts = [];
    this.lastRestart = { at: Date.now(), byUser: true };
    this.start();
  }

  private restartInfo(): { restart?: BackendRestart } {
    return this.lastRestart ? { restart: this.lastRestart } : {};
  }

  /** Asks the backend to export or import a HAR file at a path the user chose. */
  har(job: HarJob): Promise<unknown> {
    const child = this.child;
    if (!child || this.current.state !== 'ready')
      return Promise.reject(new Error("Wirescry's backend isn't running."));
    const id = ++this.nextHarId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.harWaiting.delete(id);
        reject(new Error('That took too long.'));
      }, HAR_TIMEOUT_MS);
      this.harWaiting.set(id, { resolve, reject, timer });
      child.postMessage({ type: 'har', id, ...job } satisfies HarRequest);
    });
  }

  private failHarJobs(reason: string): void {
    for (const [id, waiting] of this.harWaiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      this.harWaiting.delete(id);
    }
  }

  /**
   * Asks the backend to put capturing Android devices back, and waits for it (a little longer
   * than it's given). For quits that don't wait for the backend to stop, such as an update.
   */
  async undoAndroid(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child || !hasRecords(this.androidRecordsDir)) return;
    const id = ++this.nextAndroidId;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.androidWaiting.delete(id);
        resolve();
      }, timeoutMs + 500);
      timer.unref();
      this.androidWaiting.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.postMessage({ type: 'android-undo', id, timeoutMs } satisfies AndroidUndoMessage);
      } catch {
        this.androidWaiting.delete(id);
        resolve();
      }
    });
  }

  /**
   * The same, for Windows logging off, where nothing can be awaited: asks the backend, then
   * blocks until the devices' records are gone or `timeoutMs` passes.
   */
  undoAndroidSync(timeoutMs: number): void {
    const child = this.child;
    if (!child || !hasRecords(this.androidRecordsDir)) return;
    try {
      child.postMessage({
        type: 'android-undo',
        id: ++this.nextAndroidId,
        timeoutMs,
      } satisfies AndroidUndoMessage);
    } catch {
      return;
    }
    waitForNoRecordsSync(this.androidRecordsDir, timeoutMs);
  }

  private get androidRecordsDir(): string {
    return path.join(this.options.dataDir, ANDROID_RECORDS_DIR);
  }

  /** Kills the backend at once. Bodies on disk are left for the next start to clear. */
  stop(): void {
    this.stopping = true;
    this.child?.kill();
  }

  /**
   * Asks the backend to stop, which deletes the bodies it stored on disk, and waits for
   * it to exit. A backend that doesn't stop in time is killed. Then the bodies folder is
   * deleted here as well, in case the backend couldn't.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const within = (ms: number): Promise<boolean> =>
        Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref()),
        ]);
      try {
        child.postMessage({ type: 'shutdown' } satisfies BackendShutdownMessage);
      } catch {
        // Already gone.
      }
      if (!(await within(SHUTDOWN_TIMEOUT_MS))) {
        child.kill();
        await within(KILL_TIMEOUT_MS);
      }
    }
    // Windows may hold a file briefly after the process exits.
    await rm(this.bodiesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  }

  /** Deletes stored bodies at once, for when there's no time to stop the backend. */
  removeBodiesSync(): void {
    try {
      rmSync(this.bodiesDir, { recursive: true, force: true });
    } catch {
      // Files the backend still has open; the next start empties the folder.
    }
  }

  private get bodiesDir(): string {
    return path.join(this.options.dataDir, 'bodies');
  }

  private async crypto(request: CryptoRequest): Promise<CryptoReply> {
    const { id, op, data } = request;
    try {
      this.storage ??= this.options.secureStorage?.() ?? null;
      const storage = this.storage;
      if (op === 'available') return { type: 'crypto-result', id, ok: true, data: storage ? 'os' : 'none' };
      if (!storage) throw new Error('No secure storage on this computer');
      if (typeof data !== 'string' || data.length > 4 * 1024 * 1024) throw new Error('Bad data');
      const result =
        op === 'encrypt'
          ? await storage.encrypt(data)
          : op === 'decrypt'
            ? await storage.decrypt(data)
            : undefined;
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
