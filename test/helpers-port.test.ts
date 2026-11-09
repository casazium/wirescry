/**
 * startBackendOnPickedPort: a system-picked port can be taken by another test file between being
 * picked and the backend listening on it (seen on CI: EADDRINUSE starting the backend).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { httpViaProxy, startBackendOnPickedPort, systemPickedPort, TOKEN, UI_ORIGIN } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Takes a port, as another test file would after systemPickedPort let it go. */
async function holdPort(): Promise<number> {
  const port = await systemPickedPort();
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => holder.close(resolve)));
  return port;
}

async function newDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-picked-port-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const options = (dataDir: string) => ({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });

describe('Starting a backend on a system-picked port', () => {
  it('is needed: a picked port taken before the backend listens stops it starting', async () => {
    const taken = await holdPort();
    await expect(startBackend({ ...options(await newDataDir()), proxyPort: taken })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('picks another port when the first was taken, and the backend works on it', async () => {
    const taken = await holdPort();
    const picked: number[] = [];
    const backend: RunningBackend = await startBackendOnPickedPort(options(await newDataDir()), {
      pickPort: async () => {
        const port = picked.length === 0 ? taken : await systemPickedPort();
        picked.push(port);
        return port;
      },
    });
    cleanup.push(() => backend.stop());
    expect(picked).toHaveLength(2);
    expect(backend.proxyPort).toBe(picked[1]);
    expect(backend.proxyPort).not.toBe(taken);
    expect((await httpViaProxy(backend.proxyPort, 'http://wirescry.internal/')).status).toBe(200);
  });

  it('gives up after so many tries, with the last error', async () => {
    const taken = await holdPort();
    let picks = 0;
    await expect(
      startBackendOnPickedPort(options(await newDataDir()), {
        attempts: 3,
        pickPort: async () => {
          picks += 1;
          return taken;
        },
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(picks).toBe(3);
  });

  it('doesn’t try again for any other failure', async () => {
    // A data folder that's a file: the backend can't start, and a new port won't help.
    const dir = await newDataDir();
    const file = path.join(dir, 'not-a-folder');
    await writeFile(file, 'x');
    let picks = 0;
    const failure = await startBackendOnPickedPort(options(file), {
      pickPort: async () => {
        picks += 1;
        return systemPickedPort();
      },
    }).catch((error: NodeJS.ErrnoException) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException).code).not.toBe('EADDRINUSE');
    expect(picks).toBe(1);
  });
});
