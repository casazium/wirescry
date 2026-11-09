/** Android setup inside the backend: on in the app unless turned off, and its devices in the status. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ProxyStatus, ServerMessage } from '../src/shared/api';
import { loadRecording, startFakeAdb, type FakeAdb } from './fake-adb';
import { apiClient, TOKEN, UI_ORIGIN } from './helpers';

let dataDir: string;
let backend: RunningBackend | undefined;
let fake: FakeAdb | undefined;
afterEach(async () => {
  await backend?.stop();
  backend = undefined;
  await fake?.close();
  fake = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const lastStatus = (messages: ServerMessage[]): ProxyStatus | undefined =>
  messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);

async function start(
  options: Parameters<typeof startBackend>[0]['android'],
  settings?: object,
): Promise<RunningBackend> {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-android-'));
  if (settings) await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  backend = await startBackend({
    dataDir,
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    docker: false,
    android: options,
  });
  return backend;
}

describe('Android setup in the backend', () => {
  it('is off, and absent from the status, unless turned on', async () => {
    const b = await start(undefined);
    const api = await apiClient(b.apiPort);
    expect(lastStatus(api.messages)?.android).toBeUndefined();
    await expect(api.send({ command: 'androidRefresh' })).rejects.toThrow('Android setup is off.');
    api.close();
  });

  it('shows devices in the status once on, and pushes changes', async () => {
    fake = await startFakeAdb({ recordings: [loadRecording('android-setup')] });
    const endpoint = fake.endpoint;
    const b = await start({ endpoint: () => endpoint, findAdb: () => undefined });
    const api = await apiClient(b.apiPort);
    await expect
      .poll(() => lastStatus(api.messages)?.android?.devices[0]?.label)
      .toBe('Medium Phone API 37.0');
    expect(lastStatus(api.messages)?.android).toMatchObject({ state: 'ready', serverVersion: 41 });
    api.close();
  });

  /** Points adb's environment at `port`, as a user's ADB_SERVER_SOCKET would. */
  async function withServerSocket(port: number, run: () => Promise<void>): Promise<void> {
    const saved = process.env.ADB_SERVER_SOCKET;
    process.env.ADB_SERVER_SOCKET = `tcp:127.0.0.1:${port}`;
    try {
      await run();
    } finally {
      if (saved === undefined) delete process.env.ADB_SERVER_SOCKET;
      else process.env.ADB_SERVER_SOCKET = saved;
    }
  }

  it('in the app, is on by default, finding the server the way adb does', async () => {
    fake = await startFakeAdb({ recordings: [loadRecording('android-setup')] });
    await withServerSocket(fake.endpoint.port, async () => {
      const b = await start('setting');
      const api = await apiClient(b.apiPort);
      await expect.poll(() => lastStatus(api.messages)?.android?.devices[0]?.apiLevel).toBe(37);
      api.close();
    });
  });

  it('in the app, says when no server is running, without starting one', async () => {
    const closed = await startFakeAdb({ recordings: [] });
    const port = closed.endpoint.port;
    await closed.close();
    await withServerSocket(port, async () => {
      const b = await start('setting');
      const api = await apiClient(b.apiPort);
      await expect.poll(() => lastStatus(api.messages)?.android?.state).toBe('no-server');
      api.close();
    });
  });

  it('in the app, is off with androidSetup: false, and ignores the old experimental setting', async () => {
    const b = await start('setting', { androidSetup: false, experimentalAndroid: true });
    const api = await apiClient(b.apiPort);
    expect(lastStatus(api.messages)?.android).toBeUndefined();
    await expect(api.send({ command: 'androidRefresh' })).rejects.toThrow('Android setup is off.');
    api.close();
  });

  it('stays off when left out, whatever the setting says (tests never reach a real server)', async () => {
    const b = await start(undefined, { androidSetup: true });
    const api = await apiClient(b.apiPort);
    expect(lastStatus(api.messages)?.android).toBeUndefined();
    api.close();
  });

  it('looks again on "Check again"', async () => {
    fake = await startFakeAdb({ recordings: [loadRecording('android-setup')] });
    const endpoint = fake.endpoint;
    const b = await start({ endpoint: () => endpoint, findAdb: () => undefined });
    const api = await apiClient(b.apiPort);
    await expect.poll(() => lastStatus(api.messages)?.android?.state).toBe('ready');
    const versionChecks = () => fake!.requests.filter((r) => r[0] === 'host:version').length;
    const before = versionChecks();
    await api.send({ command: 'androidRefresh' });
    expect(versionChecks()).toBe(before + 1);
    api.close();
  });
});
