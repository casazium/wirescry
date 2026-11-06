/** Reading devices: their names, Android versions and identities, from real and made-up properties. */
import { describe, expect, it } from 'vitest';
import type { AdbDeviceLine, AdbEndpoint, ShellResult } from '../src/backend/android/adb-client';
import {
  cleanText,
  devicesFrom,
  identityOf,
  infoKey,
  parseGetprop,
  readDeviceInfo,
  TOO_OLD,
  type DeviceInfo,
  type DeviceIo,
} from '../src/backend/android/devices';
import { loadRecording, startFakeAdb } from './fake-adb';

const ENDPOINT: AdbEndpoint = { host: '127.0.0.1', port: 1 };

/** A fake shell answering getprop and android_id from these values. */
function shellWith(
  props: Record<string, string>,
  androidId = 'abc123',
  fail?: string,
  features = ['shell_v2', 'cmd'],
): DeviceIo {
  return { features: async () => features, shell: shellFor(props, androidId, fail) };
}

function shellFor(props: Record<string, string>, androidId: string, fail?: string) {
  return async (_e: AdbEndpoint, _s: string, command: string): Promise<ShellResult> => {
    if (fail) return { stdout: '', stderr: fail, exitCode: 1 };
    if (command === 'getprop') {
      return {
        stdout:
          Object.entries(props)
            .map(([k, v]) => `[${k}]: [${v}]`)
            .join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'settings get secure android_id')
      return { stdout: `${androidId}\n`, stderr: '', exitCode: 0 };
    throw new Error(`unexpected ${command}`);
  };
}

const line = (
  serial: string,
  state = 'device',
  fields: Record<string, string> = { transport_id: '1' },
): AdbDeviceLine => ({
  serial,
  state,
  fields,
});

describe('Reading a device', () => {
  it('reads the real emulator: its AVD name, API level, and an identity', async () => {
    const fake = await startFakeAdb({ recordings: [loadRecording('android-setup')] });
    try {
      const info = await readDeviceInfo(fake.endpoint, 'emulator-5554');
      expect(info).toEqual({
        label: 'Medium Phone API 37.0',
        emulator: true,
        apiLevel: 37,
        identityParts: ['EMULATOR37X2X13X0', '0123456789abcde', 'Medium_Phone_API_37.0'],
      });
    } finally {
      await fake.close();
    }
  });

  it.each([
    [{ 'ro.product.model': 'Pixel 8', 'ro.product.manufacturer': 'Google' }, 'Pixel 8'],
    [{ 'ro.product.model': 'SM-S918B', 'ro.product.manufacturer': 'samsung' }, 'samsung SM-S918B'],
    [{ 'ro.product.model': 'moto g power', 'ro.product.manufacturer': 'motorola' }, 'motorola moto g power'],
    [{ 'ro.product.model': 'OnePlus 12', 'ro.product.manufacturer': 'OnePlus' }, 'OnePlus 12'],
    [{}, 'R58M123'],
  ])('names a phone from %j as %j', async (props, label) => {
    const info = await readDeviceInfo(
      ENDPOINT,
      'R58M123',
      shellWith({ 'ro.build.version.sdk': '34', ...props }),
    );
    expect(info.label).toBe(label);
    expect(info.emulator).toBe(false);
  });

  it('recognises an older emulator by ro.kernel.qemu', async () => {
    const info = await readDeviceInfo(
      ENDPOINT,
      'emulator-5556',
      shellWith({
        'ro.kernel.qemu': '1',
        'ro.kernel.qemu.avd_name': 'Pixel_4_API_30',
        'ro.build.version.sdk': '30',
      }),
    );
    expect(info).toMatchObject({ label: 'Pixel 4 API 30', emulator: true, apiLevel: 30 });
  });

  it('leaves out placeholder serials and an unset android_id from the identity', async () => {
    for (const serial of ['0123456789ABCDEF', 'unknown', '']) {
      const info = await readDeviceInfo(ENDPOINT, 'x', shellWith({ 'ro.serialno': serial }, 'null'));
      expect(info.identityParts).toEqual(['', '', '']);
    }
  });

  it('cleans what a device says before showing it', async () => {
    const info = await readDeviceInfo(
      ENDPOINT,
      'x',
      shellWith({
        'ro.product.model': `Evil\u202e\u0007 ${'x'.repeat(300)}`,
        'ro.product.manufacturer': 'Google',
      }),
    );
    // eslint-disable-next-line no-control-regex -- checking a control character is gone
    expect(info.label).not.toMatch(/[\u202e\u0007]/);
    expect(info.label.length).toBeLessThanOrEqual(100);
  });

  it('fails when the device refuses a command', async () => {
    await expect(readDeviceInfo(ENDPOINT, 'x', shellWith({}, 'a', 'permission denied'))).rejects.toThrow(
      'permission denied',
    );
  });

  it('marks a device without shell v2 as too old, without running anything on it', async () => {
    const io = shellWith({}, 'a', undefined, ['cmd']);
    let ran = false;
    const info = await readDeviceInfo(ENDPOINT, 'emulator-5560', {
      features: io.features,
      shell: async () => {
        ran = true;
        throw new Error('no shell v2');
      },
    });
    expect(info).toMatchObject({ unsupported: TOO_OLD, emulator: true, identityParts: ['', '', ''] });
    expect(ran).toBe(false);
    const l = line('emulator-5560');
    expect(devicesFrom([l], new Map([[infoKey(l), info]]))[0]!.unsupported).toBe(TOO_OLD);
  });

  it('ignores an API level that is not a number', async () => {
    const info = await readDeviceInfo(ENDPOINT, 'x', shellWith({ 'ro.build.version.sdk': 'Baklava' }));
    expect(info.apiLevel).toBeUndefined();
  });
});

describe('Parsing getprop', () => {
  it('reads [key]: [value] lines and skips the rest', () => {
    expect([...parseGetprop('[a]: [1]\n[b.c]: []\ngarbage\n[d]: [x y]\r\n')]).toEqual([
      ['a', '1'],
      ['b.c', ''],
      ['d', 'x y'],
    ]);
  });
});

describe('Cleaning device text', () => {
  it.each([
    ['  Pixel   8 ', 'Pixel 8'],
    ['a\nb\tc', 'a b c'],
    ['\u200b\u202a', undefined],
    [undefined, undefined],
  ])('turns %j into %j', (input, output) => {
    expect(cleanText(input)).toBe(output);
  });

  it('caps by characters, not bytes', () => {
    expect(cleanText('é'.repeat(150))).toBe('é'.repeat(100));
  });
});

describe('The device list', () => {
  const pixel: DeviceInfo = {
    label: 'Pixel 8',
    emulator: false,
    apiLevel: 34,
    identityParts: ['SER1', 'aid1', ''],
  };

  it('shows each state plainly', () => {
    const devices = devicesFrom(
      [
        line('a', 'device'),
        line('b', 'unauthorized'),
        line('c', 'authorizing'),
        line('d', 'offline'),
        line('e', 'no permissions (missing udev rules? user is in the plugdev group); see [http://x]'),
        line('f', 'bootloader'),
      ],
      new Map(),
    );
    expect(devices.map((d) => [d.serial, d.state, d.stateText])).toEqual([
      ['a', 'ready', undefined],
      ['b', 'unauthorized', undefined],
      ['c', 'connecting', undefined],
      ['d', 'offline', undefined],
      ['e', 'no-permissions', undefined],
      ['f', 'other', 'bootloader'],
    ]);
  });

  it("uses the server's model until the device has been read, then what was read", () => {
    const l = line('R58', 'device', { model: 'Pixel_8', transport_id: '3' });
    expect(devicesFrom([l], new Map())[0]).toMatchObject({ label: 'Pixel 8', emulator: false });
    expect(devicesFrom([l], new Map([[infoKey(l), pixel]]))[0]).toEqual({
      serial: 'R58',
      state: 'ready',
      label: 'Pixel 8',
      emulator: false,
      apiLevel: 34,
      id: identityOf(pixel.identityParts),
    });
  });

  it('marks devices older than Android 7 as unsupported', () => {
    const l = line('old');
    const [device] = devicesFrom([l], new Map([[infoKey(l), { ...pixel, apiLevel: 23 }]]));
    expect(device!.unsupported).toMatch(/Android 7/);
    const [ok] = devicesFrom([l], new Map([[infoKey(l), { ...pixel, apiLevel: 24 }]]));
    expect(ok!.unsupported).toBeUndefined();
  });

  it('shows why a device could not be read', () => {
    const l = line('x');
    expect(devicesFrom([l], new Map([[infoKey(l), { error: 'nope' }]]))[0]).toMatchObject({ error: 'nope' });
  });

  it('keeps the same identity across transports, and tells two copies of one emulator apart', () => {
    const a = line('emulator-5554', 'device', { transport_id: '1' });
    const b = line('emulator-5556', 'device', { transport_id: '2' });
    const avd: DeviceInfo = {
      label: 'Pixel',
      emulator: true,
      identityParts: ['EMU', 'same', 'Pixel_API_34'],
    };
    const one = devicesFrom([a], new Map([[infoKey(a), avd]]));
    const later = devicesFrom(
      [{ ...a, fields: { transport_id: '9' } }],
      new Map([[infoKey({ ...a, fields: { transport_id: '9' } }), avd]]),
    );
    expect(one[0]!.id).toBe(later[0]!.id);
    const both = devicesFrom(
      [a, b],
      new Map([
        [infoKey(a), avd],
        [infoKey(b), avd],
      ]),
    );
    expect(both[0]!.id).not.toBe(both[1]!.id);
    expect(both.every((d) => d.id)).toBe(true);
  });

  it('gives no identity to a device with nothing to tell it apart', () => {
    const l = line('x');
    expect(
      devicesFrom([l], new Map([[infoKey(l), { ...pixel, identityParts: ['', '', ''] }]]))[0]!.id,
    ).toBeUndefined();
    expect(identityOf(['', '', ''])).toBeUndefined();
  });

  it('never uses the transport serial alone as the identity', () => {
    const l = line('emulator-5554');
    const [d] = devicesFrom([l], new Map([[infoKey(l), pixel]]));
    expect(d!.id).not.toContain('emulator-5554');
    expect(d!.id).toMatch(/^[0-9a-f]{32}$/);
  });
});
