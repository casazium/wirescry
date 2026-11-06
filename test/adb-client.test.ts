/**
 * The ADB client against a fake server replaying a real server's bytes (test/fixtures/adb), and
 * against servers that misbehave. Recordings: adb 1.0.41 on macOS with the API 37 emulator.
 */
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdbConnection,
  AdbError,
  adbEndpoint,
  adbFeatures,
  adbReverse,
  adbReverseList,
  adbReverseRemove,
  adbServerVersion,
  adbShell,
  parseDeviceList,
  trackDevices,
  type AdbDeviceLine,
  type AdbEndpoint,
} from '../src/backend/android/adb-client';
import { loadRecording, startFakeAdb, type FakeAdb } from './fake-adb';

const OURS = loadRecording('wirescry-client');
const CLI = loadRecording('adb-cli');
const FAILURES = loadRecording('failures');
const EMULATOR = 'emulator-5554';

let fake: FakeAdb | undefined;
const extra: Array<() => Promise<void>> = [];
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  for (const close of extra.splice(0)) await close();
});

/** A raw TCP server for misbehaving: `onRequest` gets each connection. */
async function rawServer(onConnection: (socket: net.Socket) => void): Promise<AdbEndpoint> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => sockets.add(s));
  extra.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port };
}

describe.each([
  ['as the server sent it', false],
  ['one byte at a time', true],
])('ADB client against recorded replies, %s', (_how, byteByByte) => {
  it('reads the server version', async () => {
    fake = await startFakeAdb({ recordings: [OURS], byteByByte });
    expect(await adbServerVersion(fake.endpoint)).toBe(41);
  });

  it("reads a device's features", async () => {
    fake = await startFakeAdb({ recordings: [OURS], byteByByte });
    const features = await adbFeatures(fake.endpoint, EMULATOR);
    expect(features).toContain('shell_v2');
    expect(features.length).toBeGreaterThan(10);
  });

  it.each([
    ['getprop ro.serialno', { stdout: 'EMULATOR37X2X13X0\n', stderr: '', exitCode: 0 }],
    ['getprop ro.build.version.sdk', { stdout: '37\n', stderr: '', exitCode: 0 }],
    ['getprop ro.boot.qemu.avd_name', { stdout: 'Medium_Phone_API_37.0\n', stderr: '', exitCode: 0 }],
    ['settings get global http_proxy', { stdout: ':0\n', stderr: '', exitCode: 0 }],
    ['getprop ro.no.such.property', { stdout: '\n', stderr: '', exitCode: 0 }],
    ['exit 3', { stdout: '', stderr: '', exitCode: 3 }],
    [
      'ls /nonexistent-wirescry',
      { stdout: '', stderr: 'ls: /nonexistent-wirescry: No such file or directory\n', exitCode: 1 },
    ],
  ])('runs "%s", with its output and exit code', async (command, expected) => {
    fake = await startFakeAdb({ recordings: [OURS], byteByByte });
    expect(await adbShell(fake.endpoint, EMULATOR, command)).toEqual(expected);
  });

  it('follows the device list through a reconnect', async () => {
    fake = await startFakeAdb({ recordings: [OURS], byteByByte });
    const lists: AdbDeviceLine[][] = [];
    const tracker = trackDevices(
      fake.endpoint,
      (list) => lists.push(list),
      () => undefined,
    );
    await expect.poll(() => lists.length).toBe(7);
    tracker.close();
    expect(lists.map((l) => l.map((d) => d.state).join())).toEqual([
      'device',
      'offline',
      '',
      'offline',
      'authorizing',
      'offline',
      'device',
    ]);
    expect(lists[0]![0]).toEqual({
      serial: EMULATOR,
      state: 'device',
      fields: {
        product: 'sdk_gphone64_arm64',
        model: 'sdk_gphone64_arm64',
        device: 'emu64a',
        transport_id: '2',
      },
    });
    expect(lists[6]![0]!.fields.transport_id).toBe('3');
  });
});

describe('ADB client, compared with Google’s adb', () => {
  /** What adb sent in a recorded connection, as one buffer. */
  const cliSent = (first: string, second?: string): Buffer => {
    const connection = CLI.connections.find((c) => {
      const texts = c.chunks
        .filter((x) => x.from === 'client' && x.base64)
        .map((x) => Buffer.from(x.base64!, 'base64').toString('latin1'));
      return texts[0]?.endsWith(first) && (second === undefined || texts[1]?.endsWith(second));
    })!;
    return Buffer.concat(
      connection.chunks
        .filter((x) => x.from === 'client' && x.base64)
        .map((x) => Buffer.from(x.base64!, 'base64')),
    );
  };

  it('sends the same bytes for the version, features and a shell command', async () => {
    fake = await startFakeAdb({ recordings: [OURS] });
    await adbServerVersion(fake.endpoint);
    await adbFeatures(fake.endpoint, EMULATOR);
    await adbShell(fake.endpoint, EMULATOR, 'getprop ro.serialno');
    await expect.poll(() => fake!.received.length).toBe(3);
    const sent = fake.received.map((chunks) => Buffer.concat(chunks));
    expect(sent[0]).toEqual(cliSent('host:version'));
    expect(sent[1]).toEqual(cliSent(`host-serial:${EMULATOR}:features`));
    // The request, then the shell request, then a "close stdin" packet.
    await expect
      .poll(() => Buffer.concat(fake!.received[2]!).length)
      .toBe(cliSent(`host:tport:serial:${EMULATOR}`, 'getprop ro.serialno').length);
    expect(Buffer.concat(fake.received[2]!)).toEqual(
      cliSent(`host:tport:serial:${EMULATOR}`, 'getprop ro.serialno'),
    );
  });

  it("reads adb's own device list", () => {
    const reply = CLI.connections
      .find(
        (c) =>
          c.chunks[0]!.base64 &&
          Buffer.from(c.chunks[0]!.base64, 'base64').toString().endsWith('host:devices-l'),
      )!
      .chunks.find((x) => x.from === 'server' && x.base64)!;
    const text = Buffer.from(reply.base64!, 'base64').toString().slice(8);
    expect(parseDeviceList(text)).toEqual([
      {
        serial: EMULATOR,
        state: 'device',
        fields: {
          product: 'sdk_gphone64_arm64',
          model: 'sdk_gphone64_arm64',
          device: 'emu64a',
          transport_id: '2',
        },
      },
    ]);
  });
});

describe('ADB client, when things go wrong', () => {
  it.each([
    [
      'a shell on an unknown device',
      (e: AdbEndpoint) => adbShell(e, 'no-such-device', 'getprop ro.serialno'),
      "device 'no-such-device' not found",
    ],
    [
      "an unknown device's features",
      (e: AdbEndpoint) => adbFeatures(e, 'no-such-device'),
      "device 'no-such-device' not found",
    ],
  ])("passes on the server's FAIL message for %s", async (_what, call, message) => {
    fake = await startFakeAdb({ recordings: [FAILURES] });
    const error = await call(fake.endpoint).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdbError);
    expect((error as AdbError).serverMessage).toBe(message);
  });

  it('says when nothing is listening', async () => {
    const endpoint = await rawServer(() => undefined);
    const port = endpoint.port;
    await extra.pop()!();
    await expect(adbServerVersion({ host: '127.0.0.1', port })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it('says when something other than ADB answers', async () => {
    const server = http.createServer((_req, res) => res.end('hello'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    extra.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    await expect(adbServerVersion({ host: '127.0.0.1', port })).rejects.toThrow(/instead of OKAY or FAIL/);
  });

  it('gives up on a server that never answers', async () => {
    const endpoint = await rawServer(() => undefined);
    await expect(adbServerVersion(endpoint, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('notices a server that hangs up part way through an answer', async () => {
    const endpoint = await rawServer((socket) => socket.once('data', () => socket.end('OKAY0004002')));
    await expect(adbServerVersion(endpoint)).rejects.toThrow(/part way through/);
  });

  it.each([
    ['a length that is not hex', 'OKAYzzzz'],
    ['a version that is not hex', 'OKAY0004xyz!'],
  ])('refuses %s', async (_what, reply) => {
    const endpoint = await rawServer((socket) => socket.once('data', () => socket.end(reply)));
    await expect(adbServerVersion(endpoint)).rejects.toThrow(AdbError);
  });

  it('stops reading a shell command that sends too much', async () => {
    const endpoint = await rawServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.alloc(8)]));
        socket.once('data', () => {
          socket.write('OKAY');
          const head = Buffer.from([1, 0, 0, 0, 0]);
          head.writeUInt32LE(2 * 1024 * 1024, 1);
          socket.write(head);
          socket.write(Buffer.alloc(2 * 1024 * 1024, 0x61));
        });
      });
    });
    await expect(adbShell(endpoint, EMULATOR, 'getprop ro.serialno')).rejects.toThrow(/more output/);
  });

  it('gives up on a shell command whose server keeps sending empty packets', async () => {
    const endpoint = await rawServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.alloc(8)]));
        socket.once('data', () => {
          socket.write('OKAY');
          const drip = setInterval(() => socket.write(Buffer.from([9, 0, 0, 0, 0])), 30);
          socket.on('close', () => clearInterval(drip));
        });
      });
    });
    const started = Date.now();
    await expect(
      adbShell(endpoint, EMULATOR, 'getprop ro.serialno', { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('cleans and caps a FAIL message', async () => {
    const message = `bad\u202e\u0007 ${'x'.repeat(1000)}`;
    const body = Buffer.from(message);
    const endpoint = await rawServer((socket) =>
      socket.once('data', () =>
        socket.end(Buffer.concat([Buffer.from(`FAIL${body.length.toString(16).padStart(4, '0')}`), body])),
      ),
    );
    const error = (await adbServerVersion(endpoint).catch((e: unknown) => e)) as AdbError;
    expect(error.serverMessage).toMatch(/^bad x+$/);
    expect(error.serverMessage!.length).toBe(300);
  });

  it('refuses a bad exit packet', async () => {
    const endpoint = await rawServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.alloc(8)]));
        socket.once('data', () =>
          socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.from([3, 2, 0, 0, 0, 0, 0])])),
        );
      });
    });
    await expect(adbShell(endpoint, EMULATOR, 'getprop ro.serialno')).rejects.toThrow(/bad exit status/);
  });

  it.each([
    'getprop x; reboot',
    'echo $(id)',
    'getprop "x"',
    "getprop 'x'",
    'getprop x\nreboot',
    'a|b',
    'a&b',
    'a>b',
    '`id`',
    '',
  ])('refuses to run %j, without connecting', async (command) => {
    let connections = 0;
    const endpoint = await rawServer(() => (connections += 1));
    await expect(adbShell(endpoint, EMULATOR, command)).rejects.toThrow(/Refusing/);
    expect(connections).toBe(0);
  });

  it.each(['', 'a b', 'a\nb', 'émulateur'])(
    'refuses the device serial %j, without connecting',
    async (serial) => {
      let connections = 0;
      const endpoint = await rawServer(() => (connections += 1));
      await expect(adbShell(endpoint, serial, 'getprop ro.serialno')).rejects.toThrow(/serial/);
      await expect(adbFeatures(endpoint, serial)).rejects.toThrow(/serial/);
      expect(connections).toBe(0);
    },
  );

  it('reports the end of device tracking once when the server goes away, and nothing after close', async () => {
    fake = await startFakeAdb({ recordings: [OURS] });
    const ends: Array<Error | undefined> = [];
    const lists: unknown[] = [];
    trackDevices(
      fake.endpoint,
      (l) => lists.push(l),
      (e) => ends.push(e),
    );
    await expect.poll(() => lists.length).toBe(7);
    fake.dropAll();
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toBeInstanceOf(Error);

    const quiet: unknown[] = [];
    const tracker = trackDevices(
      fake.endpoint,
      () => undefined,
      (e) => quiet.push(e),
    );
    await expect.poll(() => fake!.requests.length).toBe(2);
    tracker.close();
    fake.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(quiet.map((e) => String(e))).toEqual([]);
  });

  it('reports a FAIL to the tracking request', async () => {
    fake = await startFakeAdb({ recordings: [] });
    const ends: Array<Error | undefined> = [];
    trackDevices(
      fake.endpoint,
      () => undefined,
      (e) => ends.push(e),
    );
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toBeInstanceOf(AdbError);
  });

  it('waits for device updates as long as it takes, past the answer timeout', async () => {
    let socket!: net.Socket;
    const endpoint = await rawServer((s) => {
      socket = s;
      s.once('data', () => s.write('OKAY0000'));
    });
    const lists: unknown[] = [];
    const ends: unknown[] = [];
    const tracker = trackDevices(
      endpoint,
      (l) => lists.push(l),
      (e) => ends.push(e),
      { timeoutMs: 100 },
    );
    await expect.poll(() => lists.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ends).toEqual([]);
    const update = 'emulator-5556\tdevice transport_id:9\n';
    socket.write(`${update.length.toString(16).padStart(4, '0')}${update}`);
    await expect.poll(() => lists.length).toBe(2);
    tracker.close();
  });
});

describe('Finding the ADB server', () => {
  it.each([
    [{}, { host: '127.0.0.1', port: 5037 }],
    [{ ANDROID_ADB_SERVER_PORT: '5038' }, { host: '127.0.0.1', port: 5038 }],
    [{ ADB_SERVER_SOCKET: 'tcp:5039' }, { host: '127.0.0.1', port: 5039 }],
    [{ ADB_SERVER_SOCKET: 'tcp:localhost:5040' }, { host: 'localhost', port: 5040 }],
    [{ ADB_SERVER_SOCKET: 'tcp:[::1]:5041' }, { host: '::1', port: 5041 }],
    [
      { ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5042', ANDROID_ADB_SERVER_PORT: '5038' },
      { host: '127.0.0.1', port: 5042 },
    ],
    [
      { ADB_SERVER_SOCKET: '  ', ANDROID_ADB_SERVER_PORT: '5038' },
      { host: '127.0.0.1', port: 5038 },
    ],
    [
      { ANDROID_ADB_SERVER_ADDRESS: 'localhost', ANDROID_ADB_SERVER_PORT: '5038' },
      { host: 'localhost', port: 5038 },
    ],
    [{ ANDROID_ADB_SERVER_ADDRESS: '::1' }, { host: '::1', port: 5037 }],
  ])('uses %j', (env, expected) => {
    expect(adbEndpoint(env)).toEqual(expected);
  });

  it.each([
    [{ ADB_SERVER_SOCKET: 'tcp:192.168.1.5:5037' }, /only uses an ADB server on this computer/],
    [{ ADB_SERVER_SOCKET: 'tcp:adb.example.com:5037' }, /only uses an ADB server on this computer/],
    [{ ADB_SERVER_SOCKET: 'localabstract:adb' }, /only tcp:host:port/],
    [{ ADB_SERVER_SOCKET: 'tcp:localhost' }, /only tcp:host:port/],
    [{ ANDROID_ADB_SERVER_ADDRESS: '10.0.0.2' }, /only uses an ADB server on this computer/],
    [{ ADB_SERVER_SOCKET: 'tcp:0' }, /invalid port/],
    [{ ADB_SERVER_SOCKET: 'tcp:70000' }, /invalid port/],
    [{ ANDROID_ADB_SERVER_PORT: 'abc' }, /isn't a port/],
    [{ ANDROID_ADB_SERVER_PORT: '0' }, /isn't a port/],
  ])('refuses %j', (env, message) => {
    expect(() => adbEndpoint(env)).toThrow(message);
  });
});

describe('Reading device lists', () => {
  it('reads every state, including ones with spaces and links', () => {
    const text = [
      'emulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2',
      'R58M123ABC\tunauthorized usb:1-1 transport_id:4',
      '0123456789ABCDEF\tno permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:3-2 transport_id:5',
      'emulator-5556\toffline transport_id:6',
      '192.168.1.20:5555\tdevice product:panther model:Pixel_7 device:panther transport_id:7',
      '',
    ].join('\n');
    const devices = parseDeviceList(text);
    expect(devices.map((d) => [d.serial, d.state])).toEqual([
      ['emulator-5554', 'device'],
      ['R58M123ABC', 'unauthorized'],
      [
        '0123456789ABCDEF',
        'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
      ],
      ['emulator-5556', 'offline'],
      ['192.168.1.20:5555', 'device'],
    ]);
    expect(devices[2]!.fields).toEqual({ usb: '3-2', transport_id: '5' });
    expect(devices[4]!.fields.model).toBe('Pixel_7');
  });

  it("ignores serials that aren't printable ASCII, and a serial listed twice", () => {
    expect(
      parseDeviceList('ok\tdevice\nbad\u202eevil\tdevice\nemoji😀\tdevice\nok\toffline\n').map((d) => [
        d.serial,
        d.state,
      ]),
    ).toEqual([['ok', 'device']]);
  });

  it('reads an empty list, blank lines and Windows line ends', () => {
    expect(parseDeviceList('')).toEqual([]);
    expect(parseDeviceList('\n\n')).toEqual([]);
    expect(parseDeviceList('a\tdevice transport_id:1\r\n')).toEqual([
      { serial: 'a', state: 'device', fields: { transport_id: '1' } },
    ]);
  });

  it('caps what a server could make huge', () => {
    const many = Array.from({ length: 100 }, (_, i) => `s${i}\tdevice`).join('\n');
    expect(parseDeviceList(many)).toHaveLength(64);
    const long = parseDeviceList(`${'x'.repeat(1000)}\tdevice model:${'m'.repeat(1000)}`)[0]!;
    expect(long.serial).toHaveLength(200);
    expect(long.fields.model).toHaveLength(200);
  });
});

describe('A connection', () => {
  it('reads a length-prefixed string and a clean end', async () => {
    const endpoint = await rawServer((socket) => socket.end('0003abc'));
    const connection = await AdbConnection.open(endpoint);
    expect(await connection.readString(true)).toBe('abc');
    expect(await connection.readString(true)).toBeUndefined();
    connection.close();
  });
});

describe('Reverse rules, against recorded replies', () => {
  const REVERSE = loadRecording('reverse');

  it('adds a rule and reads back the port the server reports', async () => {
    fake = await startFakeAdb({ recordings: [REVERSE] });
    expect(await adbReverse(fake.endpoint, EMULATOR, 43210, 8001)).toBe(43210);
    expect(fake.requests.at(-1)).toEqual([
      `host:tport:serial:${EMULATOR}`,
      'reverse:forward:norebind:tcp:43210;tcp:8001',
    ]);
  });

  it("passes on the server's refusal to replace a rule", async () => {
    fake = await startFakeAdb({ recordings: [REVERSE] });
    const error = (await adbReverse(fake.endpoint, EMULATOR, 43210, 8002).catch(
      (e: unknown) => e,
    )) as AdbError;
    expect(error.serverMessage).toBe('cannot rebind existing socket');
  });

  it('lists rules, skipping the transport name', async () => {
    fake = await startFakeAdb({ recordings: [REVERSE] });
    // The first list-forward in the recording was empty; the replay answers each request the same way.
    expect(await adbReverseList(fake.endpoint, EMULATOR)).toEqual([]);
    const lines = 'host-16 tcp:43210 tcp:8001\nhost-16 tcp:35029 tcp:8003\n';
    const endpoint = await rawServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.alloc(8)]));
        socket.once('data', () => socket.end(`OKAY${lines.length.toString(16).padStart(4, '0')}${lines}`));
      });
    });
    expect(await adbReverseList(endpoint, EMULATOR)).toEqual([
      { device: 'tcp:43210', host: 'tcp:8001' },
      { device: 'tcp:35029', host: 'tcp:8003' },
    ]);
  });

  it("removes a rule, and passes on the server's message when there is none", async () => {
    fake = await startFakeAdb({ recordings: [REVERSE] });
    await adbReverseRemove(fake.endpoint, EMULATOR, 43210);
    // The recording's second removal of the same rule was refused.
    const second = await startFakeAdb({
      script: (requests, socket) => {
        if (requests.length === 1) socket.write(Buffer.concat([Buffer.from('OKAY'), Buffer.alloc(8)]));
        else {
          const message = "listener 'tcp:43210' not found";
          socket.end(`OKAYFAIL${message.length.toString(16).padStart(4, '0')}${message}`);
        }
        return true;
      },
    });
    extra.push(() => second.close());
    const error = (await adbReverseRemove(second.endpoint, EMULATOR, 43210).catch(
      (e: unknown) => e,
    )) as AdbError;
    expect(error.serverMessage).toBe("listener 'tcp:43210' not found");
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])('refuses port %s without connecting', async (port) => {
    let connections = 0;
    const endpoint = await rawServer(() => (connections += 1));
    await expect(adbReverse(endpoint, EMULATOR, port, 8001)).rejects.toThrow(/Bad port/);
    await expect(adbReverse(endpoint, EMULATOR, 43210, port)).rejects.toThrow(/Bad port/);
    await expect(adbReverseRemove(endpoint, EMULATOR, port)).rejects.toThrow(/Bad port/);
    expect(connections).toBe(0);
  });
});
