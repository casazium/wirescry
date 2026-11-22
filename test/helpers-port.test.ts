/**
 * Picked ports (startBackendOnPickedPort, onPickedPort, startUpstreamOnPickedPort): a
 * system-picked port can be taken by another test file between being picked and being used (seen
 * on CI: EADDRINUSE starting the backend).
 */
import { readdirSync, readFileSync } from 'node:fs';
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
 * The Mockttp servers that `source` starts on Mockttp's own pick from 8000 (`start()`,
 * `start(undefined)` or a range), as "line: code". It knows a server by its name: a variable,
 * parameter or class field typed `Mockttp` or given a `getLocal(…)` (through `as`, `!` or
 * brackets too), or a `getLocal(…)` started in place. Other things with a `start()` (the Android
 * setup, the backend supervisor) aren't Mockttp. Names aren't scoped, and servers passed around in
 * other ways (factories, arrays, aliases) aren't followed. A collision is rare, so no test run would
 * catch a file going back to Mockttp's pick; this reads the source instead.
 */
function startsOnMockttpsPick(source: string): string[] {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const unwrap = (node: ts.Node): ts.Node =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
      ? unwrap(node.expression)
      : node;
  const isGetLocal = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    const call = unwrap(node);
    return (
      ts.isCallExpression(call) &&
      ((ts.isIdentifier(call.expression) && call.expression.text === 'getLocal') ||
        (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'getLocal'))
    );
  };
  const isMockttpType = (type: ts.TypeNode | undefined): boolean =>
    !!type &&
    ts.isTypeReferenceNode(type) &&
    (ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text) === 'Mockttp';
  /** A server's name: `a`, or `this.a` for a class field. */
  const nameOf = (node: ts.Node): string | undefined => {
    const target = unwrap(node);
    if (ts.isIdentifier(target)) return target.text;
    if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return `this.${target.name.text}`;
    }
    return undefined;
  };
  const servers = new Set<string>();
  const findServers = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      if (isMockttpType(node.type) || isGetLocal(node.initializer)) servers.add(node.name.text);
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isMockttpType(node.type) || isGetLocal(node.initializer)) servers.add(`this.${node.name.text}`);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isGetLocal(node.right)
    ) {
      const name = nameOf(node.left);
      if (name) servers.add(name);
    }
    ts.forEachChild(node, findServers);
  };
  findServers(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'start'
    ) {
      const receiver = node.expression.expression;
      const name = nameOf(receiver);
      const isServer = (name !== undefined && servers.has(name)) || isGetLocal(receiver);
      const [port] = node.arguments;
      const ownPick =
        port === undefined ||
        ts.isObjectLiteralExpression(port) ||
        (ts.isIdentifier(port) && port.text === 'undefined');
      if (isServer && ownPick) {
        found.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText()}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('Upstreams on picked ports', () => {
  it('finds Mockttp servers started on Mockttp’s own pick', () => {
    const source = [
      'const a = getLocal({ https });',
      'let b; b = mockttp.getLocal();',
      'await a.start();',
      'beforeEach(() => b.start());',
      'await getLocal().start();',
      'await a.start({ startPort: 8000, endPort: 9000 });',
      'await a.start(undefined);',
      'const c = getLocal() as Mockttp; beforeAll(() => (c).start());',
      'let d: Mockttp; await d!.start();',
      'function f(e: mockttp.Mockttp) { return e?.start(); }',
      'class C { g = getLocal(); h!: Mockttp; async go() { await this.g.start(); await this.h.start(); } }',
      'class D { constructor() { this.i = getLocal(); } go() { return this.i.start(); } }',
    ].join('\n');
    expect(startsOnMockttpsPick(source)).toEqual([
      '3: a.start()',
      '4: b.start()',
      '5: getLocal().start()',
      '6: a.start({ startPort: 8000, endPort: 9000 })',
      '7: a.start(undefined)',
      '8: (c).start()',
      '9: d!.start()',
      '10: e?.start()',
      '11: this.g.start()',
      '11: this.h.start()',
      '12: this.i.start()',
    ]);
  });

  it('leaves alone servers on a picked port, other things that start, comments and strings', () => {
    const source = [
      'const a = getLocal();',
      'await startUpstreamOnPickedPort(a);',
      'await a.start(0);',
      'await a.start(port);',
      'await setup.start();',
      'const supervisor = makeSupervisor(); await supervisor.start();',
      'const relay: Relay = makeRelay(); await relay.start();',
      'function f(s: Pick<Mockttp, "start">) { return s.start(port); }',
      'class E { j: Setup; go() { return this.j.start(); } }',
      '// a.start() in a comment',
      "const text = 'a.start()';",
    ].join('\n');
    expect(startsOnMockttpsPick(source)).toEqual([]);
  });

  // Every TypeScript file in the test folder and the end-to-end tests, helpers too, as paths from
  // the repository root.
  const root = path.join(import.meta.dirname, '..');
  const testFiles = ['test', 'e2e'].flatMap((folder) =>
    readdirSync(path.join(root, folder), { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.m?tsx?$/.test(name))
      .map((name) => path.join(folder, name)),
  );

  it('reads every file, helpers, subfolders and the end-to-end tests too', () => {
    expect(testFiles).toContain(path.join('test', 'helpers.ts'));
    expect(testFiles).toContain(path.join('test', 'mcp-backend.test.ts'));
    expect(testFiles).toContain(path.join('test', 'ui', 'app-actions.test.tsx'));
    expect(testFiles).toContain(path.join('e2e', 'mcp.test.ts'));
    expect(testFiles.length).toBeGreaterThan(100);
  });

  it('finds no file starting a Mockttp server on Mockttp’s own pick', () => {
    const found = testFiles.flatMap((name) =>
      startsOnMockttpsPick(readFileSync(path.join(root, name), 'utf8')).map((at) => `${name}:${at}`),
    );
    expect(found).toEqual([]);
  });
});
