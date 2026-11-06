import type { AndroidStatus } from '../../shared/api';
import {
  adbEndpoint,
  trackDevices,
  type AdbDeviceLine,
  type AdbEndpoint,
  type DeviceTracker,
} from './adb-client';
import { ensureAdbServer, findAdb, NO_ADB, type RunFile } from './adb-server';
import { devicesFrom, infoKey, readDeviceInfo, type DeviceInfo } from './devices';

export interface AndroidSetupOptions {
  /** The ADB server's address. Read from the environment, as adb does, if omitted. */
  endpoint?: () => AdbEndpoint;
  /** Finds the user's adb, to start a server when none runs. */
  findAdb?: () => string | undefined;
  /** Runs adb. For tests. */
  run?: RunFile;
  /** Reads a device's details. For tests. */
  readInfo?: (endpoint: AdbEndpoint, serial: string) => Promise<DeviceInfo>;
  /** Called whenever status() changes. */
  onStatusChange?: () => void;
  /** Waits between tries to reach the server after losing it; the last repeats. */
  retryDelaysMs?: number[];
  /** How long to wait for each answer from the server. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];

/**
 * Android setup, read-only for now: finds the user's ADB server (starting it with their adb
 * if none runs, never restarting one that does), follows its device list, and reads each
 * device's name, Android version and identity.
 */
export class AndroidSetup {
  private current: AndroidStatus = { state: 'starting', devices: [] };
  private lines: AdbDeviceLine[] = [];
  private readonly info = new Map<string, DeviceInfo | { error: string }>();
  /** Devices being read, and in which connection: a read from an older one doesn't count. */
  private readonly reading = new Map<string, number>();
  /** Connects run one after another, so two never start a server at once. */
  private queue: Promise<void> = Promise.resolve();
  private tracker: DeviceTracker | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retries = 0;
  /** Bumped on every (re)connect and on stop, so late callbacks from an older one are ignored. */
  private generation = 0;
  private stopped = false;
  private endpoint: AdbEndpoint | undefined;

  constructor(private readonly options: AndroidSetupOptions = {}) {}

  status(): AndroidStatus {
    return { ...this.current, devices: this.current.devices.map((d) => ({ ...d })) };
  }

  /** Finds or starts the server and follows its devices. */
  start(): Promise<void> {
    return this.queued(true);
  }

  /** "Check again": looks for the server afresh, starting one if none runs. */
  refresh(): Promise<void> {
    return this.queued(true);
  }

  private queued(startServer: boolean): Promise<void> {
    const next = this.queue.then(() => this.connect(startServer));
    this.queue = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.tracker?.close();
    this.tracker = undefined;
    clearTimeout(this.retryTimer);
  }

  private set(status: AndroidStatus): void {
    this.current = status;
    this.options.onStatusChange?.();
  }

  private async connect(startServer: boolean): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.tracker?.close();
    this.tracker = undefined;
    clearTimeout(this.retryTimer);
    let endpoint: AdbEndpoint;
    try {
      endpoint = (this.options.endpoint ?? (() => adbEndpoint()))();
    } catch (error) {
      this.set({ state: 'failed', error: (error as Error).message, devices: [] });
      return;
    }
    this.endpoint = endpoint;
    // Read every device afresh after a reconnect or "Check again".
    this.info.clear();
    if (this.current.state !== 'ready') this.set({ ...this.current, state: 'starting' });
    const server = await ensureAdbServer({
      endpoint,
      start: startServer,
      findAdb: this.options.findAdb ?? (() => findAdb()),
      run: this.options.run,
      timeoutMs: this.options.timeoutMs,
    });
    if (generation !== this.generation) return;
    if (server.state !== 'running') {
      this.lines = [];
      this.set({
        state: server.state === 'no-adb' ? 'no-adb' : 'failed',
        error: server.state === 'no-adb' ? NO_ADB : server.error,
        devices: [],
      });
      // Keep looking (without starting anything): Android Studio may start a server.
      this.retryLater();
      return;
    }
    if (server.started) this.options.log?.(`started the ADB server with ${server.adbPath}`);
    this.retries = 0;
    this.set({
      state: 'ready',
      serverVersion: server.version,
      ...(server.started ? { startedWith: server.adbPath } : {}),
      devices: this.current.state === 'ready' ? this.current.devices : [],
    });
    this.tracker = trackDevices(
      endpoint,
      (lines) => {
        if (generation !== this.generation) return;
        this.retries = 0;
        this.lines = lines;
        // Forget transports that have gone; a reconnected device is read again.
        const listed = new Set(lines.map(infoKey));
        for (const key of this.info.keys()) if (!listed.has(key)) this.info.delete(key);
        for (const line of lines) if (line.state === 'device') this.readInfo(line, generation);
        this.publishDevices();
      },
      (error) => {
        if (generation !== this.generation) return;
        this.tracker = undefined;
        this.lines = [];
        this.set({
          state: 'failed',
          error: `Lost touch with the ADB server (${error?.message ?? 'it closed the connection'}). Trying again.`,
          devices: [],
        });
        this.retryLater();
      },
      { timeoutMs: this.options.timeoutMs },
    );
  }

  private retryLater(): void {
    if (this.stopped) return;
    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.retries, delays.length - 1)]!;
    this.retries += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.queued(false), delay);
    this.retryTimer.unref?.();
  }

  private publishDevices(): void {
    if (this.current.state !== 'ready') return;
    this.set({ ...this.current, devices: devicesFrom(this.lines, this.info) });
  }

  private readInfo(line: AdbDeviceLine, generation: number): void {
    const key = infoKey(line);
    if (this.info.has(key) || this.reading.get(key) === generation || !this.endpoint) return;
    this.reading.set(key, generation);
    const read = this.options.readInfo ?? ((endpoint, serial) => readDeviceInfo(endpoint, serial));
    read(this.endpoint, line.serial)
      .then(
        (info) => info,
        (error: unknown) => ({ error: `Couldn’t read this device’s details: ${(error as Error).message}` }),
      )
      .then((result) => {
        if (this.reading.get(key) === generation) this.reading.delete(key);
        if (generation !== this.generation) return;
        // Still listed under the same transport?
        if (!this.lines.some((l) => infoKey(l) === key)) return;
        this.info.set(key, result);
        this.publishDevices();
      });
  }
}
