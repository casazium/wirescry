/**
 * Wirescry's certificate on Android devices: copying it over (shell input), the steps it opens,
 * the trust check, and what's remembered. Against the fake ADB server, which behaves as the API 37
 * emulator was measured to (android-design.md, "Measured for PR 5").
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, generateSPKIFingerprint } from 'mockttp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adbShell, type ShellResult } from '../src/backend/android/adb-client';
import {
  CERTIFICATE_FILE,
  certificateSha256,
  DeviceCertificates,
  type CertificateIo,
} from '../src/backend/android/certificates';
import { AndroidSetup } from '../src/backend/android/setup';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { DeviceListeners } from '../src/backend/device-listeners';
import type { AndroidDevice, ExchangeSource, ProxyStatus, ServerMessage } from '../src/shared/api';
import { fakeDeviceState, startDeviceServer, type FakeDeviceState } from './fake-adb';
import {
  apiClient,
  httpViaProxy,
  requestViaProxy,
  startBackendOnPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

const FILE = `/storage/emulated/0/Download/${CERTIFICATE_FILE}`;

let ca: { key: string; cert: string; spki: string };
let other: { cert: string; spki: string };
beforeAll(async () => {
  const one = await generateCACertificate({ subject: { commonName: 'Wirescry CA (test0001)' } });
  const two = await generateCACertificate({ subject: { commonName: 'Wirescry CA (test0002)' } });
  ca = { ...one, spki: await generateSPKIFingerprint(one.cert) };
  other = { cert: two.cert, spki: await generateSPKIFingerprint(two.cert) };
});

let dir: string;
let phone: FakeDeviceState;
let fake: Awaited<ReturnType<typeof startDeviceServer>>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-certificates-'));
  phone = fakeDeviceState();
  fake = await startDeviceServer([phone]);
});
afterEach(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

/** Device commands over the fake server, as AndroidSetup runs them. */
const realIo = (): CertificateIo => ({
  shell: (serial, command, input) => adbShell(fake.endpoint, serial, command, { input, timeoutMs: 2000 }),
});
const certificates = (io: CertificateIo = realIo()) =>
  new DeviceCertificates({ io, trustFile: path.join(dir, 'trust.json') });

describe('Sending input to a device command', () => {
  it('sends it as stdin packets of at most 4 KiB, then closes stdin', async () => {
    const input = Buffer.from('x'.repeat(10_000));
    const result = await adbShell(fake.endpoint, 'R58', `tee ${FILE}`, { input });
    expect(result.exitCode).toBe(0);
    expect(phone.files.get(FILE)).toBe(input.toString());
    expect(phone.stdinPackets).toEqual([4096, 4096, 1808]);
  });

  it('refuses more input than a certificate, before reaching the server', async () => {
    await expect(
      adbShell(fake.endpoint, 'R58', `tee ${FILE}`, { input: Buffer.alloc(64 * 1024 + 1) }),
    ).rejects.toThrow(/Too much input/);
    expect(phone.commands).toEqual([]);
  });
});

describe('Copying the certificate to a device', () => {
  it('writes it to Downloads, checks it arrived, and opens Security settings', async () => {
    expect(await certificates().send('R58', ca.cert)).toEqual({ settingsOpened: true });
    expect(phone.files.get(FILE)).toBe(ca.cert);
    expect(phone.started).toEqual(['-a android.settings.SECURITY_SETTINGS']);
  });

  it('uses the current user’s storage, and the owner’s when that can’t be read', async () => {
    phone.currentUser = '10';
    await certificates().send('R58', ca.cert);
    expect(phone.files.get(`/storage/emulated/10/Download/${CERTIFICATE_FILE}`)).toBe(ca.cert);
    for (const user of [undefined, 'Error: unknown', '']) {
      phone.files.clear();
      phone.currentUser = user;
      await certificates().send('R58', ca.cert);
      expect([...phone.files.keys()]).toEqual([FILE]);
    }
  });

  it('sends nothing but a lone certificate: never a key', async () => {
    const io = realIo();
    for (const pem of [ca.key, `${ca.cert}${ca.key}`, `${ca.cert}${other.cert}`, '', 'hello']) {
      await expect(certificates(io).send('R58', pem)).rejects.toThrow(/isn’t a certificate/);
    }
    expect(phone.commands).toEqual([]);
  });

  it('still copies it when Settings won’t open, and says so', async () => {
    phone.apps.delete('com.android.settings');
    expect(await certificates().send('R58', ca.cert)).toEqual({ settingsOpened: false });
    expect(phone.files.get(FILE)).toBe(ca.cert);
  });

  it('says why when the device won’t take the file, or it arrives changed', async () => {
    const answer = (stdout: string, exitCode = 0, stderr = ''): ShellResult => ({ stdout, stderr, exitCode });
    const io = (tee: ShellResult, cat: ShellResult): CertificateIo => ({
      shell: async (_serial, command) =>
        command === 'am get-current-user'
          ? answer('0\n')
          : command.startsWith('tee')
            ? tee
            : command.startsWith('cat')
              ? cat
              : answer(''),
    });
    await expect(
      certificates(io(answer('', 1, 'tee: Read-only file system'), answer(''))).send('R58', ca.cert),
    ).rejects.toThrow('Couldn’t copy the certificate to the device: tee: Read-only file system');
    await expect(certificates(io(answer('', 1), answer(''))).send('R58', ca.cert)).rejects.toThrow(
      /exit code 1/,
    );
    await expect(
      certificates(io(answer(ca.cert), answer(ca.cert.slice(0, 100)))).send('R58', ca.cert),
    ).rejects.toThrow(/didn’t arrive on the device intact/);
    // Line endings and a trailing newline don't count as changes.
    await expect(
      certificates(io(answer(ca.cert), answer(ca.cert.replace(/\n/g, '\r\n').trimEnd()))).send(
        'R58',
        ca.cert,
      ),
    ).resolves.toEqual({ settingsOpened: true });
  });
});

describe('Removing the copied certificate', () => {
  it('removes it while it’s still one Wirescry copied, and leaves anything else', async () => {
    phone.files.set(FILE, ca.cert);
    await certificates().remove('R58', [ca.cert]);
    expect(phone.files.has(FILE)).toBe(false);

    phone.files.set(FILE, other.cert);
    await certificates().remove('R58', [ca.cert]);
    expect(phone.files.get(FILE)).toBe(other.cert);
    expect(phone.commands.filter((c) => c.startsWith('rm'))).toEqual([`rm -f ${FILE}`]);
    // Any of the ones copied (before a certificate reset, say).
    await certificates().remove('R58', [ca.cert, other.cert]);
    expect(phone.files.has(FILE)).toBe(false);

    phone.files.clear();
    await certificates().remove('R58', [ca.cert]);
    expect(phone.commands.filter((c) => c.startsWith('rm'))).toHaveLength(2);
  });
});

describe('Opening the check and the installed list', () => {
  it('opens Wirescry’s page in Chrome, else the default browser, else says what to do', async () => {
    expect(await certificates().openCheck('R58')).toEqual({ browser: 'chrome' });
    expect(phone.started.at(-1)).toBe(
      '-a android.intent.action.VIEW -d http://wirescry.internal/ -p com.android.chrome',
    );
    phone.apps.delete('com.android.chrome');
    expect(await certificates().openCheck('R58')).toEqual({ browser: 'default' });
    expect(phone.started.at(-1)).toBe('-a android.intent.action.VIEW -d http://wirescry.internal/');
    phone.browser = false;
    await expect(certificates().openCheck('R58')).rejects.toThrow(
      'No browser on the device opened http://wirescry.internal/. Open it in a browser there.',
    );
  });

  it('counts am start as opened when Android only warns, or mentions an error mid-line', async () => {
    const answers: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
    const io: CertificateIo = {
      shell: async () => answers.shift() ?? { stdout: '', stderr: '', exitCode: 0 },
    };
    // Measured: an activity already running is brought to the front, with a warning, exit 0.
    answers.push({
      stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      stderr: 'Warning: Activity not started, its current task has been brought to the front\n',
      exitCode: 0,
    });
    expect(await certificates(io).openCheck('R58')).toEqual({ browser: 'chrome' });
    // "Error:" that doesn't start a line (inside an intent's data) isn't an error.
    answers.push({ stdout: 'Starting: Intent { dat=http://x.test/Error:1 }\n', stderr: '', exitCode: 0 });
    expect(await certificates(io).openCheck('R58')).toEqual({ browser: 'chrome' });
    // An error line on stdout (no separate stderr, as over older adb) is one.
    answers.push(
      { stdout: 'Error: Activity not started, unable to resolve Intent\n', stderr: '', exitCode: 0 },
      { stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n', stderr: '', exitCode: 0 },
    );
    expect(await certificates(io).openCheck('R58')).toEqual({ browser: 'default' });
  });

  it('isn’t fooled by Android 9’s am start, which exits 0 when nothing opened', async () => {
    phone.amExitsZeroOnError = true;
    phone.apps.delete('com.android.chrome');
    expect(await certificates().openCheck('R58')).toEqual({ browser: 'default' });
    phone.browser = false;
    await expect(certificates().openCheck('R58')).rejects.toThrow(/No browser on the device/);
    phone.apps.delete('com.android.settings');
    await expect(certificates().openInstalled('R58')).rejects.toThrow(/search for “Trusted credentials”/);
    expect(await certificates().send('R58', ca.cert)).toEqual({ settingsOpened: false });
    // Opened: no error, so it counts, as before.
    phone.apps.add('com.android.chrome');
    expect(await certificates().openCheck('R58')).toEqual({ browser: 'chrome' });
  });

  it('opens the user’s installed certificates, or says where to find them', async () => {
    await certificates().openInstalled('R58');
    expect(phone.started).toEqual(['-a com.android.settings.TRUSTED_CREDENTIALS_USER']);
    phone.apps.delete('com.android.settings');
    await expect(certificates().openInstalled('R58')).rejects.toThrow(/search for “Trusted credentials”/);
  });
});

describe('Remembering which devices trust which certificate', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  it('remembers across restarts, per device and certificate', async () => {
    const first = certificates();
    expect(await first.markTrusted(A, ca.spki)).toBe(true);
    expect(await first.markTrusted(A, ca.spki)).toBe(false);
    const next = certificates();
    await next.load();
    expect(next.trusted(A, ca.spki)).toBe(true);
    expect(next.trusted(A, other.spki)).toBe(false);
    expect(next.trusted(B, ca.spki)).toBe(false);
    // A new certificate replaces the old one for that device.
    await next.markTrusted(A, other.spki);
    expect(next.trusted(A, ca.spki)).toBe(false);
    expect(next.trusted(A, other.spki)).toBe(true);
  });

  it('ignores anything in the file that isn’t a device id and a fingerprint', async () => {
    const file = path.join(dir, 'trust.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        devices: { [A]: ca.spki, '../x': ca.spki, [B]: 'not a fingerprint', ['c'.repeat(32)]: 7 },
      }),
    );
    const loaded = certificates();
    await loaded.load();
    expect(loaded.trusted(A, ca.spki)).toBe(true);
    expect(loaded.trusted(B, 'not a fingerprint')).toBe(false);
    for (const content of ['{nope', JSON.stringify({ version: 2, devices: { [A]: ca.spki } }), 'null']) {
      await writeFile(file, content);
      const fresh = certificates();
      await fresh.load();
      expect(fresh.trusted(A, ca.spki)).toBe(false);
    }
    expect(await certificates().markTrusted('../x', ca.spki)).toBe(false);
  });

  it('forgets a device’s trust only for the certificate it was refused', async () => {
    const store = certificates();
    await store.markTrusted(A, ca.spki);
    expect(await store.forget(A, other.spki)).toBe(false);
    expect(store.trusted(A, ca.spki)).toBe(true);
    expect(await store.forget(A, ca.spki)).toBe(true);
    expect(store.trusted(A, ca.spki)).toBe(false);
    expect(await store.forget(A, ca.spki)).toBe(false);
    expect(await certificates().markTrusted(A, 'nope')).toBe(false);
  });

  it('forgets the oldest once it remembers 500 devices', async () => {
    const many = certificates();
    const id = (i: number) => i.toString(16).padStart(32, '0');
    for (let i = 0; i < 501; i++) await many.markTrusted(id(i), ca.spki);
    expect(many.trusted(id(0), ca.spki)).toBe(false);
    expect(many.trusted(id(1), ca.spki)).toBe(true);
    expect(many.trusted(id(500), ca.spki)).toBe(true);
    const saved = JSON.parse(await readFile(path.join(dir, 'trust.json'), 'utf8')) as {
      devices: Record<string, string>;
    };
    expect(Object.keys(saved.devices)).toHaveLength(500);
  });
});

describe('The SHA-256 Android shows', () => {
  it('is the whole certificate’s, in colon hex', () => {
    expect(certificateSha256(ca.cert)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(certificateSha256(ca.cert)).not.toBe(certificateSha256(other.cert));
  });
});

/** Listeners that hand out ports without proxying anything. */
function fakeListeners(): DeviceListeners {
  const opened = new Map<string, { source: ExchangeSource; port: number }>();
  let next = 9001;
  return {
    async open(source, port) {
      if (!opened.has(source.id)) opened.set(source.id, { source, port: port ?? next++ });
      return { port: opened.get(source.id)!.port };
    },
    async close(id) {
      opened.delete(id);
    },
    list: () => [...opened.values()].map((l) => ({ ...l, localAccess: false })),
    setLocalAccess() {},
    onPortChange: () => () => undefined,
  };
}

describe('Certificates through Android setup', () => {
  let current: { cert: string; spki: string };
  const started: AndroidSetup[] = [];
  afterEach(() => {
    for (const setup of started.splice(0)) setup.stop();
  });

  async function setup(withCertificates = true) {
    current = { cert: ca.cert, spki: ca.spki };
    const android = new AndroidSetup({
      endpoint: () => fake.endpoint,
      findAdb: () => undefined,
      retryDelaysMs: [30],
      timeoutMs: 1000,
      capture: {
        listeners: fakeListeners(),
        recordsDir: path.join(dir, 'records'),
        readBackMs: 200,
        pollMs: 60_000,
        ...(withCertificates ? { certificate: () => current, trustFile: path.join(dir, 'trust.json') } : {}),
      },
    });
    started.push(android);
    await android.start();
    const device = (): AndroidDevice | undefined => android.status().devices[0];
    await expect.poll(() => device()?.id).toBeTruthy();
    return { android, device, id: device()!.id! };
  }

  it('sends, says so, and removes the copy on Stop', async () => {
    const { android, device, id } = await setup();
    expect(device()!.certificate).toEqual({ trusted: false, sent: false });
    await android.captureDevice(id);
    expect(await android.sendCertificate(id)).toEqual({ settingsOpened: true });
    expect(device()!.certificate).toEqual({ trusted: false, sent: true });
    expect(phone.files.get(FILE)).toBe(ca.cert);
    await android.stopDevice(id);
    expect(phone.files.has(FILE)).toBe(false);
    expect(device()!.certificate).toEqual({ trusted: false, sent: false });
    expect(phone.settings.get('http_proxy')).toBe(':0');
  });

  it('checks only while capturing, since its listener answers the page', async () => {
    const { android, id } = await setup();
    await expect(android.checkCertificate(id)).rejects.toThrow('Capture the device first.');
    expect(phone.started).toEqual([]);
    await android.captureDevice(id);
    expect(await android.checkCertificate(id)).toEqual({ browser: 'chrome' });
    await android.showInstalledCertificates(id);
    expect(phone.started.at(-1)).toBe('-a com.android.settings.TRUSTED_CREDENTIALS_USER');
  });

  it('shows the device trusted once its check arrives, until the certificate changes', async () => {
    const { android, device, id } = await setup();
    await android.sendCertificate(id);
    await android.markTrusted(id, ca.spki);
    expect(device()!.certificate).toEqual({ trusted: true, sent: true });
    // A certificate reset: the copy and the trust are for the old one.
    current = other;
    android.certificateChanged();
    expect(device()!.certificate).toEqual({ trusted: false, sent: false });
  });

  it('ignores a check over the old certificate after a reset (a listener not yet restarted)', async () => {
    const { android, device, id } = await setup();
    current = other;
    android.certificateChanged();
    await android.markTrusted(id, ca.spki);
    expect(device()!.certificate!.trusted).toBe(false);
    await android.markTrusted(id, other.spki);
    expect(device()!.certificate!.trusted).toBe(true);
    // A late check over the old certificate doesn't replace trust in the new one.
    await android.markTrusted(id, ca.spki);
    expect(device()!.certificate!.trusted).toBe(true);
    // A refusal over the old certificate doesn't undo trust in the new one.
    await android.markUntrusted(id, ca.spki);
    expect(device()!.certificate!.trusted).toBe(true);
  });

  it('shows the device untrusted when its browser refuses the certificate later', async () => {
    const { android, device, id } = await setup();
    await android.markTrusted(id, ca.spki);
    await android.markUntrusted(id, ca.spki);
    expect(device()!.certificate!.trusted).toBe(false);
    const saved = JSON.parse(await readFile(path.join(dir, 'trust.json'), 'utf8')) as {
      devices: Record<string, string>;
    };
    expect(saved.devices).toEqual({});
  });

  it('shows Sending, and sends one at a time with Stop', async () => {
    const { android, device, id } = await setup();
    await android.captureDevice(id);
    const busyAtTee: unknown[] = [];
    phone.onCommand = (command) => {
      if (command.startsWith('tee')) busyAtTee.push(device()!.busy);
    };
    phone.commands = [];
    // Two sends at once: one after the other, never interleaved.
    await Promise.all([android.sendCertificate(id), android.sendCertificate(id)]);
    expect(busyAtTee).toEqual(['sending', 'sending']);
    // (Each action also reads the device again: getprop and settings, left out here.)
    const names = phone.commands
      .filter((c) => /^(am|tee|cat|rm) /.test(c))
      .map((c) => c.split(' ').slice(0, 2).join(' '));
    expect(names).toEqual([
      'am get-current-user',
      `tee ${FILE}`,
      `cat ${FILE}`,
      'am start',
      'am get-current-user',
      `tee ${FILE}`,
      `cat ${FILE}`,
      'am start',
    ]);
    // Send and Stop at once: the copy is gone afterwards, and not shown as sent.
    await Promise.all([android.sendCertificate(id).catch(() => undefined), android.stopDevice(id)]);
    expect(phone.files.has(FILE)).toBe(false);
    expect(device()!.certificate!.sent).toBe(false);
    expect(device()!.busy).toBeUndefined();
  });

  it('says to send again when the certificate changed on the way, and removes the old copy on Stop', async () => {
    const { android, device, id } = await setup();
    await android.captureDevice(id);
    phone.onCommand = (command) => {
      if (command.startsWith('cat')) {
        current = other;
        android.certificateChanged();
      }
    };
    await expect(android.sendCertificate(id)).rejects.toThrow(/changed while sending it. Send it again/);
    phone.onCommand = undefined;
    expect(device()!.certificate!.sent).toBe(false);
    expect(phone.files.get(FILE)).toBe(ca.cert);
    await android.stopDevice(id);
    expect(phone.files.has(FILE)).toBe(false);
  });

  it('removes a copy an earlier run left, on Restore', async () => {
    const first = await setup();
    await first.android.captureDevice(first.id);
    await first.android.sendCertificate(first.id);
    // Wirescry crashes: nothing put back.
    first.android.stop();
    const next = await setup();
    await expect.poll(() => next.device()?.leftover).toBe(true);
    await next.android.stopDevice(next.id);
    expect(phone.settings.get('http_proxy')).toBe(':0');
    expect(phone.files.has(FILE)).toBe(false);
  });

  it('removes the copies when quitting, after putting devices back', async () => {
    const { android, id } = await setup();
    await android.captureDevice(id);
    await android.sendCertificate(id);
    await android.stopAll(2000);
    expect(phone.settings.get('http_proxy')).toBe(':0');
    expect(phone.files.has(FILE)).toBe(false);
  });

  it('refuses devices that aren’t ready or supported, and works without certificates set up', async () => {
    phone.props['ro.build.version.sdk'] = '23';
    const { android, device, id } = await setup();
    await expect.poll(() => device()?.unsupported).toMatch(/Android 7/);
    await expect(android.sendCertificate(id)).rejects.toThrow(/Android 7/);
    await expect(android.sendCertificate('f'.repeat(32))).rejects.toThrow(/isn’t connected and ready/);
    expect(phone.files.size).toBe(0);
  });

  it('offers nothing about certificates when they aren’t set up', async () => {
    const { android, device, id } = await setup(false);
    expect(device()!.certificate).toBeUndefined();
    await expect(android.sendCertificate(id)).rejects.toThrow('Android capture is off.');
    await android.markTrusted(id, ca.spki);
    expect(device()!.certificate).toBeUndefined();
  });
});

describe('The trust check through the backend', () => {
  let backend: RunningBackend | undefined;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-certificates-backend-'));
  });
  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  const last = (messages: ServerMessage[]): ProxyStatus | undefined =>
    messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);

  it('marks the device trusted when its own listener gets the HTTPS check, and not for the main proxy', async () => {
    const endpoint = fake.endpoint;
    // It resets the certificate: a picked port, kept across the reset (see startBackendOnPickedPort).
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      android: { endpoint: () => endpoint, findAdb: () => undefined },
    });
    const api = await apiClient(backend.apiPort);
    try {
      const device = () => last(api.messages)?.android?.devices[0];
      await expect.poll(() => device()?.id).toBeTruthy();
      const id = device()!.id!;
      const pem = await readFile(backend.caCertPath, 'utf8');
      expect(last(api.messages)!.certificate.sha256).toBe(certificateSha256(pem));
      expect(device()!.certificate).toEqual({ trusted: false, sent: false });

      // Through the main proxy: this computer's browser, not the device.
      expect(
        (await requestViaProxy(backend.proxyPort, 'https://wirescry.internal:443/check', pem)).status,
      ).toBe(200);
      await api.send({ command: 'androidCapture', deviceId: id });
      await expect.poll(() => device()?.capture).toBeTruthy();
      expect(device()!.certificate!.trusted).toBe(false);

      await api.send({ command: 'androidSendCertificate', deviceId: id });
      expect(phone.files.get(FILE)).toBe(pem);
      // Plain HTTP proves nothing.
      expect((await httpViaProxy(device()!.capture!.hostPort, 'http://wirescry.internal/check')).status).toBe(
        400,
      );
      expect(device()!.certificate!.trusted).toBe(false);
      const check = await requestViaProxy(
        device()!.capture!.hostPort,
        'https://wirescry.internal:443/check',
        pem,
      );
      expect(check.status).toBe(200);
      await expect.poll(() => device()?.certificate?.trusted).toBe(true);
      // A client that doesn't trust the certificate refuses it on the way to the check: no longer trusted.
      await expect(
        requestViaProxy(device()!.capture!.hostPort, 'https://wirescry.internal:443/check', other.cert),
      ).rejects.toThrow();
      await expect.poll(() => device()?.certificate?.trusted).toBe(false);
      // Refusing another host's certificate says nothing about the check.
      expect(
        (await requestViaProxy(device()!.capture!.hostPort, 'https://wirescry.internal:443/check', pem))
          .status,
      ).toBe(200);
      await expect.poll(() => device()?.certificate?.trusted).toBe(true);
      await expect(
        requestViaProxy(device()!.capture!.hostPort, 'https://example.test:443/', other.cert),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(device()!.certificate!.trusted).toBe(true);

      // Remembered, and forgotten when the certificate changes.
      const saved = JSON.parse(await readFile(path.join(dataDir, 'android-trust.json'), 'utf8')) as {
        devices: Record<string, string>;
      };
      expect(saved.devices[id]).toBe(last(api.messages)!.certificate.spkiFingerprint);
      await api.send({ command: 'resetCertificate' });
      await expect.poll(() => device()?.certificate).toEqual({ trusted: false, sent: false });
      await api.send({ command: 'androidStop', deviceId: id });
    } finally {
      api.close();
    }
  });

  it('tells Android browsers to install from Settings, and others how to install it', async () => {
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      android: false,
    });
    const page = async (userAgent: string) =>
      (await httpViaProxy(backend!.proxyPort, 'http://wirescry.internal/', { 'user-agent': userAgent })).body;
    const android = await page(
      'Mozilla/5.0 (Linux; Android 17; sdk_gphone64_arm64) Chrome/150.0 Mobile Safari/537.36',
    );
    expect(android).toMatch(/install the certificate from Settings/);
    expect(android).not.toMatch(/Firefox|href="\/certificate"/);
    const firefox = await page('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/150.0');
    expect(firefox).toMatch(/href="\/certificate"/);
    expect(firefox).toMatch(/When Firefox asks/);
  });
});
