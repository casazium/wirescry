/**
 * Capture and Stop against a fake device that behaves as the API 37 emulator was measured to
 * (test/fixtures/adb/reverse.json): settings, reverse rules, and the failures to expect.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdbError, type ReverseRule, type ShellResult } from '../src/backend/android/adb-client';
import {
  CaptureRecords,
  DeviceCapture,
  judgeProxy,
  type CaptureIo,
  type CaptureRecord,
  type ProxySettings,
} from '../src/backend/android/capture';
import type { ExchangeSource } from '../src/shared/api';

const ID = 'a'.repeat(32);
const PIXEL = { id: ID, serial: 'R58', label: 'Pixel 8', apiLevel: 35 };

/** A device: its global settings and reverse rules, and switches for things going wrong. */
class FakeDevice implements CaptureIo {
  settings = new Map<string, string>([
    ['http_proxy', ':0'],
    ['global_http_proxy_port', '0'],
  ]);
  rules: ReverseRule[] = [];
  commands: string[] = [];
  /** Ports adbd refuses with "cannot rebind" (taken by something it doesn't list). */
  rebindRefused = new Set<number>();
  /** The device ignores proxy writes (Xiaomi without "USB debugging (Security settings)"). */
  ignoresWrites = false;
  /** Reads fail (e.g. unplugged). */
  gone = false;
  /** Fails `reverse` with another error. */
  reverseFails: Error | undefined;

  private ok(stdout = ''): ShellResult {
    return { stdout, stderr: '', exitCode: 0 };
  }

  async shell(_serial: string, command: string): Promise<ShellResult> {
    if (this.gone) throw new AdbError("ADB: device 'R58' not found", "device 'R58' not found");
    this.commands.push(command);
    const get = /^settings get global (\S+)$/.exec(command);
    if (get) return this.ok(`${this.settings.get(get[1]!) ?? ''}\n`);
    const put = /^settings put global http_proxy (\S+)$/.exec(command);
    if (put) {
      if (this.ignoresWrites) return this.ok();
      const value = put[1]!;
      this.settings.set('http_proxy', value);
      // As measured: http_proxy also sets the host and port keys; :0 clears them.
      const [host, port] =
        value === ':0' ? ['', '0'] : [value.slice(0, value.lastIndexOf(':')), value.split(':').pop()!];
      this.settings.set('global_http_proxy_host', host);
      this.settings.set('global_http_proxy_port', port);
      return this.ok();
    }
    throw new Error(`unexpected command ${command}`);
  }

  /** Whether each rule was asked for loopback-only, by device port. */
  loopbackOnly = new Map<number, boolean>();
  /** Removals asked for, with the form. */
  removals: Array<[number, boolean]> = [];

  async reverse(
    _serial: string,
    devicePort: number,
    hostPort: number,
    loopbackOnly = false,
  ): Promise<number | undefined> {
    this.loopbackOnly.set(devicePort, loopbackOnly);
    if (this.gone) throw new AdbError('gone');
    if (this.reverseFails) throw this.reverseFails;
    if (this.rebindRefused.has(devicePort) || this.rules.some((r) => r.device === `tcp:${devicePort}`)) {
      throw new AdbError('ADB: cannot rebind existing socket', 'cannot rebind existing socket');
    }
    this.rules.push({ device: `tcp:${devicePort}`, host: `tcp:${hostPort}` });
    return devicePort;
  }

  async reverseRemove(_serial: string, devicePort: number, loopbackOnly = false): Promise<void> {
    this.removals.push([devicePort, loopbackOnly]);
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.device !== `tcp:${devicePort}`);
    if (this.rules.length === before)
      throw new AdbError('not found', `listener 'tcp:${devicePort}' not found`);
  }

  async reverseList(): Promise<ReverseRule[]> {
    if (this.gone) throw new AdbError('gone');
    return this.rules.map((r) => ({ ...r }));
  }
}

/** Listeners that hand out ports and remember what's open. */
function fakeListeners(fail?: Error) {
  const opened = new Map<string, number>();
  const local = new Map<string, boolean>();
  let next = 9001;
  return {
    opened,
    local,
    async open(source: ExchangeSource) {
      if (fail) throw fail;
      if (!opened.has(source.id)) opened.set(source.id, next++);
      return { port: opened.get(source.id)! };
    },
    async close(id: string) {
      opened.delete(id);
    },
    setLocalAccess(id: string, allowed: boolean) {
      local.set(id, allowed);
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-capture-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(
  options: { device?: FakeDevice; listeners?: ReturnType<typeof fakeListeners>; random?: () => number } = {},
) {
  const device = options.device ?? new FakeDevice();
  const listeners = options.listeners ?? fakeListeners();
  const records = new CaptureRecords(dir);
  const capture = new DeviceCapture({
    io: device,
    listeners,
    records,
    random: options.random,
    readBackMs: 50,
    readBackIntervalMs: 10,
  });
  return { device, listeners, records, capture };
}

const settings = (overrides: Partial<ProxySettings>): ProxySettings => ({
  httpProxy: ':0',
  host: '',
  port: '0',
  exclusions: '',
  pac: '',
  ...overrides,
});

describe("Judging a device's proxy", () => {
  it.each([
    [settings({}), { kind: 'none' }],
    [settings({ httpProxy: '' }), { kind: 'none' }],
    [settings({ httpProxy: 'null', host: 'null', exclusions: 'null', pac: 'null' }), { kind: 'none' }],
    [
      settings({ httpProxy: 'proxy.corp:3128', host: 'proxy.corp', port: '3128' }),
      { kind: 'plain', value: 'proxy.corp:3128' },
    ],
    [settings({ httpProxy: '10.0.0.5:8080' }), { kind: 'plain', value: '10.0.0.5:8080' }],
    [
      settings({ httpProxy: '127.0.0.1:43210', host: '127.0.0.1' }),
      { kind: 'loopback', value: '127.0.0.1:43210' },
    ],
    [settings({ httpProxy: 'localhost:8888' }), { kind: 'loopback', value: 'localhost:8888' }],
  ])('%j is %j', (input, expected) => {
    expect(judgeProxy(input)).toEqual(expected);
  });

  it.each([
    [settings({ pac: 'http://wpad/wpad.dat' }), /PAC/],
    [settings({ httpProxy: ':0', host: 'mdm.corp' }), /device management/],
    [settings({ httpProxy: '', host: 'mdm.corp' }), /device management/],
    [settings({ httpProxy: 'proxy.corp:3128', exclusions: 'intranet.corp' }), /bypass/],
    [settings({ httpProxy: '[::1]:8080' }), /couldn’t put back/],
    [settings({ httpProxy: 'proxy.corp:0' }), /couldn’t put back/],
    [settings({ httpProxy: 'proxy.corp:99999' }), /couldn’t put back/],
    [settings({ httpProxy: 'a b:80' }), /couldn’t put back/],
    [settings({ httpProxy: 'x;reboot:80' }), /couldn’t put back/],
  ])('refuses %j', (input, reason) => {
    const judged = judgeProxy(input);
    expect(judged.kind).toBe('refused');
    expect((judged as { reason: string }).reason).toMatch(reason);
  });
});

describe('Capture', () => {
  it('records first, then adds the reverse rule and the proxy, and reads it back', async () => {
    const { device, listeners, records, capture } = setup({ random: () => 0.5 });
    expect(await capture.capture(PIXEL)).toEqual({});
    const record = capture.capturing(ID)!;
    expect(record).toMatchObject({
      id: ID,
      label: 'Pixel 8',
      previousProxy: null,
      devicePort: 40000,
      hostPort: 9001,
    });
    expect(device.rules).toEqual([{ device: 'tcp:40000', host: 'tcp:9001' }]);
    expect(device.settings.get('http_proxy')).toBe('127.0.0.1:40000');
    expect(listeners.opened.get(ID)).toBe(9001);
    expect(await records.list()).toEqual([record]);
  });

  it('writes the record before changing anything on the device', async () => {
    const device = new FakeDevice();
    const { records, capture } = setup({ device });
    const seen: Array<{ rules: number; recordFiles: number }> = [];
    const reverse = device.reverse.bind(device);
    device.reverse = async (...args) => {
      seen.push({ rules: device.rules.length, recordFiles: (await records.list()).length });
      return reverse(...args);
    };
    await capture.capture(PIXEL);
    expect(seen).toEqual([{ rules: 0, recordFiles: 1 }]);
  });

  it("leaves a developer's own reverse rules alone, and picks another port", async () => {
    const device = new FakeDevice();
    device.rules = [{ device: 'tcp:40000', host: 'tcp:40000' }];
    const ports = [0.5, 0.5, 0.25];
    const { capture } = setup({ device, random: () => ports.shift() ?? 0.75 });
    await capture.capture(PIXEL);
    expect(device.rules[0]).toEqual({ device: 'tcp:40000', host: 'tcp:40000' });
    expect(capture.capturing(ID)!.devicePort).toBe(30000);
    await capture.stop(PIXEL);
    expect(device.rules).toEqual([{ device: 'tcp:40000', host: 'tcp:40000' }]);
  });

  it('tries another port when the device refuses to rebind one, and keeps the record current', async () => {
    const device = new FakeDevice();
    device.rebindRefused.add(40000);
    const ports = [0.5, 0.25];
    const { records, capture } = setup({ device, random: () => ports.shift() ?? 0.75 });
    await capture.capture(PIXEL);
    expect(capture.capturing(ID)!.devicePort).toBe(30000);
    expect((await records.list())[0]!.devicePort).toBe(30000);
    expect(device.settings.get('http_proxy')).toBe('127.0.0.1:30000');
  });

  it('gives up after a few refusals and leaves the device as it was', async () => {
    const device = new FakeDevice();
    const { listeners, records, capture } = setup({ device });
    device.reverse = async () => {
      throw new AdbError('ADB: cannot rebind existing socket', 'cannot rebind existing socket');
    };
    await expect(capture.capture(PIXEL)).rejects.toThrow(/cannot rebind/);
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(await records.list()).toEqual([]);
    expect(listeners.opened.size).toBe(0);
  });

  it('asks before replacing a proxy the device already has, and puts it back on Stop', async () => {
    const device = new FakeDevice();
    device.settings.set('http_proxy', 'proxy.corp:3128');
    device.settings.set('global_http_proxy_host', 'proxy.corp');
    const { listeners, records, capture } = setup({ device });
    expect(await capture.capture(PIXEL)).toEqual({ needsConfirmation: 'proxy.corp:3128' });
    // Nothing changed while asking.
    expect(device.rules).toEqual([]);
    expect(listeners.opened.size).toBe(0);
    expect(await records.list()).toEqual([]);
    await capture.capture(PIXEL, 'proxy.corp:3128');
    expect(capture.capturing(ID)!.previousProxy).toBe('proxy.corp:3128');
    await capture.stop(PIXEL);
    expect(device.settings.get('http_proxy')).toBe('proxy.corp:3128');
    expect(device.settings.get('global_http_proxy_host')).toBe('proxy.corp');
  });

  it.each([
    ['a PAC file', (d: FakeDevice) => d.settings.set('global_proxy_pac_url', 'http://wpad/wpad.dat'), /PAC/],
    [
      'a managed proxy',
      (d: FakeDevice) => d.settings.set('global_http_proxy_host', 'mdm.corp'),
      /management/,
    ],
    [
      'a stray 127.0.0.1 proxy',
      (d: FakeDevice) => d.settings.set('http_proxy', '127.0.0.1:41111'),
      /Clear it first/,
    ],
  ])('refuses a device with %s, changing nothing', async (_what, prepare, message) => {
    const device = new FakeDevice();
    prepare(device);
    const { listeners, records, capture } = setup({ device });
    const before = new Map(device.settings);
    await expect(capture.capture(PIXEL, 'proxy.corp:3128')).rejects.toThrow(message);
    expect(device.settings).toEqual(before);
    expect(device.rules).toEqual([]);
    expect(listeners.opened.size).toBe(0);
    expect(await records.list()).toEqual([]);
  });

  it('undoes everything when the device ignores the proxy setting, and says why', async () => {
    const device = new FakeDevice();
    device.ignoresWrites = true;
    const { listeners, records, capture } = setup({ device });
    await expect(capture.capture(PIXEL)).rejects.toThrow(/Xiaomi.*Samsung/);
    expect(device.rules).toEqual([]);
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(listeners.opened.size).toBe(0);
    expect(await records.list()).toEqual([]);
    expect(capture.capturing(ID)).toBeUndefined();
  });

  it('changes nothing on the device when its listener can’t open', async () => {
    const device = new FakeDevice();
    const { records, capture } = setup({
      device,
      listeners: fakeListeners(new Error('Wirescry is stopping.')),
    });
    await expect(capture.capture(PIXEL)).rejects.toThrow('stopping');
    expect(device.rules).toEqual([]);
    expect(device.commands.filter((c) => c.startsWith('settings put'))).toEqual([]);
    expect(await records.list()).toEqual([]);
  });

  it('changes nothing on the device when the record can’t be written', async () => {
    const device = new FakeDevice();
    // A file where the records folder should be.
    const blocked = path.join(dir, 'blocked');
    await writeFile(blocked, 'not a folder');
    const capture = new DeviceCapture({
      io: device,
      listeners: fakeListeners(),
      records: new CaptureRecords(blocked),
      readBackMs: 50,
      readBackIntervalMs: 10,
    });
    await expect(capture.capture(PIXEL)).rejects.toThrow();
    expect(device.rules).toEqual([]);
    expect(device.settings.get('http_proxy')).toBe(':0');
  });

  it('removes the reverse rule when a later step fails', async () => {
    const device = new FakeDevice();
    const { records, capture } = setup({ device });
    const shell = device.shell.bind(device);
    device.shell = async (serial, command) =>
      command.startsWith('settings put')
        ? { stdout: '', stderr: 'Permission denial', exitCode: 255 }
        : shell(serial, command);
    await expect(capture.capture(PIXEL)).rejects.toThrow(/Permission denial/);
    expect(device.rules).toEqual([]);
    expect(await records.list()).toEqual([]);
  });

  it('captures once, however often it is asked, one request at a time', async () => {
    const { device, listeners, capture } = setup();
    await Promise.all([capture.capture(PIXEL), capture.capture(PIXEL), capture.capture(PIXEL)]);
    expect(device.rules).toHaveLength(1);
    expect(listeners.opened.size).toBe(1);
    expect(device.commands.filter((c) => c.startsWith('settings put'))).toHaveLength(1);
  });
});

describe('Stop', () => {
  it('puts the device back as it was and forgets it', async () => {
    const { device, listeners, records, capture } = setup();
    await capture.capture(PIXEL);
    expect(await capture.stop(PIXEL)).toEqual({});
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(device.settings.get('global_http_proxy_host')).toBe('');
    expect(device.rules).toEqual([]);
    expect(listeners.opened.size).toBe(0);
    expect(await records.list()).toEqual([]);
    expect(capture.capturing(ID)).toBeUndefined();
  });

  it("leaves a proxy someone else changed, and says so, but still tidies up Wirescry's part", async () => {
    const { device, records, capture } = setup();
    await capture.capture(PIXEL);
    device.settings.set('http_proxy', 'other.tool:9999');
    const { note } = await capture.stop(PIXEL);
    expect(note).toMatch(/changed since capture started/);
    expect(device.settings.get('http_proxy')).toBe('other.tool:9999');
    expect(device.rules).toEqual([]);
    expect(await records.list()).toEqual([]);
  });

  it("doesn't remove a rule someone else put on its device port", async () => {
    const { device, capture } = setup();
    await capture.capture(PIXEL);
    const port = capture.capturing(ID)!.devicePort;
    // Another tool replaced Wirescry's rule with its own.
    device.rules = [{ device: `tcp:${port}`, host: 'tcp:5555' }];
    await capture.stop(PIXEL);
    expect(device.rules).toEqual([{ device: `tcp:${port}`, host: 'tcp:5555' }]);
  });

  it('still puts the proxy back when its reverse rule is already gone', async () => {
    const { device, capture } = setup();
    await capture.capture(PIXEL);
    device.rules = [];
    await capture.stop(PIXEL);
    expect(device.settings.get('http_proxy')).toBe(':0');
  });

  it('keeps the record when the device can’t be reached', async () => {
    const { device, records, capture } = setup();
    await capture.capture(PIXEL);
    device.gone = true;
    await expect(capture.stop(PIXEL)).rejects.toThrow();
    expect(await records.list()).toHaveLength(1);
    expect(capture.capturing(ID)).toBeDefined();
    device.gone = false;
    await capture.stop(PIXEL);
    expect(await records.list()).toEqual([]);
  });

  it('does nothing for a device it never captured', async () => {
    const { device, capture } = setup();
    expect(await capture.stop(PIXEL)).toEqual({});
    expect(device.commands).toEqual([]);
  });
});

describe('Left from an earlier run', () => {
  it('finds records on start and restores the device with them', async () => {
    const first = setup();
    await first.capture.capture(PIXEL);
    // Wirescry crashes: a new run finds the record.
    const { device, capture } = setup({ device: first.device });
    await capture.load();
    expect(capture.isLeftover(ID)).toBe(true);
    expect(capture.capturing(ID)).toBeUndefined();
    await expect(capture.capture(PIXEL)).rejects.toThrow(/Restore it first/);
    await capture.stop(PIXEL);
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(device.rules).toEqual([]);
    expect(capture.isLeftover(ID)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('ignores anything in the records folder that isn’t a record', async () => {
    const valid: CaptureRecord = {
      version: 1,
      id: 'b'.repeat(32),
      label: 'Tablet',
      previousProxy: null,
      devicePort: 30000,
      hostPort: 9001,
      startedAt: new Date().toISOString(),
    };
    await writeFile(path.join(dir, `${'b'.repeat(32)}.json`), JSON.stringify(valid));
    await writeFile(path.join(dir, `${'c'.repeat(32)}.json`), '{not json');
    await writeFile(
      path.join(dir, `${'d'.repeat(32)}.json`),
      JSON.stringify({ ...valid, id: 'd'.repeat(32), devicePort: 0 }),
    );
    await writeFile(
      path.join(dir, `${'e'.repeat(32)}.json`),
      JSON.stringify({ ...valid, id: 'e'.repeat(32), previousProxy: 'x;reboot:1' }),
    );
    await writeFile(path.join(dir, `${'f'.repeat(32)}.json`), JSON.stringify({ ...valid })); // id doesn't match its name
    await writeFile(path.join(dir, 'notes.txt'), 'hello');
    expect(await new CaptureRecords(dir).list()).toEqual([valid]);
    expect(await new CaptureRecords(path.join(dir, 'missing')).list()).toEqual([]);
  });
});

describe('Clearing a stray proxy', () => {
  it('sets a 127.0.0.1 proxy Wirescry has no record of back to none', async () => {
    const device = new FakeDevice();
    device.settings.set('http_proxy', '127.0.0.1:41111');
    device.settings.set('global_http_proxy_host', '127.0.0.1');
    const { capture } = setup({ device });
    await capture.clearStrayProxy(PIXEL);
    expect(device.settings.get('http_proxy')).toBe(':0');
  });

  it('refuses to clear any other proxy, or one Wirescry set', async () => {
    const device = new FakeDevice();
    device.settings.set('http_proxy', 'proxy.corp:3128');
    const { capture } = setup({ device });
    await expect(capture.clearStrayProxy(PIXEL)).rejects.toThrow(/doesn’t point at 127.0.0.1/);
    expect(device.settings.get('http_proxy')).toBe('proxy.corp:3128');
    const other = setup();
    await other.capture.capture(PIXEL);
    await expect(other.capture.clearStrayProxy(PIXEL)).rejects.toThrow(/Stop or Restore/);
  });
});

describe('Quitting', () => {
  it('puts back every reachable device, keeps the records of the rest, and doesn’t wait forever', async () => {
    const phones: Record<string, FakeDevice> = { R58: new FakeDevice(), TAB: new FakeDevice() };
    const io: CaptureIo = {
      shell: (serial, command) => phones[serial]!.shell(serial, command),
      reverse: (serial, d, h, l) => phones[serial]!.reverse(serial, d, h, l),
      reverseRemove: (serial, d, l) => phones[serial]!.reverseRemove(serial, d, l),
      reverseList: (serial) => phones[serial]!.reverseList(),
    };
    const records = new CaptureRecords(dir);
    const capture = new DeviceCapture({
      io,
      listeners: fakeListeners(),
      records,
      readBackMs: 50,
      readBackIntervalMs: 10,
    });
    await capture.capture(PIXEL);
    await capture.capture({ id: 'b'.repeat(32), serial: 'TAB', label: 'Tablet', apiLevel: 33 });
    const started = Date.now();
    // The tablet isn't connected any more.
    await capture.stopAll((id) => (id === ID ? 'R58' : undefined), 500);
    expect(Date.now() - started).toBeLessThan(500);
    expect((await records.list()).map((r) => r.label)).toEqual(['Tablet']);
    expect(phones.R58!.settings.get('http_proxy')).toBe(':0');
    expect(phones.TAB!.rules.length).toBe(1);
  });

  it('gives up on a device that hangs', async () => {
    const { device, capture } = setup();
    await capture.capture(PIXEL);
    device.reverseList = () => new Promise(() => undefined);
    const started = Date.now();
    await capture.stopAll(() => 'R58', 100);
    expect(Date.now() - started).toBeLessThan(400);
  });
});

it('keeps record files private to this user', async () => {
  const { capture } = setup();
  await capture.capture(PIXEL);
  if (process.platform === 'win32') return;
  const { stat } = await import('node:fs/promises');
  expect((await stat(path.join(dir, `${ID}.json`))).mode & 0o077).toBe(0);
  expect(JSON.parse(await readFile(path.join(dir, `${ID}.json`), 'utf8')).id).toBe(ID);
});

describe('What the review found', () => {
  it('keeps a device capturing, not forgotten, when a failed capture can’t put its proxy back', async () => {
    const device = new FakeDevice();
    const { listeners, records, capture } = setup({ device });
    // The proxy write lands, then every read fails (unplugged, timeouts).
    const shell = device.shell.bind(device);
    let wrote = false;
    device.shell = async (serial, command) => {
      if (wrote && command.startsWith('settings get')) throw new AdbError('ADB: closed', 'closed');
      const result = await shell(serial, command);
      if (command.startsWith('settings put')) wrote = true;
      return result;
    };
    await expect(capture.capture(PIXEL)).rejects.toThrow(/left capturing.*http_proxy :0/);
    const record = capture.capturing(ID)!;
    expect(device.settings.get('http_proxy')).toBe(`127.0.0.1:${record.devicePort}`);
    // The tunnel and the record are still there, so the device still works and can be stopped.
    expect(device.rules).toEqual([{ device: `tcp:${record.devicePort}`, host: `tcp:${record.hostPort}` }]);
    expect(await records.list()).toHaveLength(1);
    expect(listeners.opened.has(ID)).toBe(true);
    device.shell = shell;
    await capture.stop(PIXEL);
    expect(device.settings.get('http_proxy')).toBe(':0');
  });

  it('asks again if the proxy changed after the user confirmed replacing it', async () => {
    const device = new FakeDevice();
    device.settings.set('http_proxy', 'proxy.corp:3128');
    const { capture } = setup({ device });
    expect(await capture.capture(PIXEL)).toEqual({ needsConfirmation: 'proxy.corp:3128' });
    device.settings.set('http_proxy', 'other.corp:8080');
    expect(await capture.capture(PIXEL, 'proxy.corp:3128')).toEqual({ needsConfirmation: 'other.corp:8080' });
    expect(device.rules).toEqual([]);
  });

  it('says nothing misleading when the proxy was never written, or is already back', async () => {
    const first = setup();
    await first.capture.capture(PIXEL);
    // As if Wirescry had crashed after adding the rule but before writing the proxy.
    first.device.settings.set('http_proxy', ':0');
    first.device.settings.set('global_http_proxy_host', '');
    const { capture } = setup({ device: first.device });
    await capture.load();
    expect(await capture.stop(PIXEL)).toEqual({});
    expect(first.device.rules).toEqual([]);
  });

  it('treats a proxy whose host no longer agrees as changed by someone else', async () => {
    const { device, capture } = setup();
    await capture.capture(PIXEL);
    device.settings.set('global_http_proxy_host', 'mdm.corp');
    expect((await capture.stop(PIXEL)).note).toMatch(/changed since capture started/);
  });

  it.each(['127.0.0.1:3128', 'localhost:3128', 'proxy.corp:0', 'proxy.corp:70000'])(
    'ignores a record whose previous proxy is %j',
    async (previousProxy) => {
      const record = {
        version: 1,
        id: ID,
        label: 'x',
        previousProxy,
        devicePort: 30000,
        hostPort: 9001,
        startedAt: 'now',
      };
      await writeFile(path.join(dir, `${ID}.json`), JSON.stringify(record));
      expect(await new CaptureRecords(dir).list()).toEqual([]);
    },
  );

  it('turns the destination switch off again on Stop', async () => {
    const { listeners, capture } = setup();
    await capture.capture(PIXEL);
    listeners.setLocalAccess(ID, true);
    await capture.stop(PIXEL);
    expect(listeners.local.get(ID)).toBe(false);
  });

  it('points the tunnel at a listener that moved, and puts the device back if it is gone', async () => {
    const { device, records, capture } = setup();
    await capture.capture(PIXEL);
    const { devicePort } = capture.capturing(ID)!;
    await capture.listenerMoved(PIXEL, 9555);
    expect(device.rules).toEqual([{ device: `tcp:${devicePort}`, host: 'tcp:9555' }]);
    expect((await records.list())[0]!.hostPort).toBe(9555);
    expect(device.settings.get('http_proxy')).toBe(`127.0.0.1:${devicePort}`);
    await capture.listenerMoved(PIXEL, undefined);
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(device.rules).toEqual([]);
    expect(capture.capturing(ID)).toBeUndefined();
  });

  it('puts back a device whose capture was still in progress when Wirescry quit', async () => {
    const device = new FakeDevice();
    const { capture } = setup({ device });
    let release!: () => void;
    const reverse = device.reverse.bind(device);
    device.reverse = async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return reverse(...args);
    };
    const capturing = capture.capture(PIXEL);
    await expect.poll(() => release).toBeDefined();
    const quitting = capture.stopAll(() => 'R58', 2000);
    release();
    await capturing;
    await quitting;
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(device.rules).toEqual([]);
  });
});

describe("Keeping the device's tunnel to itself", () => {
  it.each([
    [35, true],
    [30, true],
    [29, false],
    [24, false],
  ])('on API %i, asks for a loopback-only port: %s', async (apiLevel, loopbackOnly) => {
    const { device, records, capture } = setup();
    await capture.capture({ ...PIXEL, apiLevel });
    const { devicePort } = capture.capturing(ID)!;
    expect(device.loopbackOnly.get(devicePort)).toBe(loopbackOnly);
    expect((await records.list())[0]!.loopbackOnly).toBe(loopbackOnly);
    await capture.stop(PIXEL);
    expect(device.removals).toEqual([[devicePort, loopbackOnly]]);
  });

  it("refuses a device whose Android version it couldn't read, changing nothing", async () => {
    const { device, listeners, capture } = setup();
    await expect(capture.capture({ ...PIXEL, apiLevel: undefined })).rejects.toThrow(/Android version/);
    expect(device.rules).toEqual([]);
    expect(listeners.opened.size).toBe(0);
  });

  it('removes a rule left by an earlier run the way it was made', async () => {
    const first = setup();
    await first.capture.capture(PIXEL);
    const { devicePort } = first.capture.capturing(ID)!;
    const { capture } = setup({ device: first.device });
    await capture.load();
    await capture.stop(PIXEL);
    expect(first.device.removals).toEqual([[devicePort, true]]);
  });
});

describe('Loopback-only rules, the hard cases', () => {
  it('tries another port when adbd says a localhost rule cannot bind', async () => {
    const device = new FakeDevice();
    const ports = [0.5, 0.25];
    const { capture } = setup({ device, random: () => ports.shift() ?? 0.75 });
    const reverse = device.reverse.bind(device);
    let first = true;
    device.reverse = async (...args) => {
      if (first) {
        first = false;
        throw new AdbError(
          'ADB: cannot bind listener: Address already in use',
          'cannot bind listener: Address already in use',
        );
      }
      return reverse(...args);
    };
    await capture.capture(PIXEL);
    expect(capture.capturing(ID)!.devicePort).toBe(30000);
  });

  it('undoes a tunnel the device made on another port than asked, changing nothing else', async () => {
    const device = new FakeDevice();
    const { records, capture } = setup({ device });
    device.reverse = async (_s, _d, hostPort) => {
      // As Android 7's adbd would: "localhost:N" read as port 0, a random port.
      device.rules.push({ device: 'tcp:51234', host: `tcp:${hostPort}` });
      return 51234;
    };
    await expect(capture.capture(PIXEL)).rejects.toThrow(/port 51234 instead of/);
    expect(device.rules).toEqual([]);
    expect(device.settings.get('http_proxy')).toBe(':0');
    expect(await records.list()).toEqual([]);
  });

  it('refuses a localhost rule when the device reports no port at all', async () => {
    const device = new FakeDevice();
    const { capture } = setup({ device });
    const reverse = device.reverse.bind(device);
    device.reverse = async (...args) => {
      await reverse(...args);
      return undefined;
    };
    await expect(capture.capture(PIXEL)).rejects.toThrow(/instead of/);
    expect(device.settings.get('http_proxy')).toBe(':0');
  });

  it("remakes an old record's rule loopback-only when its listener moves", async () => {
    const device = new FakeDevice();
    const record: CaptureRecord = {
      version: 1,
      id: ID,
      label: 'Pixel 8',
      previousProxy: null,
      devicePort: 30000,
      hostPort: 9001,
      startedAt: 'earlier',
    };
    await new CaptureRecords(dir).write(record);
    device.rules = [{ device: 'tcp:30000', host: 'tcp:9001' }];
    device.settings.set('http_proxy', '127.0.0.1:30000');
    const { capture } = setup({ device });
    await capture.load();
    // A leftover is only stopped, never moved; a capturing device is.
    await capture.listenerMoved(PIXEL, 9555);
    expect(device.rules).toEqual([{ device: 'tcp:30000', host: 'tcp:9001' }]);
    const active = setup({ device: new FakeDevice() });
    await active.capture.capture({ ...PIXEL, apiLevel: 35 });
    const fresh = active.capture.capturing(ID)!;
    delete fresh.loopbackOnly;
    await active.capture.listenerMoved(PIXEL, 9777);
    expect(active.device.loopbackOnly.get(fresh.devicePort)).toBe(true);
    expect((await active.records.list())[0]!.loopbackOnly).toBe(true);
  });
});
