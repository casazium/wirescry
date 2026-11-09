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
import { ensureAdbServer, findAdb, noAdb, type RunFile } from './adb-server';
import { CaptureRecords, DeviceCapture, MANUAL_FIX, type CaptureTarget } from './capture';
import { DeviceCertificates } from './certificates';
import { Refusals } from '../refusals';
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
  /**
   * Whether start() starts an ADB server when none is running (default true). The app passes
   * false: it then starts one only for devices an earlier run left set up, or when asked.
   */
  startServerAtLaunch?: boolean;
  /** How long to wait for each answer from the server. */
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Capturing devices: their listeners and where records go. Read-only without it. */
  capture?: {
    listeners: DeviceListeners;
    recordsDir: string;
    /** How long a proxy setting may take to show on the device. */
    readBackMs?: number;
    /** How often each capturing device's tunnel and proxy are checked. */
    pollMs?: number;
    /** How long a capturing device may be gone (a reconnect, a re-read) before the user is told. */
    graceMs?: number;
    /**
     * Wirescry's certificate now (PEM, and its SPKI fingerprint), and where to remember which
     * devices trust it. Without them, certificates aren't offered.
     */
    certificate?: () => { cert: string; spki: string };
    trustFile?: string;
  };
  /** Shows an OS notification: Wirescry may be in the background when a device goes. */
  notify?: (title: string, body: string) => void;
}

type Busy = NonNullable<AndroidDevice['busy']>;

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
/** How long quitting waits, after putting devices back, to remove copied certificates. */
const REMOVE_ON_QUIT_MS = 500;
const POLL_MS = 5000;
const GRACE_MS = 5000;
/** Refusals can come many a second: the device list is sent again at most this often for them. */
const REFUSALS_PUBLISH_MS = 250;
/** Starts a note about a check that failed, so a later good check can clear it. */
const CHECK_FAILED = 'Wirescry couldn’t check this device’s tunnel:';

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
  private readonly certificates: DeviceCertificates | undefined;
  /** Devices Wirescry copied its current certificate to, by id. */
  private readonly sent = new Set<string>();
  /** Every certificate copied to a device this run (a reset makes a new one): what removal may delete. */
  private readonly copied = new Set<string>();
  /** What Wirescry is doing to each device, by device id: actions can overlap, the latest shows. */
  private readonly busy = new Map<string, Array<Busy>>();
  private pollTimer: NodeJS.Timeout | undefined;
  /** Whether the server has sent its device list since the last (re)connect. */
  private listed = false;
  /** Set once devices are being put back for a quit. */
  private quitting = false;
  /** Devices being checked now. */
  private readonly checking = new Set<string>();
  /** Capturing devices not connected now, and whether the user has been told. */
  private readonly away = new Map<string, { timer?: NodeJS.Timeout; notified: boolean }>();
  /** The last thing to tell the user about each device, by device id. */
  private readonly notes = new Map<string, string>();
  /**
   * Connections that refused the certificate, by device, during its current capture. Each capture
   * starts afresh (however the last one ended), and so does trust in a certificate.
   */
  private readonly refusals = new Refusals();
  private refusalsTimer: NodeJS.Timeout | undefined;
  /**
   * Why the last attempt to start a server failed (no adb, or adb failed), kept while none runs:
   * the retries that follow only look, and would otherwise replace it with "no server".
   */
  private startFailure: AndroidStatus | undefined;

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
      const { certificate, trustFile } = options.capture;
      if (certificate && trustFile) {
        this.certificates = new DeviceCertificates({
          io: {
            shell: (serial, command, input) =>
              adbShell(io().endpoint, serial, command, { ...io().options, input }),
          },
          trustFile,
        });
      }
      // A capturing device's listener can move (certificate reset): its tunnel must follow.
      options.capture.listeners.onPortChange((source, port) => {
        const device = this.current.devices.find((d) => d.id === source.id && d.state === 'ready');
        if (!device || !this.capture?.capturing(source.id)) return;
        const target = this.targetOf(device);
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
    await this.certificates?.load();
    await this.capture
      ?.load()
      .catch((error: unknown) => this.options.log?.(`couldn't read capture records: ${String(error)}`));
    if (this.capture && !this.stopped) this.startPolling();
    // Devices left set up have no internet until put back, which needs the server.
    const leftovers = (this.capture?.setUp().length ?? 0) > 0;
    return this.queued(this.options.startServerAtLaunch !== false || leftovers);
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
    clearInterval(this.pollTimer);
    clearTimeout(this.refusalsTimer);
    this.refusalsTimer = undefined;
    for (const away of this.away.values()) clearTimeout(away.timer);
    this.away.clear();
  }

  /** Without a server there's nothing new to send on each retry: only a change is sent. */
  private setIfChanged(status: AndroidStatus): void {
    const { notConnected: _ignored, ...shown } = this.current;
    void _ignored;
    if (JSON.stringify(shown) !== JSON.stringify(status)) this.set(status);
  }

  private set(status: AndroidStatus): void {
    this.current = this.withNotConnected(status);
    this.watchPresence();
    this.options.onStatusChange?.();
  }

  /** Ids of the devices connected and ready now. */
  private readyIds(status: AndroidStatus = this.current): Set<string> {
    if (status.state !== 'ready') return new Set();
    return new Set(status.devices.flatMap((d) => (d.state === 'ready' && d.id ? [d.id] : [])));
  }

  /**
   * Devices Wirescry set up that aren't here: those left by an earlier run at once (while the
   * server answers), capturing ones only once they've been gone a while, so a reconnect or a
   * re-read doesn't flash a warning.
   */
  private withNotConnected(status: AndroidStatus): AndroidStatus {
    const rest = { ...status };
    delete rest.notConnected;
    if (!this.capture) return rest;
    const here = this.readyIds(status);
    // A leftover may be a device whose details aren't read yet (startup, a reconnect): wait.
    const reading = status.devices.some((d) => d.state === 'ready' && !d.id && !d.error);
    const notConnected = this.capture
      .setUp()
      .filter((d) =>
        d.capturing
          ? this.away.get(d.id)?.notified
          : status.state === 'ready' && this.listed && !reading && !here.has(d.id),
      )
      .map(({ id, label, capturing, emulator }) => ({
        id,
        label,
        capturing,
        ...(emulator ? { emulator } : {}),
      }));
    return notConnected.length ? { ...rest, notConnected } : rest;
  }

  /**
   * Follows capturing devices coming and going: one gone longer than the grace period gets a
   * notification; one back gets its tunnel checked at once (a reconnect drops adbd's reverse
   * rules, measured with `adb reconnect` on the API 37 emulator).
   */
  private watchPresence(): void {
    if (!this.capture || this.stopped) return;
    const here = this.readyIds();
    const capturing = new Set(this.capture.capturingIds());
    for (const [id, away] of [...this.away]) {
      if (capturing.has(id) && !here.has(id)) continue;
      clearTimeout(away.timer);
      this.away.delete(id);
      if (capturing.has(id)) this.checkDevice(id);
    }
    for (const id of capturing) {
      if (here.has(id) || this.away.has(id)) continue;
      const away: { timer?: NodeJS.Timeout; notified: boolean } = { notified: false };
      away.timer = setTimeout(() => this.wentAway(id), this.options.capture?.graceMs ?? GRACE_MS);
      away.timer.unref?.();
      this.away.set(id, away);
    }
  }

  /** A capturing device has been gone past the grace period: tell the user, once. */
  private wentAway(id: string): void {
    const away = this.away.get(id);
    const record = this.capture?.capturing(id);
    if (!away || !record || this.stopped) return;
    away.notified = true;
    away.timer = undefined;
    const { label } = record;
    if (this.current.state !== 'ready') {
      this.options.notify?.(
        'Lost the ADB server while capturing',
        `${label} has no internet until Wirescry reaches the ADB server again, which it keeps trying. Starting Android Studio, or running “adb start-server”, starts it.`,
      );
    } else if (record.emulator) {
      this.options.notify?.(
        'Emulator closed while capturing',
        `${label} still points at Wirescry. Start it again while Wirescry is running and capture carries on; Stop puts it back.`,
      );
    } else {
      this.options.notify?.(
        'Android device disconnected while capturing',
        `${label} has no internet until you connect it again, and capture carries on. Or, with only that device connected, run: ${MANUAL_FIX}`,
      );
    }
    this.set(this.current);
  }

  /** Checks every capturing device that's connected (the poll). */
  private checkAll(): void {
    if (!this.capture || this.stopped) return;
    const here = this.readyIds();
    for (const id of this.capture.capturingIds()) if (here.has(id)) this.checkDevice(id);
  }

  /** Checks one capturing device's tunnel and proxy, unless it's busy or already being checked. */
  private checkDevice(id: string): void {
    if (!this.capture || this.stopped || this.quitting || this.checking.has(id) || this.busy.has(id)) return;
    const device = this.current.devices.find((d) => d.id === id && d.state === 'ready');
    if (!device) return;
    this.checking.add(id);
    void this.capture
      .check(this.targetOf(device))
      .then(
        ({ stopped, changed }) => {
          const failedBefore = this.notes.get(id)?.startsWith(CHECK_FAILED);
          if (failedBefore) this.notes.delete(id);
          if (stopped) this.notes.set(id, stopped);
          if (stopped || changed || failedBefore) this.publishDevices();
        },
        (error: unknown) => {
          const note = `${CHECK_FAILED} ${(error as Error).message}`;
          if (this.notes.get(id) === note) return;
          this.options.log?.(`couldn't check ${device.serial}: ${String(error)}`);
          this.notes.set(id, note);
          this.publishDevices();
        },
      )
      .finally(() => this.checking.delete(id));
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
    this.listed = false;
    // Read every device afresh after a reconnect or "Check again".
    this.info.clear();
    // Only when it may start a server: a retry that just looks would flicker the reason away.
    if (startServer && this.current.state !== 'ready') this.set({ ...this.current, state: 'starting' });
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
      if (server.state === 'not-running') {
        this.setIfChanged(this.startFailure ?? { state: 'no-server', devices: [] });
      } else {
        const failure: AndroidStatus = {
          state: server.state === 'no-adb' ? 'no-adb' : 'failed',
          error: server.state === 'no-adb' ? noAdb() : server.error,
          devices: [],
        };
        // Only after a start was tried (no adb, or adb failed), not a server that didn't answer.
        if (startServer && (server.state === 'no-adb' || server.adbPath)) this.startFailure = failure;
        this.setIfChanged(failure);
      }
      // Keep looking (without starting anything): Android Studio may start a server.
      this.retryLater();
      return;
    }
    this.startFailure = undefined;
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
        this.listed = true;
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
    this.set({ ...this.current, devices });
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
      ...(this.certificates
        ? {
            certificate: {
              trusted: this.certificates.trusted(id, this.options.capture!.certificate!().spki),
              sent: this.sent.has(id),
            },
          }
        : {}),
      ...(record && this.refusals.of(id) ? { refused: this.refusals.of(id) } : {}),
      ...(this.busy.has(id) ? { busy: this.busy.get(id)!.at(-1) } : {}),
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
    return this.targetOf(device);
  }

  private targetOf(device: AndroidDevice): CaptureTarget {
    return {
      id: device.id!,
      serial: device.serial,
      label: device.label,
      apiLevel: device.apiLevel,
      emulator: device.emulator,
    };
  }

  /** Runs an action on a device, showing it as busy, and keeping its outcome as the device's note. */
  private async act<T>(id: string, busy: Busy, task: () => Promise<T>): Promise<T> {
    this.busy.set(id, [...(this.busy.get(id) ?? []), busy]);
    this.notes.delete(id);
    this.publishDevices();
    try {
      return await task();
    } catch (error) {
      this.notes.set(id, (error as Error).message);
      throw error;
    } finally {
      const left = this.busy.get(id) ?? [];
      left.splice(left.lastIndexOf(busy), 1);
      if (left.length) this.busy.set(id, left);
      else this.busy.delete(id);
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
  async captureDevice(
    id: string,
    replaceProxy?: string,
    confirmWireless = false,
  ): Promise<{ needsConfirmation?: string; needsWirelessConfirmation?: boolean }> {
    const target = this.target(id, 'capture');
    // Wireless debugging turns itself off on sleep and network changes, and Android's Wi-Fi
    // settings don't show the global proxy: the device could be left without internet.
    const wireless = this.current.devices.find((d) => d.id === id)?.wireless;
    if (wireless && !confirmWireless) return { needsWirelessConfirmation: true };
    return this.act(id, 'capturing', () => {
      this.refusals.clear(id);
      return this.capture!.capture(target, replaceProxy);
    });
  }

  /** Captures again a device an earlier run left set up. */
  async resumeDevice(id: string): Promise<void> {
    const target = this.target(id, 'stop');
    // Counts live only in this run, and Resume is for a capture an earlier run left: none to clear.
    await this.act(id, 'capturing', () => this.capture!.resume(target));
  }

  /** Puts a device back, whether this run or an earlier one set it up. */
  async stopDevice(id: string): Promise<void> {
    const target = this.target(id, 'stop');
    const { note } = await this.act(id, 'stopping', () => this.capture!.stop(target));
    if (note) {
      this.notes.set(id, note);
      this.publishDevices();
    }
    await this.removeCertificateFile(id, target.serial);
  }

  /** A connection from this device refused Wirescry's certificate (its listener saw it). */
  certificateRefused(id: string, host: string | undefined): void {
    // Shown only while capturing, and each capture starts a new count: a late one after Stop is harmless.
    if (this.stopped) return;
    this.refusals.add(id, host);
    this.refusalsTimer ??= setTimeout(() => {
      this.refusalsTimer = undefined;
      this.publishDevices();
    }, REFUSALS_PUBLISH_MS);
    this.refusalsTimer.unref?.();
  }

  /** Forgets a device an earlier run left set up that isn't connected (see DeviceCapture.forget). */
  async forgetDevice(id: string): Promise<void> {
    if (!this.capture) throw new Error('Android capture is off.');
    if (this.readyIds().has(id)) throw new Error('It’s connected: use Restore to put it back.');
    await this.capture.forget(id);
    this.publishDevices();
    this.set(this.current);
  }

  /** Copies Wirescry's certificate to a device and opens Security settings there. */
  async sendCertificate(id: string): Promise<{ settingsOpened: boolean }> {
    const certificates = this.certificatesOn();
    const target = this.target(id, 'capture');
    // One at a time with Capture and Stop (and Stop's removal of the copy).
    return this.act(id, 'sending', () =>
      this.capture!.exclusive(id, async () => {
        const { cert } = this.options.capture!.certificate!();
        this.copied.add(cert);
        const result = await certificates.send(target.serial, cert);
        // A certificate reset while it was on its way: the copy is the old one.
        if (this.options.capture!.certificate!().cert !== cert) {
          throw new Error('Wirescry’s certificate changed while sending it. Send it again.');
        }
        this.sent.add(id);
        return result;
      }),
    );
  }

  /** Opens Wirescry's setup page in a browser on a capturing device: it says whether the certificate is trusted. */
  async checkCertificate(id: string): Promise<{ browser: 'chrome' | 'default' }> {
    const certificates = this.certificatesOn();
    const target = this.target(id, 'capture');
    // The page is answered by the device's listener: only reachable while capturing.
    if (!this.capture!.capturing(id)) throw new Error('Capture the device first.');
    return certificates.openCheck(target.serial);
  }

  /** Opens the device's list of certificates the user installed. */
  async showInstalledCertificates(id: string): Promise<void> {
    const certificates = this.certificatesOn();
    await certificates.openInstalled(this.target(id, 'capture').serial);
  }

  /**
   * A browser on this device trusts the certificate with SPKI `spki`: its HTTPS check arrived on
   * the device's listener, which serves that certificate. Ignored unless it's Wirescry's current
   * one (a listener still restarting after a reset serves the old one).
   */
  async markTrusted(id: string, spki: string): Promise<void> {
    if (!this.certificates || this.options.capture?.certificate?.().spki !== spki) return;
    try {
      // Refusals from before it was installed (Chrome's too) aren't news any more.
      if (await this.certificates.markTrusted(id, spki)) this.refusals.clear(id);
    } finally {
      this.publishDevices();
    }
  }

  /** A browser on this device refused the certificate with SPKI `spki` (its HTTPS check failed). */
  async markUntrusted(id: string, spki: string): Promise<void> {
    if (!this.certificates || this.options.capture?.certificate?.().spki !== spki) return;
    try {
      await this.certificates.forget(id, spki);
    } finally {
      this.publishDevices();
    }
  }

  /** Wirescry has a new certificate: copies of the old one are out of date (trust follows by itself). */
  certificateChanged(): void {
    this.sent.clear();
    this.refusals.clearAll();
    this.publishDevices();
  }

  private certificatesOn(): DeviceCertificates {
    if (!this.certificates) throw new Error('Android capture is off.');
    return this.certificates;
  }

  /** What removal may delete: the current certificate (a copy from an earlier run), and any copied this run. */
  private copies(): string[] {
    return [this.options.capture!.certificate!().cert, ...this.copied];
  }

  /**
   * Removes a copy of Wirescry's certificate from the device, whether this run or an earlier one
   * made it. Best effort: it's only the public certificate.
   */
  private async removeCertificateFile(id: string, serial: string): Promise<void> {
    if (!this.certificates) return;
    if (this.sent.delete(id)) this.publishDevices();
    await this.capture!.exclusive(id, () => this.certificates!.remove(serial, this.copies())).catch(
      (error: unknown) => this.options.log?.(`couldn't remove the certificate file: ${String(error)}`),
    );
  }

  /** Sets a stray 127.0.0.1 proxy back to none. */
  async clearProxy(id: string): Promise<void> {
    const target = this.target(id, 'stop');
    await this.act(id, 'stopping', () => this.capture!.clearStrayProxy(target));
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
    // No new checks from here: each would queue ahead of putting its device back.
    clearInterval(this.pollTimer);
    this.quitting = true;
    try {
      await this.capture?.stopAll((id) => {
        const device = this.current.devices.find((d) => d.id === id && d.state === 'ready');
        return device?.serial;
      }, timeoutMs);
      // Then, briefly, the copies made this run: putting devices back comes first.
      const certificates = this.certificates;
      const removals = [...this.sent].flatMap((id) => {
        const device = this.current.devices.find((d) => d.id === id && d.state === 'ready');
        if (!certificates || !device) return [];
        this.sent.delete(id);
        return [certificates.remove(device.serial, this.copies()).catch(() => undefined)];
      });
      if (removals.length)
        await Promise.race([
          Promise.all(removals),
          new Promise((resolve) => setTimeout(resolve, REMOVE_ON_QUIT_MS)),
        ]);
    } finally {
      // Still running (an update install that didn't go ahead): any device left keeps being checked.
      this.quitting = false;
      if (this.capture && !this.stopped) this.startPolling();
      this.publishDevices();
    }
  }

  private startPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.checkAll(), this.options.capture?.pollMs ?? POLL_MS);
    this.pollTimer.unref?.();
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
        // A re-read that fails (a busy device timing out) keeps what was read before: losing the
        // device's id would make a capturing device look unplugged.
        const before = this.info.get(key);
        if ('error' in result && before && !('error' in before)) {
          this.options.log?.(`couldn't read ${line.serial} again: ${result.error}`);
        } else {
          this.info.set(key, result);
        }
        this.publishDevices();
        if (this.readAgain.delete(key)) this.readInfo(line, generation, true);
      });
  }
}
