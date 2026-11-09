/**
 * startBackendOnPickedPort and onPickedPort: a system-picked port can be taken by another test file between being
 * picked and the backend listening on it (seen on CI: EADDRINUSE starting the backend).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import {
  apiClient,
  httpViaProxy,
  moveProxyToPickedPort,
  onPickedPort,
  PORT_TAKEN,
  startBackendOnPickedPort,
  systemPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

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

  it('doesn’t try again for a port in use that isn’t the proxy’s', async () => {
    let picks = 0;
    const other = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:1234'), {
      code: 'EADDRINUSE',
      port: 1234,
    });
    await expect(
      startBackendOnPickedPort(options(await newDataDir()), {
        pickPort: async () => {
          picks += 1;
          return 40000 + picks;
        },
        start: async () => {
          throw other;
        },
      }),
    ).rejects.toBe(other);
    expect(picks).toBe(1);
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

describe('Using a system-picked port', () => {
  /** Hands out the given ports in turn. */
  const ports = (...list: number[]) => {
    const picked: number[] = [];
    return {
      picked,
      pickPort: async () => {
        const port = list[picked.length];
        if (port === undefined) throw new Error('Out of ports');
        picked.push(port);
        return port;
      },
    };
  };

  it('gives what the attempt gives, on the first port when it was free', async () => {
    const { picked, pickPort } = ports(41000, 41001);
    expect(await onPickedPort(async (port) => `used ${port}`, { pickPort })).toBe('used 41000');
    expect(picked).toEqual([41000]);
  });

  it('tries another port each time the attempt finds it taken', async () => {
    const { picked, pickPort } = ports(41000, 41001, 41002);
    const seen: number[] = [];
    const result = await onPickedPort(
      async (port) => {
        seen.push(port);
        return port === 41002 ? port : PORT_TAKEN;
      },
      { pickPort },
    );
    expect(result).toBe(41002);
    expect(seen).toEqual([41000, 41001, 41002]);
    expect(picked).toEqual(seen);
  });

  it('gives up when the port is taken every time', async () => {
    let tries = 0;
    await expect(
      onPickedPort(
        async () => {
          tries += 1;
          return PORT_TAKEN;
        },
        { attempts: 3 },
      ),
    ).rejects.toThrow('The picked port was taken 3 times in a row');
    expect(tries).toBe(3);
  });

  it('doesn’t try again when the attempt fails for another reason', async () => {
    let tries = 0;
    await expect(
      onPickedPort(async () => {
        tries += 1;
        throw new Error('something else');
      }),
    ).rejects.toThrow('something else');
    expect(tries).toBe(1);
  });

  it('really picks ports from the system, each one free when picked', async () => {
    const seen: number[] = [];
    await onPickedPort(async (port) => {
      seen.push(port);
      // Free: this test can listen on it.
      const server = net.createServer();
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(port, '127.0.0.1', resolve),
      );
      await new Promise((resolve) => server.close(resolve));
      return seen.length < 2 ? PORT_TAKEN : port;
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('Moving the proxy to a system-picked port', () => {
  async function backendForTest(): Promise<RunningBackend> {
    const backend = await startBackendOnPickedPort({
      dataDir: await newDataDir(),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
    });
    cleanup.push(() => backend.stop());
    return backend;
  }

  it('moves on from a port another test file took, and the proxy works on the next', async () => {
    const backend = await backendForTest();
    const api = await apiClient(backend.apiPort);
    cleanup.push(async () => api.close());
    const taken = await holdPort();
    const picked: number[] = [];
    const port = await moveProxyToPickedPort(api, {
      pickPort: async () => {
        const next = picked.length === 0 ? taken : await systemPickedPort();
        picked.push(next);
        return next;
      },
    });
    expect(picked).toEqual([taken, port]);
    expect(backend.proxyPort).toBe(port);
    expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);
  });

  it('doesn’t try again when the move fails for another reason', async () => {
    const backend = await backendForTest();
    const api = await apiClient(backend.apiPort);
    cleanup.push(async () => api.close());
    const before = backend.proxyPort;
    let picks = 0;
    await expect(
      moveProxyToPickedPort(api, {
        pickPort: async () => {
          picks += 1;
          return 80; // Below 1024: refused whether or not it's free.
        },
      }),
    ).rejects.toThrow('1024 to 65535');
    expect(picks).toBe(1);
    expect(backend.proxyPort).toBe(before);
  });
});
