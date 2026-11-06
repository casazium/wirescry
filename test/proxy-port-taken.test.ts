/** When the proxy's own port is taken while it restarts, Wirescry keeps a proxy running. */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ProxyStatus, ServerMessage } from '../src/shared/api';
import { apiClient, httpViaProxy, systemPickedPort, TOKEN, UI_ORIGIN } from './helpers';

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

it('moves to another port, and says so, when its own is taken during a certificate reset', async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-port-taken-'));
  const port = await systemPickedPort();
  backend = await startBackend({
    dataDir,
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    proxyPort: port,
    docker: false,
  });
  const api = await apiClient(backend.apiPort);
  // Something else grabs the port the moment it's free.
  thief = net.createServer();
  thief.on('error', () => undefined);
  let grabbing = true;
  const grab = (): void => {
    if (!grabbing || thief!.listening) return;
    thief!.listen(port, '127.0.0.1');
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
  expect((await httpViaProxy(moved, 'http://wirescry.internal/')).status).toBe(200);
  api.close();
});
