import type { AndroidDevice, AndroidStatus } from '../../shared/api';
import type { DeviceListeners } from '../device-listeners';
import {
  adbEndpoint,
  adbReverse,
  adbReverseList,
  adbReverseRemove,
  adbShell,
  trackDevices,
  type AdbDeviceLine,
  type AdbEndpoint,
  type DeviceTracker,
} from './adb-client';
import { ensureAdbServer, findAdb, NO_ADB, type RunFile } from './adb-server';
import { CaptureRecords, DeviceCapture, MANUAL_FIX, type CaptureTarget } from './capture';
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
  /** Capturing devices: their listeners and where records go. Read-only without it. */
  capture?: {
    listeners: DeviceListeners;
    recordsDir: string;
    /** How long a proxy setting may take to show on the device. */
    readBackMs?: number;
  };
}

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];

/**
 * Android setup: finds the user's ADB server (starting it with their adb if none runs, never
 * restarting one that does), follows its device list, reads each device's name, Android version
 * and identity, and captures and stops devices (capture.ts).
 */
export class AndroidSetup {
  private current: AndroidStatus = { state: 'starting', devices: [] };
  private lines: AdbDeviceLine[] = [];
  private readonly info = new Map<string, DeviceInfo | { error: string }>();
  /** Devices being read, and in which connection: a read from an older one doesn't count. */
  private readonly reading = new Map<string, number>();
  /** Devices to read again once the read now running ends. */
  private readonly readAgain = new Set<string>();
  /** Connects run one after another, so two never start a server at once. */
  private queue: Promise<void> = Promise.resolve();
  private tracker: DeviceTracker | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retries = 0;
  /** Bumped on every (re)connect and on stop, so late callbacks from an older one are ignored. */
  private generation = 0;
  private stopped = false;
  private endpoint: AdbEndpoint | undefined;
  private readonly capture: DeviceCapture | undefined;
  /** What Wirescry is doing to each device, by device id. */
  private readonly busy = new Map<string, 'capturing' | 'stopping'>();
  /** The last thing to tell the user about each device, by device id. */
  private readonly notes = new Map<string, string>();

  constructor(private readonly options: AndroidSetupOptions = {}) {
    if (options.capture) {
      const io = () => {
        if (!this.endpoint) throw new Error('Not connected to the ADB server.');
        return { endpoint: this.endpoint, options: { timeoutMs: this.options.timeoutMs } };
      };
      this.capture = new DeviceCapture({
        io: {
          shell: (serial, command) => adbShell(io().endpoint, serial, command, io().options),
          reverse: (serial, d, h, loopbackOnly) =>
            adbReverse(io().endpoint, serial, d, h, { ...io().options, loopbackOnly }),
          reverseRemove: (serial, d, loopbackOnly) =>
            adbReverseRemove(io().endpoint, serial, d, { ...io().options, loopbackOnly }),
          reverseList: (serial) => adbReverseList(io().endpoint, serial, io().options),
        },
        listeners: options.capture.listeners,
        records: new CaptureRecords(options.capture.recordsDir),
        readBackMs: options.capture.readBackMs,
      });
      // A capturing device's listener can move (certificate reset): its tunnel must follow.
      options.capture.listeners.onPortChange((source, port) => {
        const device = this.current.devices.find((d) => d.id === source.id && d.state === 'ready');
        if (!device || !this.capture?.capturing(source.id)) return;
        const target = {
          id: source.id,
          serial: device.serial,
          label: device.label,
          apiLevel: device.apiLevel,
        };
        void this.act(source.id, port === undefined ? 'stopping' : 'capturing', () =>
          this.capture!.listenerMoved(target, port),
        ).catch((error: unknown) => this.options.log?.(`couldn't follow a moved listener: ${String(error)}`));
      });
    }
  }

  status(): AndroidStatus {
    return { ...this.current, devices: this.current.devices.map((d) => ({ ...d })) };
  }

  /** Finds or starts the server and follows its devices, after reading what an earlier run left. */
  async start(): Promise<void> {
    await this.capture
      ?.load()
      .catch((error: unknown) => this.options.log?.(`couldn't read capture records: ${String(error)}`));
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
    const devices = devicesFrom(this.lines, this.info).map((d) => this.withCapture(d));
    const here = new Set(devices.filter((d) => d.state === 'ready').map((d) => d.id));
    const notConnected = (this.capture?.setUp() ?? [])
      .filter((d) => !here.has(d.id))
      .map(({ label, capturing }) => ({ label, capturing }));
    const rest = { ...this.current };
    delete rest.notConnected;
    this.set({ ...rest, devices, ...(notConnected.length ? { notConnected } : {}) });
  }

  /** A device with what capture knows about it. */
  private withCapture(device: AndroidDevice): AndroidDevice {
    if (!device.id || !this.capture) return device;
    const id = device.id;
    const record = this.capture.capturing(id);
    const leftover = this.capture.isLeftover(id);
    const localAccess =
      this.options.capture!.listeners.list().find((l) => l.source.id === id)?.localAccess ?? false;
    const { strayProxy, ...rest } = device;
    return {
      ...rest,
      ...(record
        ? { capture: { devicePort: record.devicePort, hostPort: record.hostPort, localAccess } }
        : {}),
      ...(leftover ? { leftover: true } : {}),
      // A 127.0.0.1 proxy that's Wirescry's own isn't stray.
      ...(strayProxy && !record && !leftover ? { strayProxy } : {}),
      ...(this.busy.has(id) ? { busy: this.busy.get(id) } : {}),
      ...(this.notes.has(id) ? { note: this.notes.get(id) } : {}),
    };
  }

  /** The connected device with this id, to act on. */
  private target(id: string, purpose: 'capture' | 'stop'): CaptureTarget {
    if (!this.capture) throw new Error('Android capture is off.');
    const device = this.current.devices.find((d) => d.id === id);
    if (!device || device.state !== 'ready') {
      throw new Error(
        purpose === 'stop'
          ? `Connect the device to put it back. Or, with only that device connected, run: ${MANUAL_FIX}`
          : 'That device isn’t connected and ready.',
      );
    }
    if (purpose === 'capture' && device.unsupported) throw new Error(device.unsupported);
    return { id, serial: device.serial, label: device.label, apiLevel: device.apiLevel };
  }

  /** Runs an action on a device, showing it as busy, and keeping its outcome as the device's note. */
  private async act<T>(id: string, busy: 'capturing' | 'stopping', task: () => Promise<T>): Promise<T> {
    this.busy.set(id, busy);
    this.notes.delete(id);
    this.publishDevices();
    try {
      return await task();
    } catch (error) {
      this.notes.set(id, (error as Error).message);
      throw error;
    } finally {
      this.busy.delete(id);
      this.rereadDevice(id);
      this.publishDevices();
    }
  }

  /** Reads a device's details again (its proxy has changed). */
  private rereadDevice(id: string): void {
    const device = this.current.devices.find((d) => d.id === id);
    const line = device && this.lines.find((l) => l.serial === device.serial);
    if (!line) return;
    // The old details stay until the new ones arrive, so the device keeps its id meanwhile.
    this.readInfo(line, this.generation, true);
  }

  /**
   * Routes a device's traffic through Wirescry. Returns `needsConfirmation` with the device's
   * current proxy if it has one, without changing anything.
   */
  captureDevice(id: string, replaceProxy?: string): Promise<{ needsConfirmation?: string }> {
    const target = this.target(id, 'capture');
    return this.act(id, 'capturing', () => this.capture!.capture(target, replaceProxy));
  }

  /** Puts a device back, whether this run or an earlier one set it up. */
  async stopDevice(id: string): Promise<void> {
    const target = this.target(id, 'stop');
    const { note } = await this.act(id, 'stopping', () => this.capture!.stop(target));
    if (note) {
      this.notes.set(id, note);
      this.publishDevices();
    }
  }

  /** Sets a stray 127.0.0.1 proxy back to none. */
  clearProxy(id: string): Promise<void> {
    const target = this.target(id, 'stop');
    return this.act(id, 'stopping', () => this.capture!.clearStrayProxy(target));
  }

  /** Whether a device may reach this computer and its local networks. */
  setLocalAccess(id: string, allowed: boolean): void {
    if (!this.capture) throw new Error('Android capture is off.');
    if (!this.capture.capturing(id)) throw new Error('Capture the device first.');
    this.options.capture!.listeners.setLocalAccess(id, allowed);
    this.publishDevices();
  }

  /** Puts back every capturing device it can within the time limit (quitting). */
  async stopAll(timeoutMs: number): Promise<void> {
    await this.capture?.stopAll((id) => {
      const device = this.current.devices.find((d) => d.id === id && d.state === 'ready');
      return device?.serial;
    }, timeoutMs);
  }

  private readInfo(line: AdbDeviceLine, generation: number, again = false): void {
    const key = infoKey(line);
    if (this.reading.get(key) === generation) {
      // A read is running, but the device may have changed since it started: read once more after.
      if (again) this.readAgain.add(key);
      return;
    }
    if ((this.info.has(key) && !again) || !this.endpoint) return;
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
        if (this.readAgain.delete(key)) this.readInfo(line, generation, true);
      });
  }
}
