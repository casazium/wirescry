import net from 'node:net';
import { cleanText } from './text';

/**
 * A small client for the ADB server's host protocol (the user's own server, usually on
 * 127.0.0.1:5037): only the requests Wirescry needs. Written from AOSP's documentation
 * (packages/modules/adb: OVERVIEW.TXT, SERVICES.TXT, the shell protocol) and checked against
 * bytes recorded from a real server and Google's adb client (test/fixtures/adb).
 *
 * Whatever comes back is untrusted: any local process could listen on the port when no ADB
 * server runs. Lengths are bounded, waits time out, and device strings are capped by callers.
 */

/** Where the ADB server listens. */
export interface AdbEndpoint {
  host: string;
  port: number;
}

/** An answer from the server that isn't what the protocol allows, or a FAIL with its message. */
export class AdbError extends Error {
  constructor(
    message: string,
    /** The server's own FAIL message, when it sent one. */
    readonly serverMessage?: string,
  ) {
    super(message);
    this.name = 'AdbError';
  }
}

export const DEFAULT_ADB_PORT = 5037;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The server's address, the way adb finds it (AOSP client/main.cpp): ADB_SERVER_SOCKET
 * (`tcp:host:port` or `tcp:port`), else ANDROID_ADB_SERVER_ADDRESS and ANDROID_ADB_SERVER_PORT,
 * else 127.0.0.1:5037. Only a server on this computer is used: device commands and their output
 * shouldn't go over a network.
 */
export function adbEndpoint(env: NodeJS.ProcessEnv = process.env): AdbEndpoint {
  const socket = env.ADB_SERVER_SOCKET?.trim();
  if (socket) {
    const match = /^tcp:(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/.exec(socket);
    if (!match)
      throw new AdbError(
        `ADB_SERVER_SOCKET is "${socket}", which Wirescry can't use: only tcp:host:port is supported.`,
      );
    const host = match[1] ?? '127.0.0.1';
    const port = Number(match[2]);
    if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
      throw new AdbError(
        `ADB_SERVER_SOCKET points at ${host}. Wirescry only uses an ADB server on this computer.`,
      );
    }
    if (port < 1 || port > 65535) throw new AdbError(`ADB_SERVER_SOCKET has an invalid port, ${match[2]}.`);
    return { host: host.replace(/^\[|\]$/g, ''), port };
  }
  const address = env.ANDROID_ADB_SERVER_ADDRESS?.trim();
  if (address && !LOOPBACK_HOSTS.has(address.toLowerCase())) {
    throw new AdbError(
      `ANDROID_ADB_SERVER_ADDRESS is ${address}. Wirescry only uses an ADB server on this computer.`,
    );
  }
  const host = address ? address.replace(/^\[|\]$/g, '') : '127.0.0.1';
  const portText = env.ANDROID_ADB_SERVER_PORT?.trim();
  if (portText) {
    const port = Number(portText);
    if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
      throw new AdbError(`ANDROID_ADB_SERVER_PORT is "${portText}", which isn't a port.`);
    }
    return { host, port };
  }
  return { host, port: DEFAULT_ADB_PORT };
}

export interface AdbOptions {
  /** How long to wait for each answer. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * One connection to the server, read in exact amounts however the bytes arrive. Any wait
 * longer than the timeout, or the server hanging up early, ends it with an error.
 */
export class AdbConnection {
  private buffered: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  /** When the whole exchange must be over, however the server paces its bytes. */
  private overallDeadline = Infinity;

  private constructor(
    private readonly socket: net.Socket,
    private timeoutMs: number,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
      this.wake?.();
    });
    socket.on('end', () => {
      this.ended = true;
      this.wake?.();
    });
    socket.on('error', (error) => {
      this.failure = error;
      this.wake?.();
    });
    socket.on('close', () => {
      this.ended = true;
      this.wake?.();
    });
  }

  static open(endpoint: AdbEndpoint, options: AdbOptions = {}): Promise<AdbConnection> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: endpoint.host, port: endpoint.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          Object.assign(new AdbError('The ADB server took too long to accept the connection.'), {
            code: 'ETIMEDOUT',
          }),
        );
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new AdbConnection(socket, timeoutMs));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Sends a request: its length as 4 hex digits, then the request. */
  send(request: string): void {
    const body = Buffer.from(request, 'utf8');
    if (body.length > 0xffff) throw new AdbError('ADB request too long.');
    this.socket.write(Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0')), body]));
  }

  /** Writes raw bytes, e.g. a shell packet. */
  write(data: Buffer): void {
    this.socket.write(data);
  }

  /** Reads exactly `n` bytes. With `orEnd`, a clean end before any byte returns undefined. */
  async read(n: number, orEnd = false): Promise<Buffer | undefined> {
    const deadline = Math.min(Date.now() + this.timeoutMs, this.overallDeadline);
    while (this.buffered.length < n) {
      if (this.failure) throw this.failure;
      if (this.ended) {
        if (orEnd && this.buffered.length === 0) return undefined;
        throw new AdbError('The ADB server closed the connection part way through an answer.');
      }
      const left = deadline - Date.now();
      if (left <= 0)
        throw Object.assign(new AdbError('The ADB server took too long to answer.'), { code: 'ETIMEDOUT' });
      await new Promise<void>((resolve) => {
        const timer = Number.isFinite(left) ? setTimeout(resolve, left) : undefined;
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return out;
  }

  /** Reads a length-prefixed string (4 hex digits, then that many bytes). */
  async readString(orEnd = false): Promise<string | undefined> {
    const head = await this.read(4, orEnd);
    if (!head) return undefined;
    const text = head.toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(text))
      throw new AdbError(`The ADB server sent a bad length, "${printable(text)}".`);
    return (await this.read(parseInt(text, 16)))!.toString('utf8');
  }

  /** Reads OKAY, or throws the FAIL message. */
  async expectOkay(): Promise<void> {
    const status = (await this.read(4))!.toString('latin1');
    if (status === 'OKAY') return;
    if (status === 'FAIL') {
      const message = cleanText(await this.readString(), 300) ?? 'no reason given';
      throw new AdbError(`ADB: ${message}`, message);
    }
    throw new AdbError(
      `The ADB server sent "${printable(status)}" instead of OKAY or FAIL. Is something else listening on its port?`,
    );
  }

  /** Ends the exchange `ms` from now at the latest, even if bytes keep trickling in. */
  limitTotal(ms: number): void {
    this.overallDeadline = Date.now() + ms;
  }

  /** From now on, waits as long as it takes: for answers that come when something happens. */
  untimed(): void {
    this.timeoutMs = Infinity;
  }

  close(): void {
    this.socket.destroy();
  }

  /** Whether the server has closed its end. */
  get closed(): boolean {
    return this.ended || this.failure !== undefined;
  }
}

/** A string with control characters shown as escapes, for error messages. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Opens a connection, sends one host request, and checks for OKAY. */
async function request(endpoint: AdbEndpoint, service: string, options?: AdbOptions): Promise<AdbConnection> {
  const connection = await AdbConnection.open(endpoint, options);
  try {
    connection.send(service);
    await connection.expectOkay();
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** The server's protocol version (41 for adb 1.0.41). */
export async function adbServerVersion(endpoint: AdbEndpoint, options?: AdbOptions): Promise<number> {
  const connection = await request(endpoint, 'host:version', options);
  try {
    const text = (await connection.readString())!;
    if (!/^[0-9a-fA-F]{1,8}$/.test(text))
      throw new AdbError(`The ADB server sent a bad version, "${printable(text)}".`);
    return parseInt(text, 16);
  } finally {
    connection.close();
  }
}

/** A device as host:devices-l and host:track-devices-l list it. */
export interface AdbDeviceLine {
  /** The transport serial, e.g. emulator-5554 or 192.168.1.5:5555. Reused, so only for this session. */
  serial: string;
  /** device, offline, unauthorized, authorizing, connecting, recovery, sideload, bootloader, "no permissions", … */
  state: string;
  /** Extra fields, e.g. product, model, device, transport_id, usb. */
  fields: Record<string, string>;
}

const MAX_DEVICES = 64;
const MAX_FIELD = 200;

/**
 * Parses a device list: one device per line, "serial<whitespace>state", then key:value fields.
 * The state can contain spaces ("no permissions (…); see [http://…]"), so it's everything up to
 * the first key:value field.
 */
export function parseDeviceList(text: string): AdbDeviceLine[] {
  const devices: AdbDeviceLine[] = [];
  for (const line of text.split('\n')) {
    if (devices.length >= MAX_DEVICES) break;
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    const match = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const serial = match[1]!.slice(0, MAX_FIELD);
    // adb serials are printable ASCII; anything else, or a serial listed twice, isn't believed.
    if (!/^[\x21-\x7e]+$/.test(serial) || devices.some((d) => d.serial === serial)) continue;
    const words = match[2]!.split(/\s+/);
    const fields: Record<string, string> = {};
    const stateWords: string[] = [];
    for (const word of words) {
      const field = /^([a-z_]+):(.*)$/.exec(word);
      // A field once any have started; before that, part of the state (whose links contain "http:").
      if (
        field &&
        (Object.keys(fields).length > 0 ||
          ['product', 'model', 'device', 'transport_id', 'usb', 'features'].includes(field[1]!))
      ) {
        fields[field[1]!] = field[2]!.slice(0, MAX_FIELD);
      } else if (Object.keys(fields).length === 0) {
        stateWords.push(word);
      }
    }
    devices.push({ serial, state: cleanText(stateWords.join(' '), MAX_FIELD) ?? '', fields });
  }
  return devices;
}

export interface DeviceTracker {
  close(): void;
}

/**
 * Follows the server's device list (host:track-devices-l): `onList` gets the whole list at once
 * and after every change. `onEnd` is called once when the connection ends, with the error if
 * there was one (e.g. the server was restarted); call again to reconnect.
 */
export function trackDevices(
  endpoint: AdbEndpoint,
  onList: (devices: AdbDeviceLine[]) => void,
  onEnd: (error?: Error) => void,
  options?: AdbOptions,
): DeviceTracker {
  let connection: AdbConnection | undefined;
  let closed = false;
  void (async () => {
    try {
      connection = await AdbConnection.open(endpoint, { timeoutMs: options?.timeoutMs });
      if (closed) return connection.close();
      connection.send('host:track-devices-l');
      await connection.expectOkay();
      // Updates come whenever devices change, so wait for them without a deadline.
      connection.untimed();
      for (;;) {
        const list = await connection.readString(true);
        if (list === undefined) throw new AdbError('The ADB server stopped sending device updates.');
        if (!closed) onList(parseDeviceList(list));
      }
    } catch (error) {
      connection?.close();
      if (!closed) onEnd(error as Error);
    }
  })();
  return {
    close() {
      closed = true;
      connection?.close();
    },
  };
}

/** What a shell command printed and how it exited. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Shell protocol packet ids (AOSP shell_protocol.h; measured: stdout 1, stderr 2, exit 3, close stdin 4). */
const SHELL_STDOUT = 1;
const SHELL_STDERR = 2;
const SHELL_EXIT = 3;
const SHELL_CLOSE_STDIN = 4;
const MAX_SHELL_OUTPUT = 1024 * 1024;
const MAX_SHELL_PACKETS = 10_000;
/** A shell command may take this many answer timeouts in all. */
const SHELL_TOTAL_TIMEOUT_FACTOR = 2;

/**
 * Commands Wirescry runs are fixed strings it builds itself; this stops anything else (a device
 * string, say) reaching the device's shell. The device runs the command with sh.
 */
const SAFE_COMMAND = /^[A-Za-z0-9_.:/=,@+ -]+$/;

/**
 * Runs a command on a device with the shell protocol (shell,v2: Android 7+), with stdin closed.
 * `serial` is the transport serial from the device list.
 */
export async function adbShell(
  endpoint: AdbEndpoint,
  serial: string,
  command: string,
  options?: AdbOptions,
): Promise<ShellResult> {
  if (!SAFE_COMMAND.test(command))
    throw new AdbError(`Refusing to run "${printable(command)}" on the device.`);
  if (!/^[\x21-\x7e]+$/.test(serial)) throw new AdbError('Bad device serial.');
  const connection = await request(endpoint, `host:tport:serial:${serial}`, options);
  try {
    // A server dripping empty packets mustn't keep this going: the whole command has a limit.
    connection.limitTotal(SHELL_TOTAL_TIMEOUT_FACTOR * (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    // host:tport answers OKAY and the transport's id, 8 bytes, little-endian.
    await connection.read(8);
    connection.send(`shell,v2,raw:${command}`);
    await connection.expectOkay();
    connection.write(Buffer.from([SHELL_CLOSE_STDIN, 0, 0, 0, 0]));
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    for (let packets = 0; ; packets++) {
      if (packets > MAX_SHELL_PACKETS)
        throw new AdbError('The device sent more packets than Wirescry reads.');
      const head = await connection.read(5);
      const id = head![0]!;
      const length = head!.readUInt32LE(1);
      size += length;
      if (size > MAX_SHELL_OUTPUT) throw new AdbError('The device sent more output than Wirescry reads.');
      const data = (await connection.read(length))!;
      if (id === SHELL_STDOUT) out.push(data);
      else if (id === SHELL_STDERR) err.push(data);
      else if (id === SHELL_EXIT) {
        if (length !== 1) throw new AdbError('The device sent a bad exit status.');
        return {
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: data[0]!,
        };
      }
      // Other packets (e.g. window size) are ignored.
    }
  } finally {
    connection.close();
  }
}

/** The features a device's adbd supports, e.g. shell_v2. */
export async function adbFeatures(
  endpoint: AdbEndpoint,
  serial: string,
  options?: AdbOptions,
): Promise<string[]> {
  if (!/^[\x21-\x7e]+$/.test(serial)) throw new AdbError('Bad device serial.');
  const connection = await request(endpoint, `host-serial:${serial}:features`, options);
  try {
    return (await connection.readString())!
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 200);
  } finally {
    connection.close();
  }
}

/** A port Wirescry names in a reverse request. Anything else is refused before sending. */
function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AdbError(`Bad port ${String(port)}.`);
}

/**
 * Opens a device service (`host:tport:serial:` then the service) and checks the server's OKAY.
 * The connection is the caller's to close.
 */
async function deviceService(
  endpoint: AdbEndpoint,
  serial: string,
  service: string,
  options?: AdbOptions,
): Promise<AdbConnection> {
  if (!/^[\x21-\x7e]+$/.test(serial)) throw new AdbError('Bad device serial.');
  const connection = await request(endpoint, `host:tport:serial:${serial}`, options);
  try {
    connection.limitTotal(SHELL_TOTAL_TIMEOUT_FACTOR * (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    await connection.read(8);
    connection.send(service);
    await connection.expectOkay();
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** A reverse rule: a port on the device that leads to one on this computer. */
export interface ReverseRule {
  /** The device side, e.g. tcp:43210. */
  device: string;
  /** This computer's side, e.g. tcp:8001. */
  host: string;
}

/**
 * Adds a reverse rule, refusing to replace an existing one for that device port (norebind).
 * Only the documented request forms are sent: the server ends itself (LOG(FATAL)) on a reverse
 * request it can't parse (AOSP sockets.cpp). Returns the device port the server reports.
 * Measured: OKAY, then OKAY and the port as a length-prefixed string; FAIL "cannot rebind
 * existing socket" if the device port is taken.
 */
export async function adbReverse(
  endpoint: AdbEndpoint,
  serial: string,
  devicePort: number,
  hostPort: number,
  options?: AdbOptions,
): Promise<number> {
  checkPort(devicePort);
  checkPort(hostPort);
  const connection = await deviceService(
    endpoint,
    serial,
    `reverse:forward:norebind:tcp:${devicePort};tcp:${hostPort}`,
    options,
  );
  try {
    await connection.expectOkay();
    const reported = await connection.readString(true);
    return reported && /^\d{1,5}$/.test(reported) ? Number(reported) : devicePort;
  } finally {
    connection.close();
  }
}

/** Removes the reverse rule for this device port. FAIL "listener 'tcp:N' not found" if there's none. */
export async function adbReverseRemove(
  endpoint: AdbEndpoint,
  serial: string,
  devicePort: number,
  options?: AdbOptions,
): Promise<void> {
  checkPort(devicePort);
  const connection = await deviceService(endpoint, serial, `reverse:killforward:tcp:${devicePort}`, options);
  try {
    await connection.expectOkay();
  } finally {
    connection.close();
  }
}

/**
 * The device's reverse rules. Each line is "<name> <device> <host>"; the name is the transport's
 * (measured: host-16), not useful, so it's skipped.
 */
export async function adbReverseList(
  endpoint: AdbEndpoint,
  serial: string,
  options?: AdbOptions,
): Promise<ReverseRule[]> {
  const connection = await deviceService(endpoint, serial, 'reverse:list-forward', options);
  try {
    const text = (await connection.readString()) ?? '';
    return text
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length === 3)
      .slice(0, 256)
      .map(([, device, host]) => ({ device: device!.slice(0, 100), host: host!.slice(0, 100) }));
  } finally {
    connection.close();
  }
}
