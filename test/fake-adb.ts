/**
 * A fake ADB server that replays bytes recorded from a real one (test/fixtures/adb, recorded
 * with scripts/adb-record.mjs). Each request a client sends is answered with what the real
 * server sent after the same request, in the same connection. Tests can also script answers.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AdbEndpoint } from '../src/backend/android/adb-client';

interface Chunk {
  from: 'client' | 'server';
  base64?: string;
  end?: true;
}
interface Recording {
  connections: Array<{ chunks: Chunk[] }>;
}

/** What the real server sent after each request of a recorded connection. */
interface Exchange {
  /** The requests so far in the connection, this one last. */
  requests: string[];
  /** Server chunks until the next request, and whether the server then hung up. */
  reply: Buffer[];
  ends: boolean;
}

export function loadRecording(name: string): Recording {
  return JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures', 'adb', `${name}.json`), 'utf8'),
  ) as Recording;
}

/** A length-prefixed request at the start of `data`, if it is one. */
function requestIn(data: Buffer): { request: string; rest: Buffer } | undefined {
  if (data.length < 4) return undefined;
  const head = data.subarray(0, 4).toString('latin1');
  if (!/^[0-9a-f]{4}$/i.test(head)) return undefined;
  const length = parseInt(head, 16);
  if (data.length < 4 + length) return undefined;
  return { request: data.subarray(4, 4 + length).toString('utf8'), rest: data.subarray(4 + length) };
}

function exchangesOf(recording: Recording): Exchange[] {
  const out: Exchange[] = [];
  for (const { chunks } of recording.connections) {
    const requests: string[] = [];
    let current: Exchange | undefined;
    // The server hanging up after the client did is the recording ending, not part of a reply.
    let clientEnded = false;
    for (const chunk of chunks) {
      if (chunk.from === 'client' && chunk.end) clientEnded = true;
      else if (chunk.from === 'client') {
        const parsed = chunk.base64 ? requestIn(Buffer.from(chunk.base64, 'base64')) : undefined;
        if (parsed) {
          requests.push(parsed.request);
          current = { requests: [...requests], reply: [], ends: false };
          out.push(current);
        }
      } else if (current) {
        if (chunk.end) current.ends = !clientEnded;
        else current.reply.push(Buffer.from(chunk.base64!, 'base64'));
      }
    }
  }
  return out;
}

export interface FakeAdb {
  endpoint: AdbEndpoint;
  /** Everything clients sent, per connection, in order. */
  received: Buffer[][];
  /** The requests clients sent, per connection. */
  requests: string[][];
  /** Ends every open connection, as a restarted server would. */
  dropAll(): void;
  close(): Promise<void>;
}

export interface FakeAdbOptions {
  /** Recordings to replay. */
  recordings?: Recording[];
  /** Send each reply one byte at a time, to test reading across splits. */
  byteByByte?: boolean;
  /**
   * Answers a request itself instead: return true if it did. Gets the connection's requests
   * so far (this one last).
   */
  script?: (requests: string[], socket: net.Socket) => boolean;
}

export async function startFakeAdb(options: FakeAdbOptions = {}): Promise<FakeAdb> {
  const exchanges = (options.recordings ?? []).flatMap(exchangesOf);
  const received: Buffer[][] = [];
  const requests: string[][] = [];
  const sockets = new Set<net.Socket>();

  const send = async (socket: net.Socket, reply: Buffer[], ends: boolean): Promise<void> => {
    for (const chunk of reply) {
      if (!options.byteByByte) socket.write(chunk);
      else {
        for (const byte of chunk) {
          if (socket.destroyed) return;
          socket.write(Buffer.from([byte]));
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    if (ends) socket.end();
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const mine: Buffer[] = [];
    const asked: string[] = [];
    received.push(mine);
    requests.push(asked);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      mine.push(chunk);
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const parsed = requestIn(pending);
        // Not a request (e.g. a shell packet): kept in `received` for tests to check.
        if (!parsed) {
          if (pending.length >= 4 && !/^[0-9a-f]{4}$/i.test(pending.subarray(0, 4).toString('latin1'))) {
            pending = Buffer.alloc(0);
          }
          return;
        }
        pending = parsed.rest;
        asked.push(parsed.request);
        if (options.script?.([...asked], socket)) continue;
        const match = exchanges.find(
          (e) => e.requests.length === asked.length && e.requests.every((r, i) => r === asked[i]),
        );
        if (!match) {
          const message = Buffer.from(`fake adb: nothing recorded for ${asked.join(' then ')}`);
          socket.end(
            Buffer.concat([Buffer.from(`FAIL${message.length.toString(16).padStart(4, '0')}`), message]),
          );
          return;
        }
        void send(socket, match.reply, match.ends);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port },
    received,
    requests,
    dropAll() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A device the fake server plays at the protocol level: its settings, properties and reverse rules. */
export interface FakeDeviceState {
  serial: string;
  settings: Map<string, string>;
  props: Record<string, string>;
  androidId: string;
  rules: Array<{ device: string; host: string }>;
  /** Whether each rule was made loopback-only (tcp:localhost:N), by its listed name. */
  loopbackRules: Map<string, boolean>;
  /** Shell commands it ran, in order. */
  commands: string[];
  /** The ADB transport id it's listed with; a reconnect gets a new one. */
  transportId?: number;
  /** Its shell commands fail (exit code 1), as on a device too busy to answer. */
  failShell?: boolean;
  /** Files in shared storage, by path; `tee` writes, `cat` reads, `rm -f` removes. */
  files: Map<string, string>;
  /** What `am get-current-user` prints; undefined: the command fails, as on old Android. */
  currentUser?: string;
  /** Apps installed, by package: `am start -p` fails for others (exit 1, as measured). */
  apps: Set<string>;
  /** Whether some browser opens http URLs (`am start -a VIEW` without a package). */
  browser: boolean;
  /** Intents `am start` opened, as their arguments. */
  started: string[];
  /** The sizes of the stdin packets the last `tee` got. */
  stdinPackets?: number[];
  /** Called with each shell command as it arrives, before it's answered. */
  onCommand?: (command: string) => void;
}

export function fakeDeviceState(serial = 'R58', props: Record<string, string> = {}): FakeDeviceState {
  return {
    serial,
    settings: new Map([
      ['http_proxy', ':0'],
      ['global_http_proxy_port', '0'],
    ]),
    props: {
      'ro.serialno': serial,
      'ro.product.model': 'Pixel 8',
      'ro.product.manufacturer': 'Google',
      'ro.build.version.sdk': '35',
      ...props,
    },
    androidId: '0123456789abcdef',
    rules: [],
    loopbackRules: new Map(),
    commands: [],
    files: new Map(),
    currentUser: '0',
    apps: new Set(['com.android.chrome', 'com.android.settings']),
    browser: true,
    started: [],
  };
}

/** Shared storage the shell user may write, as measured: each user's Download folder. */
const WRITABLE = /^\/storage\/emulated\/\d+\/Download\/[^/]+$/;

/** A device's answer to an am start command (measured on API 37: exit 1 when nothing opens it). */
function amStart(device: FakeDeviceState, args: string): Buffer {
  const pkg = / -p (\S+)/.exec(args)?.[1];
  const action = /-a (\S+)/.exec(args)?.[1] ?? '';
  const opens = pkg
    ? device.apps.has(pkg)
    : action.startsWith('android.settings.') || action.startsWith('com.android.settings.')
      ? device.apps.has('com.android.settings')
      : action === 'android.intent.action.VIEW' && device.browser;
  if (!opens) return shellPackets('Error: Activity not started, unable to resolve Intent\n', 1);
  device.started.push(args);
  return shellPackets(`Starting: Intent { act=${action} }\n`);
}

/** Takes stdin packets until "close stdin", then calls `done` with what came. */
function readStdin(socket: net.Socket, done: (input: Buffer, packets: number[]) => void): void {
  let pending = Buffer.alloc(0);
  const input: Buffer[] = [];
  const sizes: number[] = [];
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const id = pending[0]!;
      const length = pending.readUInt32LE(1);
      if (pending.length < 5 + length) return;
      const data = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (id === 0) {
        input.push(data);
        sizes.push(length);
      } else if (id === 4) {
        done(Buffer.concat(input), sizes);
        return;
      }
    }
  });
}

const frame = (text: string): string => `${Buffer.byteLength(text).toString(16).padStart(4, '0')}${text}`;

function shellPackets(stdout: string, exitCode = 0, stderr = ''): Buffer {
  const packet = (id: number, text: string): Buffer => {
    const data = Buffer.from(text);
    const head = Buffer.from([id, 0, 0, 0, 0]);
    head.writeUInt32LE(data.length, 1);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([
    Buffer.from('OKAY'),
    packet(1, stdout),
    ...(stderr ? [packet(2, stderr)] : []),
    Buffer.from([3, 1, 0, 0, 0, exitCode]),
  ]);
}

/**
 * A fake ADB server with these devices, answering the requests Wirescry makes as the API 37
 * emulator was measured to (test/fixtures/adb): version, track-devices-l, features, shell v2
 * getprop and settings, and reverse rules, which it keeps.
 */
export async function startDeviceServer(
  devices: FakeDeviceState[],
): Promise<
  FakeAdb & { /** Sends the device list again to every tracker (devices came or went). */ update(): void }
> {
  const trackers = new Set<net.Socket>();
  const list = () =>
    frame(
      devices
        .map(
          (d, i) =>
            `${d.serial}\tdevice product:x model:Pixel_8 device:x transport_id:${d.transportId ?? i + 1}\n`,
        )
        .join(''),
    );
  const fake = await startFakeAdb({
    script: (requests, socket) => {
      const [first, second] = requests;
      if (first === 'host:version') return (void socket.end('OKAY00040029'), true);
      if (first === 'host:track-devices-l') {
        trackers.add(socket);
        socket.on('close', () => trackers.delete(socket));
        socket.write(`OKAY${list()}`);
        return true;
      }
      const features = /^host-serial:(.+):features$/.exec(first ?? '');
      if (features) return (void socket.end(`OKAY${frame('shell_v2,cmd')}`), true);
      const tport = /^host:tport:serial:(.+)$/.exec(first ?? '');
      const device = tport && devices.find((d) => d.serial === tport[1]);
      if (!tport) return false;
      if (!device) {
        socket.end(`FAIL${frame(`device '${tport[1]}' not found`)}`);
        return true;
      }
      if (requests.length === 1) {
        socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.from([7, 0, 0, 0, 0, 0, 0, 0])]));
        return true;
      }
      const shell = /^shell,v2,raw:(.*)$/.exec(second ?? '');
      if (shell) {
        const command = shell[1]!;
        device.commands.push(command);
        device.onCommand?.(command);
        if (device.failShell) return (void socket.end(shellPackets('', 1)), true);
        const get = /^settings get global (\S+)$/.exec(command);
        const tee = /^tee (\S+)$/.exec(command);
        const cat = /^cat (\S+)$/.exec(command);
        const rm = /^rm -f (\S+)$/.exec(command);
        const am = /^am start (.+)$/.exec(command);
        if (tee) {
          socket.write('OKAY');
          readStdin(socket, (input, packets) => {
            device.stdinPackets = packets;
            if (!WRITABLE.test(tee[1]!)) {
              socket.end(shellPackets('', 1, `tee: ${tee[1]}: Permission denied\n`).subarray(4));
              return;
            }
            device.files.set(tee[1]!, input.toString('utf8'));
            socket.end(shellPackets(input.toString('utf8')).subarray(4));
          });
        } else if (cat) {
          const file = device.files.get(cat[1]!);
          socket.end(
            file === undefined
              ? shellPackets('', 1, `cat: ${cat[1]}: No such file or directory\n`)
              : shellPackets(file),
          );
        } else if (rm) {
          device.files.delete(rm[1]!);
          socket.end(shellPackets(''));
        } else if (command === 'am get-current-user') {
          socket.end(
            device.currentUser === undefined
              ? shellPackets('', 255, 'Unknown command: get-current-user\n')
              : shellPackets(`${device.currentUser}\n`),
          );
        } else if (am) {
          socket.end(amStart(device, am[1]!));
        } else if (command === 'getprop') {
          socket.end(
            shellPackets(
              Object.entries(device.props)
                .map(([k, v]) => `[${k}]: [${v}]\n`)
                .join(''),
            ),
          );
        } else if (command === 'settings get secure android_id') {
          socket.end(shellPackets(`${device.androidId}\n`));
        } else if (get) {
          socket.end(shellPackets(`${device.settings.get(get[1]!) ?? ''}\n`));
        } else {
          const put = /^settings put global http_proxy (\S+)$/.exec(command);
          if (!put) return (void socket.end(shellPackets('', 127)), true);
          const value = put[1]!;
          device.settings.set('http_proxy', value);
          const colon = value.lastIndexOf(':');
          device.settings.set('global_http_proxy_host', value === ':0' ? '' : value.slice(0, colon));
          device.settings.set('global_http_proxy_port', value === ':0' ? '0' : value.slice(colon + 1));
          socket.end(shellPackets(''));
        }
        return true;
      }
      if (second === 'reverse:list-forward') {
        socket.end(`OKAY${frame(device.rules.map((r) => `host-7 ${r.device} ${r.host}\n`).join(''))}`);
        return true;
      }
      // As measured on API 37: tcp:localhost:N binds loopback only, and is listed as tcp:N.
      const forward = /^reverse:forward:norebind:tcp:(localhost:)?(\d+);(tcp:\d+)$/.exec(second ?? '');
      if (forward) {
        const spec = `tcp:${forward[2]}`;
        if (device.rules.some((r) => r.device === spec)) {
          socket.end(`OKAYFAIL${frame('cannot rebind existing socket')}`);
        } else {
          device.rules.push({ device: spec, host: forward[3]! });
          device.loopbackRules.set(spec, forward[1] !== undefined);
          socket.end(`OKAYOKAY${frame(forward[2]!)}`);
        }
        return true;
      }
      const kill = /^reverse:killforward:(tcp:\d+)$/.exec(second ?? '');
      if (kill) {
        const before = device.rules.length;
        device.rules = device.rules.filter((r) => r.device !== kill[1]);
        socket.end(
          device.rules.length < before ? 'OKAYOKAY' : `OKAYFAIL${frame(`listener '${kill[1]}' not found`)}`,
        );
        return true;
      }
      return false;
    },
  });
  return Object.assign(fake, {
    update() {
      for (const socket of trackers) socket.write(list());
    },
  });
}
