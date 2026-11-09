/**
 * A fixed proxy port another program already listens on. Measured on macOS: Mockttp's listen on
 * all addresses (::) succeeds even when another program has 127.0.0.1 or 0.0.0.0 on that port,
 * and that program then answers 127.0.0.1, where Wirescry's users send their traffic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { httpViaProxy, systemPickedPort, TOKEN, UI_ORIGIN } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Another program listening on `host`, on a port of its own; undefined if this system can't. */
async function holder(host: string | undefined): Promise<number | undefined> {
  const port = await systemPickedPort();
  const server = net.createServer((socket) =>
    socket.end('HTTP/1.1 418 Not Wirescry\r\nContent-Length: 0\r\n\r\n'),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host }, () => resolve());
    });
  } catch {
    return undefined;
  }
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return port;
}

async function startOn(port: number): Promise<RunningBackend> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-fixed-port-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const backend = await startBackend({
    dataDir,
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    docker: false,
    proxyPort: port,
  });
  cleanup.push(() => backend.stop());
  return backend;
}

describe('A fixed proxy port another program listens on', () => {
  it.each(['127.0.0.1', '0.0.0.0'])('is refused when it holds %s', async (host) => {
    const port = await holder(host);
    expect(port).toBeDefined();
    await expect(startOn(port!)).rejects.toMatchObject({ code: 'EADDRINUSE', port });
  });

  it.each([undefined, '::', '::1', 'localhost'])(
    'is refused when it holds %s, or Wirescry gets 127.0.0.1 itself',
    async (host) => {
      const port = await holder(host);
      if (port === undefined) return; // No IPv6 here.
      const started = await startOn(port).catch((error: NodeJS.ErrnoException) => error);
      if (started instanceof Error) {
        expect(started).toMatchObject({ code: 'EADDRINUSE' });
        return;
      }
      // Never the other program: Wirescry's own page answers.
      expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);
    },
  );

  it('starts on a free one, and serves 127.0.0.1', async () => {
    const port = await systemPickedPort();
    const backend = await startOn(port);
    expect(backend.proxyPort).toBe(port);
    expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);
  });
});
