import { createHash } from 'node:crypto';
import type { AndroidDevice } from '../../shared/api';
import { cleanText } from './text';
import { adbFeatures, adbShell, type AdbDeviceLine, type AdbEndpoint, type ShellResult } from './adb-client';

/**
 * What Wirescry knows about each device the ADB server lists: its state, a name to show, its
 * Android version, and an identity that lasts across reconnects (transport serials don't:
 * emulator-5554 is reused, and a phone over Wi-Fi has a changing ip:port).
 */

/** Android 7 (API 24): shell v2, and apps stop trusting user certificates by default. */
export const MIN_API = 24;

/** Properties read from a device: `getprop` lines look like "[key]: [value]". */
export function parseGetprop(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^\[([^\]]{1,200})\]: \[(.*)\]\s*$/.exec(line);
    if (match) props.set(match[1]!, match[2]!.slice(0, 500));
  }
  return props;
}

/** Serials some devices report that don't tell units apart (seen on cheap phones and boards). */
const PLACEHOLDER_SERIALS = new Set(['', 'unknown', '0123456789abcdef', '0123456789', 'null']);

export interface DeviceInfo {
  label: string;
  emulator: boolean;
  apiLevel?: number;
  /** ro.serialno, android_id and the emulator's AVD name: together, who the device is. */
  identityParts: string[];
  /** Why Wirescry can't set it up, found before its version could be read. */
  unsupported?: string;
}

/** For a device whose adbd has no shell v2: older than Android 7. */
export const TOO_OLD = `Android setup needs Android 7 (API ${MIN_API}) or later; this device is older.`;

export interface DeviceIo {
  shell: typeof adbShell;
  features: typeof adbFeatures;
}

/**
 * Reads a device's properties and android_id, and works out its name and identity. Sources:
 * ro.build.version.sdk (source.android.com, CTS setup), ro.product.model (adb's own model:
 * field), ro.serialno and ro.boot.qemu.avd_name / ro.kernel.qemu.avd_name (AOSP init and the
 * emulator; the kernel form on older images), `settings get secure android_id` (prints null
 * when unset); all measured on the API 37 emulator.
 */
export { cleanText };

export async function readDeviceInfo(
  endpoint: AdbEndpoint,
  serial: string,
  io: DeviceIo = { shell: adbShell, features: adbFeatures },
): Promise<DeviceInfo> {
  const { shell } = io;
  // Shell v2 came with Android 7 (AOSP adb docs: API >= 24); without it, the device is too old.
  if (!(await io.features(endpoint, serial)).includes('shell_v2')) {
    return {
      label: cleanText(serial) ?? 'Android device',
      emulator: serial.startsWith('emulator-'),
      identityParts: ['', '', ''],
      unsupported: TOO_OLD,
    };
  }
  const props = parseGetprop(okOutput(await shell(endpoint, serial, 'getprop')));
  const androidId = okOutput(await shell(endpoint, serial, 'settings get secure android_id')).trim();
  const avd = props.get('ro.boot.qemu.avd_name') || props.get('ro.kernel.qemu.avd_name') || undefined;
  const emulator =
    props.get('ro.boot.qemu') === '1' || props.get('ro.kernel.qemu') === '1' || avd !== undefined;
  const sdk = Number(props.get('ro.build.version.sdk'));
  const model = props.get('ro.product.model');
  const manufacturer = props.get('ro.product.manufacturer');
  // An emulator is best known by its AVD's name; a phone by its maker and model, e.g.
  // "samsung SM-S918B", or just "Pixel 8" when the model already says who made it.
  const named =
    model &&
    manufacturer &&
    !model.toLowerCase().includes(manufacturer.toLowerCase()) &&
    manufacturer !== 'Google'
      ? `${manufacturer} ${model}`
      : model;
  const label =
    cleanText(avd?.replace(/_/g, ' ')) ?? cleanText(named) ?? cleanText(serial) ?? 'Android device';
  const serialno = (props.get('ro.serialno') ?? '').trim();
  return {
    label,
    emulator,
    apiLevel: Number.isInteger(sdk) && sdk > 0 ? sdk : undefined,
    identityParts: [
      PLACEHOLDER_SERIALS.has(serialno.toLowerCase()) ? '' : serialno,
      androidId === 'null' ? '' : androidId,
      avd ?? '',
    ],
  };
}

function okOutput(result: ShellResult): string {
  if (result.exitCode !== 0) throw new Error(cleanText(result.stderr, 200) ?? `exit code ${result.exitCode}`);
  return result.stdout;
}

/** A stable, opaque id from a device's identity parts (never the transport serial alone). */
export function identityOf(parts: string[]): string | undefined {
  if (parts.every((p) => !p)) return undefined;
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** Plain-words state for the UI. */
export function stateOf(line: AdbDeviceLine): AndroidDevice['state'] {
  if (line.state === 'device') return 'ready';
  if (line.state === 'unauthorized') return 'unauthorized';
  if (line.state === 'authorizing' || line.state === 'connecting') return 'connecting';
  if (line.state === 'offline') return 'offline';
  if (line.state.startsWith('no permissions')) return 'no-permissions';
  return 'other';
}

/**
 * Builds the devices to show from the server's list and what's been read from each. Two
 * devices with the same identity (two copies of one AVD) get their transport serial added.
 */
export function devicesFrom(
  lines: AdbDeviceLine[],
  info: ReadonlyMap<string, DeviceInfo | { error: string }>,
): AndroidDevice[] {
  const devices = lines.map((line): AndroidDevice => {
    const key = infoKey(line);
    const known = info.get(key);
    const base: AndroidDevice = {
      serial: line.serial,
      state: stateOf(line),
      ...(stateOf(line) === 'other' ? { stateText: cleanText(line.state, 200) } : {}),
      label: cleanText(line.fields.model?.replace(/_/g, ' ')) ?? cleanText(line.serial) ?? 'Android device',
      emulator: line.serial.startsWith('emulator-'),
    };
    if (!known) return base;
    if ('error' in known) return { ...base, error: known.error };
    return {
      ...base,
      label: known.label,
      emulator: known.emulator,
      ...(known.apiLevel !== undefined ? { apiLevel: known.apiLevel } : {}),
      ...(known.unsupported
        ? { unsupported: known.unsupported }
        : known.apiLevel !== undefined && known.apiLevel < MIN_API
          ? {
              unsupported: `Android setup needs Android 7 (API ${MIN_API}) or later; this device has API ${known.apiLevel}.`,
            }
          : {}),
      ...(identityOf(known.identityParts) ? { id: identityOf(known.identityParts) } : {}),
    };
  });
  const counts = new Map<string, number>();
  for (const d of devices) if (d.id) counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
  return devices.map((d) => (d.id && counts.get(d.id)! > 1 ? { ...d, id: identityOf([d.id, d.serial]) } : d));
}

/** What device info is cached under: the transport, which changes when a device reconnects. */
export function infoKey(line: Pick<AdbDeviceLine, 'serial' | 'fields'>): string {
  return `${line.serial}#${line.fields.transport_id ?? ''}`;
}
