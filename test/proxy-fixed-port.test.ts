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
import { httpViaProxy, onPickedPort, PORT_TAKEN, TOKEN, UI_ORIGIN } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Another program listening on `host`, on a port of its own; undefined if this system can't. */
async function holder(host: string | undefined): Promise<number | undefined> {
  const server = net.createServer((socket) =>
    socket.end('HTTP/1.1 418 Not Wirescry\r\nContent-Length: 0\r\n\r\n'),
  );
  // A port free on 127.0.0.1, so the proxy's own check is all that stops it there.
  const port = await onPickedPort(
    (port) =>
      new Promise<number | typeof PORT_TAKEN | undefined>((resolve) => {
        server.once('error', (error: NodeJS.ErrnoException) =>
          resolve(error.code === 'EADDRINUSE' ? PORT_TAKEN : undefined),
        );
        server.listen({ port, host }, () => resolve(port));
      }),
  );
  if (port !== undefined) cleanup.push(() => new Promise((resolve) => server.close(resolve)));
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
      // On macOS, all addresses includes 0.0.0.0, which the check refuses.
      if (process.platform === 'darwin' && (host === undefined || host === '::')) {
        expect(started).toMatchObject({ code: 'EADDRINUSE', port });
      }
      if (started instanceof Error) {
        expect(started).toMatchObject({ code: 'EADDRINUSE' });
        return;
      }
      // Never the other program: Wirescry's own page answers.
      expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);
    },
  );

  it('on macOS, isn’t refused for a program on a network address, which doesn’t take 127.0.0.1', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (!lan) return; // No network address here.
    const port = await holder(lan);
    if (port === undefined) return;
    const started = await startOn(port).catch((error: NodeJS.ErrnoException) => error);
    // Linux won't listen on all addresses beside a specific one, so Wirescry can't have the port
    // there (as before this check). macOS allows it, and must not refuse.
    if (started instanceof Error) {
      expect(process.platform).not.toBe('darwin');
      expect(started).toMatchObject({ code: 'EADDRINUSE' });
      return;
    }
    expect(started.proxyPort).toBe(port);
    expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);
  });

  it('starts on a free one, and serves 127.0.0.1', async () => {
    const backend = await onPickedPort(async (port) => {
      try {
        return await startOn(port);
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { port?: number };
        if (failure.code === 'EADDRINUSE' && failure.port === port) return PORT_TAKEN;
        throw error;
      }
    });
    const port = backend.proxyPort;
    expect(backend.proxyPort).toBe(port);
    expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);
  });
});
