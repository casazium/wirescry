/**
 * Capture end to end on a real emulator or phone, through the real ADB server. Skipped unless
 * WIRESCRY_ANDROID_DEVICE names a connected device's serial, e.g.:
 *
 *   WIRESCRY_ANDROID_DEVICE=emulator-5554 npx vitest run test/android-emulator.test.ts
 *
 * It changes the device's global proxy while it runs and puts it back; leave nothing else
 * capturing that device. Requests from the device go through toybox nc, whose input is kept
 * open: on end of input it half-closes, which the proxy takes as the client leaving.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adbEndpoint, adbReverse } from '../src/backend/android/adb-client';
import { findAdb } from '../src/backend/android/adb-server';
import type { CaptureRecord } from '../src/backend/android/capture';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { AndroidDevice, ProxyStatus, ServerMessage } from '../src/shared/api';
import { apiClient, exchangesIn, latestExchange, TOKEN, UI_ORIGIN } from './helpers';

/** TLS alert record: fatal, unknown_ca (RFC 5246 §7.2), in the clear as TLS 1.2 handshakes send it. */
const UNKNOWN_CA_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x30]);

/** The ClientHello Node sends for a TLS 1.2 connection to `servername`. */
function clientHello(servername: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const capture = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        resolve(Buffer.from(chunk));
        // Written during tls.connect itself, before `client` is set.
        setImmediate(() => client.destroy());
        done();
      },
    });
    const client = tls.connect({ socket: capture, servername, maxVersion: 'TLSv1.2' });
    client.on('error', () => undefined);
  });
}

const SERIAL = process.env.WIRESCRY_ANDROID_DEVICE;
/** Checks the tunnel often, so a lost one comes back within the test. */
const ANDROID = { capture: { pollMs: 500, graceMs: 3000 } };
// Stop clears the proxy with ':0'; a fresh device starts with the setting unset ('null'). Both mean no proxy.
const noProxy = (value: string): string => (['', 'null', ':0'].includes(value) ? ':0' : value);

describe.skipIf(!SERIAL)('Capture on a real device', () => {
  const adbPath = findAdb() ?? 'adb';
  // Async on purpose: the backend runs in this process, and a synchronous call would stop it
  // answering the very requests the device sends.
  const run = promisify(execFile);
  const adb = async (...args: string[]): Promise<string> =>
    (await run(adbPath, ['-s', SERIAL!, ...args], { timeout: 60_000 })).stdout.trim();
  /** Sends an HTTP request from the device through its proxy port; returns the status line. */
  const fromDevice = (port: number, url: string, host: string, waitSeconds = 10): Promise<string> =>
    adb(
      'shell',
      `(printf 'GET ${url} HTTP/1.1\\r\\nHost: ${host}\\r\\n\\r\\n'; sleep ${waitSeconds}) | nc 127.0.0.1 ${port} | head -1`,
    );

  let dataDir: string;
  let backend: RunningBackend;
  let api: Awaited<ReturnType<typeof apiClient>>;
  const last = (messages: ServerMessage[]): ProxyStatus | undefined =>
    messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);
  const device = (): AndroidDevice | undefined =>
    last(api.messages)?.android?.devices.find((d) => d.serial === SERIAL);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-device-'));
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      android: ANDROID,
    });
    api = await apiClient(backend.apiPort);
    // Not expect.poll: that only works inside a test.
    for (let waited = 0; !device()?.id; waited += 200) {
      if (waited > 30_000) throw new Error(`${SERIAL} didn't show up in Wirescry's device list.`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60_000);
  afterAll(async () => {
    api?.close();
    await backend?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it(
    'captures, records the device’s traffic with it, blocks this computer, and puts it all back',
    { timeout: 120_000 },
    async () => {
      const before = await adb('shell', 'settings', 'get', 'global', 'http_proxy');
      const rulesBefore = await adb('reverse', '--list');
      const id = device()!.id!;
      expect(await api.send({ command: 'androidCapture', deviceId: id })).toEqual({});
      await expect.poll(() => device()?.capture).toBeTruthy();
      const { devicePort } = device()!.capture!;
      expect(await adb('shell', 'settings', 'get', 'global', 'http_proxy')).toBe(`127.0.0.1:${devicePort}`);
      // On Android 11+, the device's end of the tunnel listens on its own loopback only.
      if ((device()!.apiLevel ?? 0) >= 30) {
        const listening = (await adb('shell', `ss -ltn 2>/dev/null | grep ':${devicePort} '`)).trim();
        expect(listening).toMatch(new RegExp(`127\\.0\\.0\\.1:${devicePort}\\s`));
        expect(listening).not.toMatch(new RegExp(`\\*:${devicePort}\\s`));
      }

      // Answered by Wirescry itself: proves the tunnel without the internet.
      expect(await fromDevice(devicePort, 'http://wirescry.internal/', 'wirescry.internal', 4)).toMatch(
        /^HTTP\/1\.1 200/,
      );
      // This computer is out of reach by default.
      expect(await fromDevice(devicePort, `http://127.0.0.1:${backend.apiPort}/`, '127.0.0.1', 4)).toMatch(
        /^HTTP\/1\.1 403/,
      );
      await expect
        .poll(
          () => latestExchange(api.messages, (e) => e.host === `127.0.0.1:${backend.apiPort}`)?.failure?.kind,
        )
        .toBe('blocked');
      expect(exchangesIn(api.messages).find((e) => e.host === 'wirescry.internal')?.source).toEqual({
        kind: 'android',
        id,
        label: device()!.label,
      });
      // With the switch on, it can.
      await api.send({ command: 'androidSetLocalAccess', deviceId: id, allowed: true });
      await expect.poll(() => device()?.capture?.localAccess).toBe(true);
      expect(
        await fromDevice(devicePort, `http://127.0.0.1:${backend.apiPort}/`, '127.0.0.1', 4),
      ).not.toMatch(/ 403 /);

      await api.send({ command: 'androidStop', deviceId: id });
      await expect.poll(() => device()?.capture).toBeUndefined();
      expect(noProxy(await adb('shell', 'settings', 'get', 'global', 'http_proxy'))).toBe(noProxy(before));
      expect(await adb('reverse', '--list')).toBe(rulesBefore);
    },
  );

  it('adds back a tunnel removed from under it, and after a reconnect', { timeout: 120_000 }, async () => {
    const id = device()!.id!;
    await api.send({ command: 'androidCapture', deviceId: id });
    await expect.poll(() => device()?.capture).toBeTruthy();
    const { devicePort, hostPort } = device()!.capture!;
    const ours = `tcp:${devicePort} tcp:${hostPort}`;
    const rules = () => adb('reverse', '--list').catch(() => '');

    // Another tool removes it (only ours: a developer's own rules stay).
    await adb('reverse', '--remove', `tcp:${devicePort}`);
    await expect.poll(rules, { timeout: 10_000, interval: 250 }).toContain(ours);
    expect(await fromDevice(devicePort, 'http://wirescry.internal/', 'wirescry.internal', 4)).toMatch(
      /^HTTP\/1\.1 200/,
    );

    // A reconnect drops adbd's reverse rules (measured): it comes back, on the same port.
    await adb('reconnect');
    await expect.poll(rules, { timeout: 30_000, interval: 500 }).toContain(ours);
    expect(device()?.capture?.devicePort).toBe(devicePort);
    expect(await fromDevice(devicePort, 'http://wirescry.internal/', 'wirescry.internal', 4)).toMatch(
      /^HTTP\/1\.1 200/,
    );
    expect(last(api.messages)?.android?.notConnected).toBeUndefined();

    await api.send({ command: 'androidStop', deviceId: id });
    await expect.poll(() => device()?.capture).toBeUndefined();
    expect(await rules()).not.toContain(`tcp:${devicePort}`);
  });

  it(
    'resumes a capture a crashed run left, replacing the rule that led to its old listener',
    { timeout: 120_000 },
    async () => {
      const before = await adb('shell', 'settings', 'get', 'global', 'http_proxy');
      const id = device()!.id!;
      const apiLevel = device()!.apiLevel!;
      // What a crash leaves while the device stays plugged in: a record, a rule to a listener
      // that's gone, and the device's proxy still on the tunnel. The old listener's port is
      // taken now, so Resume has to move to another one.
      // Drops what connects, as nothing answers there: an open connection would keep close() waiting.
      const taken = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
      const oldPort = (taken.address() as net.AddressInfo).port;
      const inUse = await adb('reverse', '--list');
      let devicePort = 40_000;
      while (inUse.includes(`tcp:${devicePort} `)) devicePort++;
      const loopbackOnly = apiLevel >= 30;
      const recordsDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-records-'));
      const otherDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-device-2-'));
      let other: RunningBackend | undefined;
      let otherApi: Awaited<ReturnType<typeof apiClient>> | undefined;
      try {
        await adbReverse(adbEndpoint(), SERIAL!, devicePort, oldPort, { loopbackOnly });
        await adb('shell', 'settings', 'put', 'global', 'http_proxy', `127.0.0.1:${devicePort}`);
        const record: CaptureRecord = {
          version: 1,
          id,
          label: device()!.label,
          previousProxy: [':0', '', 'null'].includes(before) ? null : before,
          devicePort,
          hostPort: oldPort,
          loopbackOnly,
          startedAt: new Date().toISOString(),
        };
        await writeFile(path.join(recordsDir, `${id}.json`), JSON.stringify(record));

        other = await startBackend({
          dataDir: otherDir,
          token: TOKEN,
          allowedOrigins: [UI_ORIGIN],
          docker: false,
          android: { capture: { ...ANDROID.capture, recordsDir } },
        });
        otherApi = await apiClient(other.apiPort);
        const api2 = otherApi;
        const there = (): AndroidDevice | undefined =>
          last(api2.messages)?.android?.devices.find((d) => d.serial === SERIAL);
        await expect.poll(() => there()?.leftover, { timeout: 30_000 }).toBe(true);
        // Until Resume, the device's traffic reaches nothing that answers.
        expect(await fromDevice(devicePort, 'http://wirescry.internal/', 'wirescry.internal', 1)).toBe('');
        await api2.send({ command: 'androidResume', deviceId: id });
        await expect.poll(() => there()?.capture).toBeTruthy();
        const { hostPort } = there()!.capture!;
        expect(hostPort).not.toBe(oldPort);
        expect(there()!.capture!.devicePort).toBe(devicePort);
        const rules = await adb('reverse', '--list');
        expect(rules).toContain(`tcp:${devicePort} tcp:${hostPort}`);
        expect(rules).not.toContain(`tcp:${oldPort}`);
        expect(await fromDevice(devicePort, 'http://wirescry.internal/', 'wirescry.internal', 4)).toMatch(
          /^HTTP\/1\.1 200/,
        );
        await expect
          .poll(() => exchangesIn(api2.messages).find((e) => e.host === 'wirescry.internal')?.source?.id)
          .toBe(id);
        await api2.send({ command: 'androidStop', deviceId: id });
        expect(noProxy(await adb('shell', 'settings', 'get', 'global', 'http_proxy'))).toBe(noProxy(before));
        expect(await adb('reverse', '--list')).toBe(inUse);
        expect(await readdir(recordsDir)).toEqual([]);
      } finally {
        otherApi?.close();
        await other?.stop();
        // Whatever happened, leave the device as it was.
        if (noProxy(await adb('shell', 'settings', 'get', 'global', 'http_proxy')) !== noProxy(before))
          await adb('shell', 'settings', 'put', 'global', 'http_proxy', noProxy(before));
        await adb('reverse', '--remove', `tcp:${devicePort}`).catch(() => undefined);
        await new Promise((resolve) => taken.close(resolve));
        await rm(recordsDir, { recursive: true, force: true });
        await rm(otherDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'copies the certificate to Downloads intact, opens Security settings, and removes it on Stop',
    { timeout: 60_000 },
    async () => {
      const id = device()!.id!;
      const user = (await adb('shell', 'am', 'get-current-user')).trim() || '0';
      const file = `/storage/emulated/${user}/Download/Wirescry-CA.crt`;
      const pem = await readFile(backend.caCertPath, 'utf8');
      await api.send({ command: 'androidCapture', deviceId: id });
      await expect.poll(() => device()?.capture).toBeTruthy();
      expect(await api.send({ command: 'androidSendCertificate', deviceId: id })).toEqual({
        settingsOpened: true,
      });
      expect(await adb('shell', 'cat', file)).toBe(pem.trim());
      await expect.poll(() => device()?.certificate?.sent).toBe(true);
      await api.send({ command: 'androidStop', deviceId: id });
      await expect.poll(() => device()?.capture).toBeUndefined();
      expect(await adb('shell', `ls ${file} 2>/dev/null || echo gone`)).toBe('gone');
      await adb('shell', 'input', 'keyevent', 'HOME');
    },
  );

  it(
    'shows the hosts of connections that refuse the certificate, until Stop',
    { timeout: 60_000 },
    async () => {
      const id = device()!.id!;
      // What a TLS client refusing the certificate sends, as Android's do (measured:
      // cert-rejected): a TLS 1.2 ClientHello naming the host, then the unknown_ca alert once the
      // proxy has answered. Sent from the device's shell, through its proxy port and tunnel.
      const host = 'refused.wirescry.test';
      const hello = await clientHello(host);
      const octal = (bytes: Buffer): string =>
        [...bytes].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('');
      await api.send({ command: 'androidCapture', deviceId: id });
      try {
        await expect.poll(() => device()?.capture).toBeTruthy();
        const { devicePort } = device()!.capture!;
        await adb(
          'shell',
          `(printf 'CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n'; sleep 1; ` +
            `printf '${octal(hello)}'; sleep 2; printf '${octal(UNKNOWN_CA_ALERT)}'; sleep 1) | ` +
            `nc 127.0.0.1 ${devicePort} > /dev/null`,
        );
        await expect
          .poll(() => device()?.refused?.hosts.map((h) => h.host), { timeout: 20_000 })
          .toContain(host);
      } finally {
        await api.send({ command: 'androidStop', deviceId: id });
      }
      await expect.poll(() => device()?.capture).toBeUndefined();
      expect(device()?.refused).toBeUndefined();
    },
  );

  it('puts a capturing device back when Wirescry quits', { timeout: 60_000 }, async () => {
    const before = await adb('shell', 'settings', 'get', 'global', 'http_proxy');
    const id = device()!.id!;
    await api.send({ command: 'androidCapture', deviceId: id });
    await expect.poll(() => device()?.capture).toBeTruthy();
    api.close();
    await backend.stop();
    expect(noProxy(await adb('shell', 'settings', 'get', 'global', 'http_proxy'))).toBe(noProxy(before));
    // Start again for afterAll.
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      android: ANDROID,
    });
    api = await apiClient(backend.apiPort);
  });
});
