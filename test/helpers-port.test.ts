/**
 * Picked ports (startBackendOnPickedPort, onPickedPort, startUpstreamOnPickedPort): a
 * system-picked port can be taken by another test file between being picked and being used (seen
 * on CI: EADDRINUSE starting the backend).
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getLocal } from 'mockttp';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import {
  apiClient,
  httpViaProxy,
  moveProxyToPickedPort,
  onPickedPort,
  PORT_TAKEN,
  portTaken,
  startBackendOnPickedPort,
  startUpstreamOnPickedPort,
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
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => holder.close(resolve)));
  return (holder.address() as net.AddressInfo).port;
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

  it('really picks ports from the system, free when picked', async () => {
    const port = await onPickedPort(async (port) => ((await portTaken(port)) ? PORT_TAKEN : port));
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
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
    expect(picked[0]).toBe(taken);
    expect(picked.at(-1)).toBe(port);
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

describe('Starting an upstream on a system-picked port', () => {
  /** Takes a port on every address, so another listen on every address fails. */
  async function holdEveryAddress(): Promise<number> {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, resolve));
    cleanup.push(() => new Promise((resolve) => holder.close(resolve)));
    return (holder.address() as net.AddressInfo).port;
  }

  /** Takes a port on 127.0.0.1 only, as another test file's proxy does, answering "the holder". */
  async function holdLoopbackAnswering(): Promise<number> {
    const holder = net.createServer((socket) => socket.end('the holder'));
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => holder.close(resolve)));
    return (holder.address() as net.AddressInfo).port;
  }

  /** What connecting to 127.0.0.1 on `port` reads first. */
  function firstWords(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('data', (data) => {
        resolve(String(data));
        socket.destroy();
      });
      socket.once('error', reject);
    });
  }

  /** Hands out `first`, then free ports. */
  const firstThenFree = (first: number) => {
    const picked: number[] = [];
    return {
      picked,
      pickPort: async () => {
        const port = picked.length === 0 ? first : await systemPickedPort();
        picked.push(port);
        return port;
      },
    };
  };

  // What the helper is for: on macOS and Windows, Mockttp's own listening doesn't fail on a port
  // another server holds on 127.0.0.1, and requests to 127.0.0.1 reach that server.
  it.skipIf(process.platform === 'linux')(
    'is needed: Mockttp listens beside a server holding 127.0.0.1, which then gets the requests',
    async () => {
      const held = await holdLoopbackAnswering();
      const upstream = getLocal();
      cleanup.push(() => upstream.stop());
      await upstream.start(held);
      expect(await firstWords(held)).toBe('the holder');
    },
  );

  it('listens on the port it gives, away from Mockttp’s own picks from 8000, and answers there', async () => {
    const upstream = getLocal();
    cleanup.push(() => upstream.stop());
    const port = await startUpstreamOnPickedPort(upstream);
    expect(upstream.port).toBe(port);
    expect(port).toBeGreaterThanOrEqual(10_000);
    await upstream.forGet('/here').thenReply(200, 'the upstream');
    for (const host of ['127.0.0.1', 'localhost']) {
      const response = await fetch(`http://${host}:${port}/here`);
      expect(await response.text()).toBe('the upstream');
    }
  });

  it('picks another port when the first is taken on every address', async () => {
    const { picked, pickPort } = firstThenFree(await holdEveryAddress());
    const upstream = getLocal();
    cleanup.push(() => upstream.stop());
    const port = await startUpstreamOnPickedPort(upstream, { pickPort });
    expect(picked).toHaveLength(2);
    expect(port).toBe(picked[1]);
    await upstream.forGet('/here').thenReply(200, 'the upstream');
    expect(await (await fetch(`http://127.0.0.1:${port}/here`)).text()).toBe('the upstream');
  });

  it('picks another port when the first is held on 127.0.0.1 alone, and the upstream gets its requests', async () => {
    const held = await holdLoopbackAnswering();
    const { picked, pickPort } = firstThenFree(held);
    const upstream = getLocal();
    cleanup.push(() => upstream.stop());
    const port = await startUpstreamOnPickedPort(upstream, { pickPort });
    expect(picked).toEqual([held, port]);
    expect(port).not.toBe(held);
    await upstream.forGet('/here').thenReply(200, 'the upstream');
    expect(await (await fetch(`http://127.0.0.1:${port}/here`)).text()).toBe('the upstream');
    expect(await firstWords(held)).toBe('the holder');
  });

  it.skipIf(process.platform === 'linux')(
    'stops the server again when 127.0.0.1 turns out taken once it listens',
    async () => {
      const held = await holdPort();
      const { picked, pickPort } = firstThenFree(held);
      const events: string[] = [];
      const server = {
        start: async (port?: number | { startPort: number; endPort: number }) => {
          events.push(`start ${String(port)}`);
        },
        stop: async () => {
          events.push('stop');
        },
      };
      const port = await startUpstreamOnPickedPort(server, { pickPort });
      expect(picked).toEqual([held, port]);
      expect(events).toEqual([`start ${held}`, 'stop', `start ${port}`]);
    },
  );

  it('tries another port when Mockttp finds its port in use', async () => {
    const ports: number[] = [];
    const server = {
      start: async (port?: number | { startPort: number; endPort: number }) => {
        ports.push(port as number);
        if (ports.length === 1) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
      },
      stop: async () => {
        throw new Error('nothing to stop');
      },
    };
    const port = await startUpstreamOnPickedPort(server);
    expect(ports).toHaveLength(2);
    expect(port).toBe(ports[1]);
  });

  it('gives up when the port is taken every time', async () => {
    const taken = await holdEveryAddress();
    let tries = 0;
    const pickPort = async () => {
      tries += 1;
      return taken;
    };
    const upstream = getLocal();
    // Never started, so there's nothing to stop.
    cleanup.push(() => upstream.stop().catch(() => undefined));
    await expect(startUpstreamOnPickedPort(upstream, { attempts: 2, pickPort })).rejects.toThrow(
      'The picked port was taken 2 times in a row',
    );
    expect(tries).toBe(2);
  });

  it('doesn’t try again when starting fails for another reason', async () => {
    let starts = 0;
    const server = {
      start: async () => {
        starts += 1;
        throw Object.assign(new Error('no permission'), { code: 'EACCES' });
      },
      stop: async () => undefined,
    };
    await expect(startUpstreamOnPickedPort(server)).rejects.toThrow('no permission');
    expect(starts).toBe(1);
  });
});

/**
 * Test files whose upstreams must start on a picked port (startUpstreamOnPickedPort), not on
 * Mockttp's own pick from 8000. A flake there is rare, so no test run would catch a file going
 * back; this reads the source instead.
 */
const UPSTREAMS_ON_PICKED_PORTS = ['mcp-backend.test.ts'];

/** Each `start()` with no port in `source`, as its line number: Mockttp's own pick from 8000. */
function startsWithoutAPort(source: string): number[] {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'start' &&
      node.arguments.length === 0
    ) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe('Upstreams on picked ports', () => {
  it('finds a start() with no port, and nothing else', () => {
    const source = [
      'await upstream.start();',
      'await startUpstreamOnPickedPort(upstream);',
      'await other.start(8080);',
      '// upstream.start() in a comment',
      "const text = 'upstream.start()';",
      'await (await make()).start();',
    ].join('\n');
    expect(startsWithoutAPort(source)).toEqual([1, 6]);
  });

  it('covers mcp-backend.test.ts, where the flake was seen', () => {
    expect(UPSTREAMS_ON_PICKED_PORTS).toContain('mcp-backend.test.ts');
  });

  it.each(UPSTREAMS_ON_PICKED_PORTS)('%s starts no server on Mockttp’s own pick', (name) => {
    const source = readFileSync(path.join(import.meta.dirname, name), 'utf8');
    expect(source).toContain('startUpstreamOnPickedPort(');
    expect(startsWithoutAPort(source)).toEqual([]);
  });
});
