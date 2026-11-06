import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExchangeSource } from '../../shared/api';
import type { DeviceListeners } from '../device-listeners';
import { AdbError, type ReverseRule, type ShellResult } from './adb-client';
import { cleanText } from './text';

/**
 * Capturing a device: pointing its global HTTP proxy at a port on the device that `adb reverse`
 * leads back to a Wirescry listener on this computer, and putting it all back afterwards.
 *
 * Android facts (measured on the API 37 emulator, adb 1.0.41, test/fixtures/adb/reverse.json):
 * writing `settings put global http_proxy host:port` takes effect at once and fills
 * global_http_proxy_host and _port; unset keys read as an empty line (older images print null);
 * a clean device's http_proxy is ":0", which is also how it's cleared. Writing http_proxy
 * rebuilds the proxy with no exclusion list, so only a plain proxy can be put back faithfully.
 */

/** The device's proxy settings, as `settings get global` prints them. */
export interface ProxySettings {
  httpProxy: string;
  host: string;
  port: string;
  exclusions: string;
  pac: string;
}

const PROXY_KEYS: Record<keyof ProxySettings, string> = {
  httpProxy: 'http_proxy',
  host: 'global_http_proxy_host',
  port: 'global_http_proxy_port',
  exclusions: 'global_http_proxy_exclusion_list',
  pac: 'global_proxy_pac_url',
};

/** What a device's proxy settings mean for capturing it. */
export type ProxyJudgement =
  /** No proxy: capture, and Undo writes :0. */
  | { kind: 'none' }
  /** A plain host:port: ask the user before replacing it; Undo writes it back. */
  | { kind: 'plain'; value: string }
  /** 127.0.0.1:port: Wirescry (or another tool using adb reverse) left it. */
  | { kind: 'loopback'; value: string }
  /** Something that couldn't be put back as it was. */
  | { kind: 'refused'; reason: string };

const unset = (value: string): boolean => value === '' || value === 'null';
const HOST_PORT = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/;

/** A proxy value Wirescry may write back: host:port, a real port, not this device itself. */
function isPlainProxy(value: string): boolean {
  const match = HOST_PORT.exec(value);
  const port = Number(match?.[2]);
  return !!match && port >= 1 && port <= 65535 && match[1] !== '127.0.0.1' && match[1] !== 'localhost';
}

export function judgeProxy(settings: ProxySettings): ProxyJudgement {
  const { httpProxy, host, exclusions, pac } = settings;
  if (!unset(pac)) return { kind: 'refused', reason: 'It uses a proxy auto-config (PAC) file.' };
  const noHttpProxy = unset(httpProxy) || httpProxy === ':0';
  if (noHttpProxy && !unset(host)) {
    return { kind: 'refused', reason: 'Its proxy is set by device management.' };
  }
  if (!unset(exclusions)) return { kind: 'refused', reason: 'Its proxy has a list of hosts to bypass it.' };
  if (noHttpProxy) return { kind: 'none' };
  const match = HOST_PORT.exec(httpProxy);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) {
    return { kind: 'refused', reason: 'Its proxy setting is one Wirescry couldn’t put back as it was.' };
  }
  if (match[1] === '127.0.0.1' || match[1] === 'localhost') return { kind: 'loopback', value: httpProxy };
  return { kind: 'plain', value: httpProxy };
}

/**
 * What Wirescry did to a device, written before it changes anything, so a crash leaves enough to
 * undo it. One file per device identity.
 */
export interface CaptureRecord {
  version: 1;
  /** The device's identity (see devices.ts). */
  id: string;
  label: string;
  /** The plain proxy it had, to put back; null for none. */
  previousProxy: string | null;
  devicePort: number;
  hostPort: number;
  /** Whether the reverse rule was made as tcp:localhost:<port> (Android 11+). */
  loopbackOnly?: boolean;
  startedAt: string;
}

const ID = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is CaptureRecord {
  const r = value as Partial<CaptureRecord> | null;
  const port = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;
  return (
    !!r &&
    r.version === 1 &&
    typeof r.id === 'string' &&
    ID.test(r.id) &&
    typeof r.label === 'string' &&
    r.label.length <= 200 &&
    (r.previousProxy === null || (typeof r.previousProxy === 'string' && isPlainProxy(r.previousProxy))) &&
    port(r.devicePort) &&
    port(r.hostPort) &&
    (r.loopbackOnly === undefined || typeof r.loopbackOnly === 'boolean') &&
    typeof r.startedAt === 'string'
  );
}

/** Records on disk, written atomically (a temporary file, then a rename). */
export class CaptureRecords {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('Bad device id.');
    return path.join(this.dir, `${id}.json`);
  }

  async write(record: CaptureRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(record.id);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /** Every readable record. Anything else in the folder is ignored. */
  async list(): Promise<CaptureRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: CaptureRecord[] = [];
    for (const name of names.slice(0, 1000)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!ID.test(id)) continue;
      try {
        const value: unknown = JSON.parse(await readFile(path.join(this.dir, name), 'utf8'));
        if (isRecord(value) && value.id === id) records.push(value);
      } catch {
        // Unreadable: leave it for the user.
      }
    }
    return records;
  }
}

/** What capture needs from ADB, for one device by its transport serial. */
export interface CaptureIo {
  shell(serial: string, command: string): Promise<ShellResult>;
  reverse(
    serial: string,
    devicePort: number,
    hostPort: number,
    loopbackOnly: boolean,
  ): Promise<number | undefined>;
  reverseRemove(serial: string, devicePort: number, loopbackOnly: boolean): Promise<void>;
  reverseList(serial: string): Promise<ReverseRule[]>;
}

/** The device being captured, as the device list knows it now. */
export interface CaptureTarget {
  id: string;
  serial: string;
  label: string;
  /** Its Android API level, which decides how its tunnel is made. Needed to capture. */
  apiLevel?: number;
}

/**
 * From Android 11 (API 30), adbd's reverse port listens on every interface unless asked for
 * tcp:localhost:<port>; before that it listens on loopback anyway (see adbReverse).
 */
export const LOOPBACK_SPEC_FROM_API = 30;

export interface CaptureOptions {
  io: CaptureIo;
  listeners: Pick<DeviceListeners, 'open' | 'close' | 'setLocalAccess'>;
  records: CaptureRecords;
  /** 0 ≤ n < 1, for picking device ports. */
  random?: () => number;
  /** How long a written proxy setting may take to show (global_http_proxy_host is written asynchronously). */
  readBackMs?: number;
  readBackIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Device ports Wirescry picks from: high, and away from common development ports. */
const DEVICE_PORT_MIN = 20_000;
const DEVICE_PORT_MAX = 59_999;
const REVERSE_TRIES = 5;

/** Shown when a device can't be undone because it isn't connected. */
export const MANUAL_FIX = 'adb shell settings put global http_proxy :0';

/** Why the proxy setting didn't stick: some phones block settings changes over adb. */
const READ_BACK_FAILED =
  'The device didn’t keep its new proxy setting. On Xiaomi phones, turn on “USB debugging (Security settings)” in Developer options; on Samsung phones, turn off Auto Blocker.';

export class CaptureError extends Error {}

/**
 * Captures and stops devices, one operation at a time per device. Doesn't know about the device
 * list: callers pass the device's current transport serial.
 */
export class DeviceCapture {
  private readonly active = new Map<string, CaptureRecord>();
  private readonly left = new Map<string, CaptureRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CaptureOptions) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Reads records left by an earlier run: those devices were never put back. */
  async load(): Promise<void> {
    for (const record of await this.options.records.list()) {
      if (!this.active.has(record.id)) this.left.set(record.id, record);
    }
  }

  /** Capture details for a device, if it's capturing. */
  capturing(id: string): CaptureRecord | undefined {
    return this.active.get(id);
  }

  /** Whether an earlier run left this device set up. */
  isLeftover(id: string): boolean {
    return this.left.has(id);
  }

  /** Every device Wirescry has set up, capturing now or left by an earlier run. */
  setUp(): Array<{ id: string; label: string; capturing: boolean }> {
    return [
      ...[...this.active.values()].map((r) => ({ id: r.id, label: r.label, capturing: true })),
      ...[...this.left.values()].map((r) => ({ id: r.id, label: r.label, capturing: false })),
    ];
  }

  /** Every device currently capturing. */
  capturingIds(): string[] {
    return [...this.active.keys()];
  }

  private oneAtATime<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return result;
  }

  async readProxy(serial: string): Promise<ProxySettings> {
    const out = {} as ProxySettings;
    for (const [key, name] of Object.entries(PROXY_KEYS) as Array<[keyof ProxySettings, string]>) {
      const result = await this.options.io.shell(serial, `settings get global ${name}`);
      if (result.exitCode !== 0)
        throw new CaptureError(`Couldn’t read the device’s proxy settings (${name}).`);
      out[key] = result.stdout.trim().slice(0, 300);
    }
    return out;
  }

  private async writeProxy(serial: string, value: string): Promise<void> {
    const result = await this.options.io.shell(serial, `settings put global http_proxy ${value}`);
    if (result.exitCode !== 0) {
      throw new CaptureError(
        `The device refused the proxy setting: ${cleanText(result.stderr, 200) ?? `exit code ${result.exitCode}`}`,
      );
    }
  }

  /** Waits until the device reports `value` (and, unless clearing, 127.0.0.1 as the host). */
  private async readBack(serial: string, value: string): Promise<boolean> {
    const deadline = Date.now() + (this.options.readBackMs ?? 2000);
    for (;;) {
      const now = await this.readProxy(serial);
      const cleared = value === ':0' && (now.httpProxy === ':0' || unset(now.httpProxy));
      const hostOk = value === ':0' ? unset(now.host) : now.host === value.slice(0, value.lastIndexOf(':'));
      if ((now.httpProxy === value || cleared) && hostOk) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(this.options.readBackIntervalMs ?? 250);
    }
  }

  private pickPort(taken: ReadonlySet<number>): number {
    for (let i = 0; i < 100; i++) {
      const port = DEVICE_PORT_MIN + Math.floor(this.random() * (DEVICE_PORT_MAX - DEVICE_PORT_MIN + 1));
      if (!taken.has(port)) return port;
    }
    throw new CaptureError('Couldn’t find a free port on the device.');
  }

  /**
   * Routes the device's traffic through Wirescry. If it already uses another plain proxy and
   * `replaceProxy` isn't that proxy, changes nothing and returns it for the user to confirm.
   */
  capture(target: CaptureTarget, replaceProxy?: string): Promise<{ needsConfirmation?: string }> {
    return this.oneAtATime(target.id, () => this.doCapture(target, replaceProxy));
  }

  private async doCapture(
    target: CaptureTarget,
    replaceProxy: string | undefined,
  ): Promise<{ needsConfirmation?: string }> {
    const { io, listeners, records } = this.options;
    if (this.active.has(target.id)) return {};
    if (this.left.has(target.id)) {
      throw new CaptureError('Wirescry left this device set up last time. Restore it first.');
    }
    const judged = judgeProxy(await this.readProxy(target.serial));
    if (judged.kind === 'refused')
      throw new CaptureError(`Wirescry can’t capture this device. ${judged.reason}`);
    if (judged.kind === 'loopback') {
      throw new CaptureError(
        `Its proxy is ${judged.value}, probably left by Wirescry or another tool. Clear it first.`,
      );
    }
    // Only the proxy the user agreed to replace: if it has changed since, ask again.
    if (judged.kind === 'plain' && replaceProxy !== judged.value) return { needsConfirmation: judged.value };
    const previousProxy = judged.kind === 'plain' ? judged.value : null;
    if (target.apiLevel === undefined) {
      throw new CaptureError(
        'Wirescry couldn’t read this device’s Android version, so it can’t set up its tunnel safely.',
      );
    }
    const loopbackOnly = target.apiLevel >= LOOPBACK_SPEC_FROM_API;

    const source: ExchangeSource = { kind: 'android', id: target.id, label: target.label };
    const { port: hostPort } = await listeners.open(source);
    const record: CaptureRecord = {
      version: 1,
      id: target.id,
      label: target.label.slice(0, 200),
      previousProxy,
      devicePort: 0,
      hostPort,
      loopbackOnly,
      startedAt: new Date().toISOString(),
    };
    let wroteRecord = false;
    let reversed = false;
    let wroteProxy = false;
    try {
      // Never touch rules Wirescry didn't make (a developer's own adb reverse stays theirs).
      const taken = new Set(
        (await io.reverseList(target.serial)).flatMap((r) => {
          const port = /^tcp:(\d+)$/.exec(r.device)?.[1];
          return port ? [Number(port)] : [];
        }),
      );
      record.devicePort = this.pickPort(taken);
      // The record comes before any change to the device.
      await records.write(record);
      wroteRecord = true;
      for (let attempt = 1; ; attempt++) {
        try {
          const reported = await io.reverse(target.serial, record.devicePort, hostPort, loopbackOnly);
          reversed = true;
          // A device too old for the localhost form would listen on another port: don't use it.
          if (loopbackOnly && reported !== record.devicePort) {
            // Undo that rule, wherever it is (the outer cleanup only knows the port asked for).
            reversed = false;
            if (reported !== undefined)
              await io.reverseRemove(target.serial, reported, false).catch(() => undefined);
            throw new CaptureError(
              `The device made its tunnel on port ${String(reported)} instead of ${record.devicePort}, so Wirescry undid it.`,
            );
          }
          break;
        } catch (error) {
          // "cannot rebind" for tcp:N; adbd answers "cannot bind listener" for a localhost rule.
          const rebind =
            !reversed &&
            error instanceof AdbError &&
            /cannot rebind|cannot bind listener/i.test(error.serverMessage ?? '');
          if (!rebind || attempt >= REVERSE_TRIES) throw error;
          taken.add(record.devicePort);
          record.devicePort = this.pickPort(taken);
          await records.write(record);
        }
      }
      const value = `127.0.0.1:${record.devicePort}`;
      wroteProxy = true;
      await this.writeProxy(target.serial, value);
      if (!(await this.readBack(target.serial, value))) throw new CaptureError(READ_BACK_FAILED);
      this.active.set(target.id, record);
      return {};
    } catch (error) {
      // Put back whatever was changed, newest first, and say what failed.
      if (wroteProxy) {
        const putBack = await this.putBackProxy(target.serial, record).then(
          () => true,
          () => false,
        );
        if (!putBack) {
          // The device may still point at the tunnel: keep it all (record, rule, listener) so it
          // keeps working and can be stopped, rather than leave it on a dead proxy no one knows of.
          this.active.set(target.id, record);
          throw new CaptureError(
            `${(error as Error).message} Wirescry couldn’t put its proxy back, so it’s left capturing: try Stop. If the device has no internet, run: ${MANUAL_FIX}`,
          );
        }
      }
      if (reversed)
        await io.reverseRemove(target.serial, record.devicePort, loopbackOnly).catch(() => undefined);
      if (wroteRecord) await records.remove(target.id).catch(() => undefined);
      await listeners.close(target.id).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Writes back the previous proxy if the device still has Wirescry's. 'back' if it's as it was
   * (already, or now); 'changed' if something else set it since, and it was left alone.
   */
  private async putBackProxy(serial: string, record: CaptureRecord): Promise<'back' | 'changed'> {
    const now = await this.readProxy(serial);
    const previous = record.previousProxy ?? ':0';
    if (
      now.httpProxy !== `127.0.0.1:${record.devicePort}` ||
      (!unset(now.host) && now.host !== '127.0.0.1')
    ) {
      // Already as it was (Wirescry stopped before writing it, or a Stop is being retried)?
      const already =
        previous === ':0'
          ? (now.httpProxy === ':0' || unset(now.httpProxy)) && unset(now.host)
          : now.httpProxy === previous;
      return already ? 'back' : 'changed';
    }
    await this.writeProxy(serial, previous);
    if (!(await this.readBack(serial, previous))) {
      throw new CaptureError(`The device didn’t take back its proxy setting. Run: ${MANUAL_FIX}`);
    }
    return 'back';
  }

  /**
   * Puts the device back: its proxy (only if it's still Wirescry's), Wirescry's reverse rule, the
   * record, the listener. Works for a capture left by an earlier run too (Restore). Returns a note
   * for the user if something was left as it was.
   */
  stop(target: CaptureTarget): Promise<{ note?: string }> {
    return this.oneAtATime(target.id, () => this.doStop(target));
  }

  private async doStop(target: CaptureTarget): Promise<{ note?: string }> {
    const { io, listeners, records } = this.options;
    const record = this.active.get(target.id) ?? this.left.get(target.id);
    if (!record) return {};
    let note: string | undefined;
    if ((await this.putBackProxy(target.serial, record)) === 'changed') {
      note = 'Its proxy setting had been changed since capture started, so Wirescry left it as it is.';
    }
    const ours = (await io.reverseList(target.serial)).some(
      (r) => r.device === `tcp:${record.devicePort}` && r.host === `tcp:${record.hostPort}`,
    );
    if (ours) await io.reverseRemove(target.serial, record.devicePort, record.loopbackOnly === true);
    await records.remove(target.id);
    this.active.delete(target.id);
    this.left.delete(target.id);
    await listeners.close(target.id);
    // The switch starts off again next time.
    listeners.setLocalAccess(target.id, false);
    return note ? { note } : {};
  }

  /**
   * The device's listener moved to `hostPort` (e.g. its port was taken during a certificate
   * reset), or couldn't restart at all (undefined): points the device's tunnel at the new port,
   * or puts the device back, since its tunnel now leads nowhere.
   */
  listenerMoved(target: CaptureTarget, hostPort: number | undefined): Promise<void> {
    return this.oneAtATime(target.id, async () => {
      const record = this.active.get(target.id);
      if (!record) return;
      if (hostPort === undefined) {
        await this.doStop(target);
        return;
      }
      const { io, records } = this.options;
      const ours = (await io.reverseList(target.serial)).some(
        (r) => r.device === `tcp:${record.devicePort}` && r.host === `tcp:${record.hostPort}`,
      );
      if (ours) await io.reverseRemove(target.serial, record.devicePort, record.loopbackOnly === true);
      record.hostPort = hostPort;
      // A record from before loopback-only rules: remake it the safe way if the device allows.
      record.loopbackOnly = record.loopbackOnly ?? (target.apiLevel ?? 0) >= LOOPBACK_SPEC_FROM_API;
      await records.write(record);
      await io.reverse(target.serial, record.devicePort, hostPort, record.loopbackOnly);
    });
  }

  /** Sets the proxy to none, for a 127.0.0.1 proxy that Wirescry has no record of. */
  clearStrayProxy(target: CaptureTarget): Promise<void> {
    return this.oneAtATime(target.id, async () => {
      if (this.active.has(target.id) || this.left.has(target.id)) {
        throw new CaptureError('Wirescry set this device up: use Stop or Restore instead.');
      }
      const judged = judgeProxy(await this.readProxy(target.serial));
      if (judged.kind !== 'loopback')
        throw new CaptureError('Its proxy doesn’t point at 127.0.0.1 any more.');
      await this.writeProxy(target.serial, ':0');
      if (!(await this.readBack(target.serial, ':0'))) {
        throw new CaptureError(`The device didn’t clear its proxy. Run: ${MANUAL_FIX}`);
      }
    });
  }

  /**
   * Stops every capturing device it can reach within `timeoutMs` (quitting). `serialOf` gives a
   * device's current transport, if it's connected. Devices it can't put back keep their records.
   */
  async stopAll(serialOf: (id: string) => string | undefined, timeoutMs: number): Promise<void> {
    const work = async (): Promise<void> => {
      // A capture still in progress finishes first, so it's put back too.
      await Promise.all([...this.queues.values()]);
      await Promise.all(
        [...this.active.values()].map(async (record) => {
          const serial = serialOf(record.id);
          if (!serial) return;
          await this.stop({ id: record.id, serial, label: record.label }).catch(() => undefined);
        }),
      );
    };
    await Promise.race([work(), this.sleep(timeoutMs)]);
  }
}
