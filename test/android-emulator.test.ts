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
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findAdb } from '../src/backend/android/adb-server';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { AndroidDevice, ProxyStatus, ServerMessage } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const SERIAL = process.env.WIRESCRY_ANDROID_DEVICE;

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
      android: {},
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
          () =>
            exchangesIn(api.messages).find((e) => e.host === `127.0.0.1:${backend.apiPort}`)?.failure?.kind,
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
      expect(await adb('shell', 'settings', 'get', 'global', 'http_proxy')).toBe(before);
      expect(await adb('reverse', '--list')).toBe(rulesBefore);
    },
  );

  it('puts a capturing device back when Wirescry quits', { timeout: 60_000 }, async () => {
    const before = await adb('shell', 'settings', 'get', 'global', 'http_proxy');
    const id = device()!.id!;
    await api.send({ command: 'androidCapture', deviceId: id });
    await expect.poll(() => device()?.capture).toBeTruthy();
    api.close();
    await backend.stop();
    expect(await adb('shell', 'settings', 'get', 'global', 'http_proxy')).toBe(before);
    // Start again for afterAll.
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      android: {},
    });
    api = await apiClient(backend.apiPort);
  });
});
