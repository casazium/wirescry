/**
 * When the proxy's own port is taken while it restarts, Wirescry keeps a proxy running, and tells
 * Java agents where.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import type { ProxyStatus, ServerMessage } from '../src/shared/api';
import { apiClient, httpViaProxy, startBackendOnPickedPort, TOKEN, UI_ORIGIN } from './helpers';

let dataDir: string | undefined;
let backend: RunningBackend | undefined;
let thief: net.Server | undefined;
afterEach(async () => {
  await backend?.stop();
  if (thief?.listening) await new Promise((resolve) => thief!.close(resolve));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const last = (messages: ServerMessage[]): ProxyStatus | undefined =>
  messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);

// A thief on 0.0.0.0 shares the port with the proxy on macOS unless the proxy checks for it.
it.each(['127.0.0.1', '0.0.0.0'])(
  'moves to another port, and says so, when %s on its own is taken during a certificate reset',
  async (host) => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-port-taken-'));
    // Stand-ins for the Java agent's jars: only the control file matters here.
    const jarDir = path.join(dataDir, 'built');
    await mkdir(jarDir);
    const jars = { stub: '', impl: '', weaver: '' };
    for (const part of ['stub', 'impl', 'weaver'] as const) {
      jars[part] = path.join(jarDir, `${part}.jar`);
      await writeFile(jars[part], part);
    }
    const controlPort = async () =>
      /^proxyPort=(\d+)$/m.exec(
        await readFile(path.join(dataDir!, 'java-agent', 'control.properties'), 'utf8').catch(() => ''),
      )?.[1];
    // Picked by the system, so no other test file wants it, and retried if one takes it first.
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      javaAgent: { jars },
    });
    const port = backend.proxyPort;
    await expect.poll(controlPort).toBe(String(port));
    const api = await apiClient(backend.apiPort);
    // Something else grabs the port the moment it's free.
    thief = net.createServer();
    thief.on('error', () => undefined);
    let grabbing = true;
    const grab = (): void => {
      if (!grabbing || thief!.listening) return;
      thief!.listen(port, host);
      setImmediate(grab);
    };
    thief.once('listening', () => (grabbing = false));
    grab();
    const result = await api.send({ command: 'resetCertificate' }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    grabbing = false;
    if (!thief.listening) {
      // The proxy got its port back first this time: nothing to test.
      api.close();
      return;
    }
    expect(result).toMatch(
      new RegExp(`Port ${port} was taken while the proxy restarted, so it's on port \\d+ now`),
    );
    const moved = backend.proxyPort;
    expect(moved).not.toBe(port);
    await expect.poll(() => last(api.messages)?.proxyPort).toBe(moved);
    expect(await controlPort()).toBe(String(moved));
    expect((await httpViaProxy(moved, 'http://wirescry.internal/')).status).toBe(200);
    api.close();
  },
);
