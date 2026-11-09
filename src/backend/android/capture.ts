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
  /**
   * Device ports the device's proxy may still point at while Wirescry moves it to `devicePort`
   * (its old port was taken): they count as Wirescry's until the move is done.
   */
  formerPorts?: number[];
  /** An emulator, which can be closed and reopened from a saved state. */
  emulator?: boolean;
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
    (r.formerPorts === undefined ||
      (Array.isArray(r.formerPorts) && r.formerPorts.length <= 10 && r.formerPorts.every(port))) &&
    (r.emulator === undefined || typeof r.emulator === 'boolean') &&
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
  emulator?: boolean;
}

/** The device ports a record's proxy may point at: its own, and any it's moving from. */
const recordPorts = (record: CaptureRecord): number[] => [record.devicePort, ...(record.formerPorts ?? [])];

/** Whether the device's http_proxy is one Wirescry set for this record. */
const isOurProxy = (record: CaptureRecord, httpProxy: string): boolean =>
  recordPorts(record).some((port) => httpProxy === `127.0.0.1:${port}`);

/** Device ports that reverse rules use. */
const portsOf = (rules: ReverseRule[]): Set<number> =>
  new Set(
    rules.flatMap((r) => {
      const port = /^tcp:(\d+)$/.exec(r.device)?.[1];
      return port ? [Number(port)] : [];
    }),
  );

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

/** Said when a device's proxy changed under a running capture. */
export const PROXY_CHANGED =
  'Its proxy setting was changed by something else, so Wirescry stopped capturing it and left the setting as it is.';

/** Whether a reverse request failed because the device port is taken. */
const portTaken = (error: unknown): boolean =>
  // "cannot rebind" for tcp:N; adbd answers "cannot bind listener" for a localhost rule.
  error instanceof AdbError && /cannot rebind|cannot bind listener/i.test(error.serverMessage ?? '');

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
  setUp(): Array<{ id: string; label: string; capturing: boolean; emulator?: boolean }> {
    const entry = (r: CaptureRecord, capturing: boolean) => ({
      id: r.id,
      label: r.label,
      capturing,
      ...(r.emulator ? { emulator: true } : {}),
    });
    return [
      ...[...this.active.values()].map((r) => entry(r, true)),
      ...[...this.left.values()].map((r) => entry(r, false)),
    ];
  }

  /**
   * Forgets a device an earlier run left set up, without touching it (it isn't connected). If it
   * comes back still pointing at 127.0.0.1, Setup offers Clear proxy for it, as for any stray proxy.
   */
  async forget(id: string): Promise<void> {
    if (!this.left.has(id)) throw new Error('Wirescry has nothing to forget for that device.');
    await this.options.records.remove(id);
    this.left.delete(id);
  }

  /** Every device currently capturing. */
  capturingIds(): string[] {
    return [...this.active.keys()];
  }

  /** Runs `task` for this device one at a time with capturing, checking and stopping it. */
  exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    return this.oneAtATime(id, task);
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
      out[key] = await this.readSetting(serial, name);
    }
    return out;
  }

  private async readSetting(serial: string, name: string): Promise<string> {
    const result = await this.options.io.shell(serial, `settings get global ${name}`);
    if (result.exitCode !== 0) throw new CaptureError(`Couldn’t read the device’s proxy settings (${name}).`);
    return result.stdout.trim().slice(0, 300);
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
      ...(target.emulator ? { emulator: true } : {}),
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
      const taken = portsOf(await io.reverseList(target.serial));
      record.devicePort = this.pickPort(taken);
      // The record comes before any change to the device.
      await records.write(record);
      wroteRecord = true;
      await this.addTunnel(target.serial, record, taken);
      reversed = true;
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
   * Adds the record's reverse rule, moving to another device port (and writing the record)
   * while the port is taken. `taken` holds ports known to be in use, and grows. `former` is a
   * port the device's proxy may point at now: kept in the record if the port moves.
   */
  private async addTunnel(
    serial: string,
    record: CaptureRecord,
    taken: Set<number>,
    former?: number,
  ): Promise<void> {
    const { io, records } = this.options;
    const loopbackOnly = record.loopbackOnly === true;
    const move = async (): Promise<void> => {
      taken.add(record.devicePort);
      if (former !== undefined && !record.formerPorts?.includes(former)) {
        record.formerPorts = [...(record.formerPorts ?? []), former].slice(-10);
      }
      record.devicePort = this.pickPort(taken);
      await records.write(record);
    };
    if (taken.has(record.devicePort)) await move();
    for (let attempt = 1; ; attempt++) {
      let reported: number | undefined;
      try {
        reported = await io.reverse(serial, record.devicePort, record.hostPort, loopbackOnly);
      } catch (error) {
        if (!portTaken(error) || attempt >= REVERSE_TRIES) throw error;
        await move();
        continue;
      }
      // A device too old for the localhost form would listen on another port: don't use it.
      if (loopbackOnly && reported !== record.devicePort) {
        if (reported !== undefined) await io.reverseRemove(serial, reported, false).catch(() => undefined);
        throw new CaptureError(
          `The device made its tunnel on port ${String(reported)} instead of ${record.devicePort}, so Wirescry undid it.`,
        );
      }
      return;
    }
  }

  /**
   * Makes sure a capturing device's tunnel and proxy are still in place, fixing what it can: a
   * reverse rule lost to a reconnect, an ADB server restart or another tool is added again (on
   * another port if its own was taken, the proxy following). If something else changed the
   * device's proxy, capture stops for that device and the setting is left as it is.
   * Returns `stopped` with a note when that happens, and `changed` when anything was rewritten.
   */
  check(target: CaptureTarget): Promise<{ stopped?: string; changed?: boolean }> {
    return this.oneAtATime(target.id, () => this.doCheck(target));
  }

  private async doCheck(target: CaptureTarget): Promise<{ stopped?: string; changed?: boolean }> {
    const record = this.active.get(target.id);
    if (!record) return {};
    const proxy = await this.readSetting(target.serial, 'http_proxy');
    if (!isOurProxy(record, proxy)) {
      await this.drop(target, record);
      return { stopped: PROXY_CHANGED };
    }
    return (await this.ensureTunnel(target, record, proxy)) ? { changed: true } : {};
  }

  /** Puts the rule and proxy back in place for an active record; true if anything changed. */
  private async ensureTunnel(target: CaptureTarget, record: CaptureRecord, proxy: string): Promise<boolean> {
    const { io, records } = this.options;
    const rules = await io.reverseList(target.serial);
    const has = (port: number) =>
      rules.some((r) => r.device === `tcp:${port}` && r.host === `tcp:${record.hostPort}`);
    let changed = false;
    if (!has(record.devicePort)) {
      // A rule on our port to somewhere else isn't ours: it counts as taken.
      const taken = portsOf(rules);
      const pointedAt = /^127\.0\.0\.1:(\d+)$/.exec(proxy)?.[1];
      await this.addTunnel(target.serial, record, taken, pointedAt ? Number(pointedAt) : undefined);
      changed = true;
    }
    const value = `127.0.0.1:${record.devicePort}`;
    if (proxy !== value) {
      await this.writeProxy(target.serial, value);
      if (!(await this.readBack(target.serial, value))) throw new CaptureError(READ_BACK_FAILED);
      changed = true;
    }
    if (record.formerPorts?.length) {
      // The move is done: the old ports' rules (if any are left) go, then the record says so.
      for (const port of record.formerPorts) {
        if (has(port))
          await io.reverseRemove(target.serial, port, record.loopbackOnly === true).catch(() => undefined);
      }
      delete record.formerPorts;
      await records.write(record);
      changed = true;
    }
    return changed;
  }

  /**
   * Captures again a device an earlier run left set up (Wirescry crashed or was forced to quit),
   * as long as its proxy still points where Wirescry set it. The listener reuses its old port on
   * this computer if it's free.
   */
  resume(target: CaptureTarget): Promise<void> {
    return this.oneAtATime(target.id, () => this.doResume(target));
  }

  private async doResume(target: CaptureTarget): Promise<void> {
    const { io, listeners, records } = this.options;
    const record = this.left.get(target.id);
    if (!record) throw new CaptureError('Wirescry has nothing to resume on this device.');
    const proxy = await this.readSetting(target.serial, 'http_proxy');
    if (!isOurProxy(record, proxy)) {
      throw new CaptureError('Its proxy setting has changed since Wirescry set it up. Use Restore instead.');
    }
    const source: ExchangeSource = { kind: 'android', id: target.id, label: record.label };
    const { port } = await listeners.open(source, record.hostPort);
    try {
      // A rule the earlier run made, to its listener's old port, still there if the device
      // stayed connected: remove it, so the rule is made afresh to the listener now running.
      if (record.loopbackOnly === undefined && target.apiLevel === undefined) {
        throw new CaptureError(
          'Wirescry couldn’t read this device’s Android version, so it can’t set up its tunnel safely. Use Restore instead.',
        );
      }
      const loopbackOnly = record.loopbackOnly ?? (target.apiLevel ?? 0) >= LOOPBACK_SPEC_FROM_API;
      if (port !== record.hostPort) {
        for (const r of await io.reverseList(target.serial)) {
          const devicePort = Number(/^tcp:(\d+)$/.exec(r.device)?.[1]);
          if (recordPorts(record).includes(devicePort) && r.host === `tcp:${record.hostPort}`) {
            await io.reverseRemove(target.serial, devicePort, loopbackOnly).catch(() => undefined);
          }
        }
      }
      record.hostPort = port;
      record.loopbackOnly = loopbackOnly;
      if (target.emulator) record.emulator = true;
      await records.write(record);
      this.left.delete(target.id);
      this.active.set(target.id, record);
      await this.ensureTunnel(target, record, proxy);
    } catch (error) {
      // Still left over: Restore (or Resume again) works from the record as written.
      this.active.delete(target.id);
      this.left.set(target.id, record);
      await listeners.close(target.id).catch(() => undefined);
      throw error;
    }
  }

  /** Forgets a device's capture: Wirescry's rules, the record, the listener. Not its proxy. */
  private async drop(target: CaptureTarget, record: CaptureRecord): Promise<void> {
    const { io, listeners, records } = this.options;
    const rules = await io.reverseList(target.serial);
    for (const port of recordPorts(record)) {
      const ours = rules.some((r) => r.device === `tcp:${port}` && r.host === `tcp:${record.hostPort}`);
      // Best effort: the proxy no longer points at the rule, and a rule left behind leads only to a
      // closed listener (it goes when the device disconnects).
      if (ours)
        await io.reverseRemove(target.serial, port, record.loopbackOnly === true).catch(() => undefined);
    }
    await records.remove(target.id);
    this.active.delete(target.id);
    this.left.delete(target.id);
    await listeners.close(target.id);
    // The switch starts off again next time.
    listeners.setLocalAccess(target.id, false);
  }

  /**
   * Writes back the previous proxy if the device still has Wirescry's. 'back' if it's as it was
   * (already, or now); 'changed' if something else set it since, and it was left alone.
   */
  private async putBackProxy(serial: string, record: CaptureRecord): Promise<'back' | 'changed'> {
    const now = await this.readProxy(serial);
    const previous = record.previousProxy ?? ':0';
    if (!isOurProxy(record, now.httpProxy) || (!unset(now.host) && now.host !== '127.0.0.1')) {
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
    const record = this.active.get(target.id) ?? this.left.get(target.id);
    if (!record) return {};
    let note: string | undefined;
    if ((await this.putBackProxy(target.serial, record)) === 'changed') {
      note = 'Its proxy setting had been changed since capture started, so Wirescry left it as it is.';
    }
    await this.drop(target, record);
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
    // Each device on its own: one that hangs (a Wi-Fi phone whose link died, mid-check) mustn't
    // hold up the rest. A capture still in progress finishes first, so it's put back too.
    const ids = new Set([...this.queues.keys(), ...this.active.keys()]);
    const work = Promise.all(
      [...ids].map(async (id) => {
        await this.queues.get(id);
        const record = this.active.get(id);
        const serial = record && serialOf(id);
        if (!record || !serial) return;
        await this.stop({ id, serial, label: record.label }).catch(() => undefined);
      }),
    );
    await Promise.race([work, this.sleep(timeoutMs)]);
  }
}
