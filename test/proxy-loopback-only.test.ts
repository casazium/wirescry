/**
 * On Windows and macOS the proxy listens on loopback only (127.0.0.1, with ::1 held beside it), so
 * nothing listens on the network and Windows doesn't ask to let Wirescry through its firewall
 * (see listensOnLoopbackOnly in src/backend/proxy.ts). On Linux it listens on all addresses, for
 * Docker's bridge networks. The system is injected, so every case runs on every system; socket
 * rules differ by system, and each case says where they matter.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';
import { loadOrCreateCA } from '../src/backend/ca';
import {
  assertListensOnLoopback,
  assertNothingAnswersLoopback,
  holdIpv6Loopback,
  listensOnLoopbackOnly,
  onFreePort,
  startProxy,
  type ProxyOptions,
  type RunningProxy,
} from '../src/backend/proxy';
import { InMemoryRequestStore } from '../src/backend/store';
import { WebSocketStore } from '../src/backend/websocket-store';
import { httpViaProxy, onPickedPort, PORT_TAKEN } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function proxy(options: Partial<ProxyOptions> = {}): Promise<RunningProxy> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-loopback-only-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const running = await startProxy({
    ca: await loadOrCreateCA(dir),
    store: new InMemoryRequestStore(100),
    bodies: await HybridBodyStore.open(path.join(dir, 'bodies')),
    websockets: new WebSocketStore(),
    onExchange: () => undefined,
    ...options,
  });
  let stopped = false;
  const stop = running.stop;
  cleanup.push(() => (stopped ? Promise.resolve() : stop()));
  return Object.assign(running, {
    stop: () => {
      stopped = true;
      return stop();
    },
  });
}

/** Another program listening there, answering "418 Not Wirescry"; resolves with its port, or the error code. */
function otherProgram(port: number, host: string): Promise<number | string> {
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    // No error handler: a reset from the proxy's check would fail the test, as it would trouble
    // a real program.
    socket.end('HTTP/1.1 418 Not Wirescry\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    server.listen({ port, host }, () => {
      cleanup.push(
        () =>
          new Promise((done) => {
            if (open.size) console.info(`still open on the other program: ${open.size}`);
            for (const socket of open) socket.destroy();
            server.close(done);
          }),
      );
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/**
 * Puts another program on host:port. Returns false only when the system has no IPv6 there;
 * anything else that stops it fails the test, rather than pass it unchecked.
 */
async function placeOther(port: number, host: string): Promise<boolean> {
  const result = await otherProgram(port, host);
  if (host.includes(':') && (result === 'EADDRNOTAVAIL' || result === 'EAFNOSUPPORT')) return false;
  expect(result).toBe(port);
  return true;
}

/** What answers a plain request on host:port: "wirescry", "other", or the error code. */
function whoAnswers(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () =>
      socket.write(
        'GET http://wirescry.internal/ HTTP/1.1\r\nHost: wirescry.internal\r\nConnection: close\r\n\r\n',
      ),
    );
    let text = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.on('data', (d: Buffer) => (text += d.toString('latin1')));
    socket.on('end', () =>
      resolve(
        /418 Not Wirescry/.test(text)
          ? 'other'
          : /^HTTP\/1\.1 200/.test(text)
            ? 'wirescry'
            : `"${text.slice(0, 40)}"`,
      ),
    );
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
}

/** Whether a connection to host:port was ever made (a firewall may turn a refusal into a timeout). */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** A port free on 127.0.0.1 and on all IPv4 addresses at the time. */
const freePort = (): Promise<number> =>
  onPickedPort(async (port) => {
    for (const host of ['0.0.0.0', '127.0.0.1']) {
      const result = await new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
      });
      if (!result) return PORT_TAKEN;
    }
    return port;
  });

const hasIPv6Loopback = Object.values(os.networkInterfaces())
  .flat()
  .some((a) => a?.address === '::1');

const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

/** The address each listen call asks for, while `run` runs (undefined: all addresses). */
async function listenHosts(run: () => Promise<unknown>): Promise<Array<string | undefined>> {
  const hosts: Array<string | undefined> = [];
  const original = net.Server.prototype.listen;
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (
    this: net.Server,
    ...args: unknown[]
  ) {
    const [first, second] = args;
    if (first && typeof first === 'object') hosts.push((first as net.ListenOptions).host);
    else hosts.push(typeof second === 'string' ? second : undefined);
    return (original as (...a: unknown[]) => net.Server).apply(this, args);
  });
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return hosts;
}

describe('Where the proxy listens', () => {
  it('on loopback only on Windows and macOS, on all addresses on Linux', () => {
    expect(listensOnLoopbackOnly('win32')).toBe(true);
    expect(listensOnLoopbackOnly('darwin')).toBe(true);
    expect(listensOnLoopbackOnly('linux')).toBe(false);
  });

  it.each(['win32', 'darwin'] as const)(
    'never listens beyond loopback on %s, not even to check a port, for any kind of port',
    async (platform) => {
      const fixed = await freePort();
      for (const options of [{}, { port: 0 }, { port: fixed }]) {
        const hosts = await listenHosts(() => proxy({ platform, ...options }));
        expect(hosts.length).toBeGreaterThanOrEqual(1);
        for (const host of hosts) expect(['127.0.0.1', '::1']).toContain(host);
        // Mockttp's own listen is the 127.0.0.1 one.
        expect(hosts).toContain('127.0.0.1');
      }
    },
  );

  it('listens on all addresses on Linux, as before (the check above sees those)', async () => {
    const hosts = await listenHosts(() => proxy({ platform: 'linux' }));
    expect(hosts.some((host) => host === undefined || host === '0.0.0.0' || host === '::')).toBe(true);
  });

  it.runIf(lanAddress)(
    'can’t be reached at this computer’s network address on Windows and macOS',
    async () => {
      const running = await proxy({ platform: 'win32', port: 0 });
      expect(await whoAnswers('127.0.0.1', running.port)).toBe('wirescry');
      expect(await connects(lanAddress!, running.port)).toBe(false);
      // On Linux the connection is made, then dropped by the loopback check (restrictToLoopback).
      const linux = await proxy({ platform: 'linux', port: 0 });
      expect(await connects(lanAddress!, linux.port)).toBe(true);
      expect(await whoAnswers(lanAddress!, linux.port)).not.toBe('wirescry');
    },
  );

  it.runIf(hasIPv6Loopback)('answers on ::1 too, for clients that try localhost there first', async () => {
    const running = await proxy({ platform: 'win32', port: 0 });
    expect(await whoAnswers('::1', running.port)).toBe('wirescry');
    expect((await httpViaProxy(running.port, 'http://wirescry.internal/')).status).toBe(200);
  });

  it('frees 127.0.0.1 and ::1 once it stops', async () => {
    const running = await proxy({ platform: 'win32', port: 0 });
    const { port } = running;
    await running.stop();
    expect(await otherProgram(port, '127.0.0.1')).toBe(port);
    if (hasIPv6Loopback) expect(await otherProgram(port, '::1')).toBe(port);
  });
});

describe('Another program on the proxy’s port, on Windows and macOS', () => {
  // Measured on Windows and macOS: a listen on 127.0.0.1 succeeds beside another program on all
  // addresses, and gets 127.0.0.1's traffic. Without the check, Wirescry would take it. (Linux
  // refuses that listen, so there these hold either way.)
  it.each(['0.0.0.0', '::'])(
    'on all addresses (%s): a range moves past it, and it keeps its traffic',
    async (host) => {
      const port = await freePort();
      if (!(await placeOther(port, host))) return; // No IPv6 here.
      const running = await proxy({ platform: 'win32', portRange: { startPort: port, endPort: port + 20 } });
      expect(running.port).toBeGreaterThan(port);
      expect(await whoAnswers('127.0.0.1', port)).toBe('other');
      expect(await whoAnswers('127.0.0.1', running.port)).toBe('wirescry');
    },
  );

  it.each(['0.0.0.0', '::', '127.0.0.1'])(
    'on %s: a fixed port is refused, rather than taken',
    async (host) => {
      const port = await freePort();
      if (!(await placeOther(port, host))) return;
      await expect(proxy({ platform: 'win32', port })).rejects.toMatchObject({ code: 'EADDRINUSE', port });
      expect(await whoAnswers('127.0.0.1', port)).toBe('other');
    },
  );

  it.runIf(hasIPv6Loopback)('on ::1 only: a range moves past it, and it keeps ::1', async () => {
    const port = await freePort();
    if (!(await placeOther(port, '::1'))) return;
    const running = await proxy({ platform: 'win32', portRange: { startPort: port, endPort: port + 20 } });
    expect(running.port).toBeGreaterThan(port);
    expect(await whoAnswers('::1', port)).toBe('other');
  });

  it.runIf(hasIPv6Loopback)('on ::1 only: a fixed port starts on 127.0.0.1, and says so', async () => {
    const port = await freePort();
    if (!(await placeOther(port, '::1'))) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const running = await proxy({ platform: 'win32', port });
    expect(running.port).toBe(port);
    expect(await whoAnswers('127.0.0.1', port)).toBe('wirescry');
    expect(await whoAnswers('::1', port)).toBe('other');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`::1 on port ${port}`));
  });

  it('restarts on its fixed port, as a device listener does after a certificate reset', async () => {
    const port = await freePort();
    const first = await proxy({ platform: 'win32', port });
    await first.stop();
    const second = await proxy({ platform: 'win32', port });
    expect(second.port).toBe(port);
    expect(await whoAnswers('127.0.0.1', port)).toBe('wirescry');
    if (hasIPv6Loopback) expect(await whoAnswers('::1', port)).toBe('wirescry');
  });

  it('can’t take 127.0.0.1 after the proxy started', async () => {
    const running = await proxy({ platform: 'win32', port: 0 });
    expect(await otherProgram(running.port, '127.0.0.1')).toBe('EADDRINUSE');
    expect(await whoAnswers('127.0.0.1', running.port)).toBe('wirescry');
  });
});

describe('assertNothingAnswersLoopback', () => {
  it('passes a port nothing answers on', async () => {
    const port = await freePort();
    await expect(assertNothingAnswersLoopback(port)).resolves.toBeUndefined();
  });

  it('refuses one another program answers on, as a listen would', async () => {
    const port = await freePort();
    await otherProgram(port, '127.0.0.1');
    await expect(assertNothingAnswersLoopback(port)).rejects.toMatchObject({ code: 'EADDRINUSE', port });
  });
});

describe('onFreePort', () => {
  const taken = (port: number) => Object.assign(new Error(`taken ${port}`), { code: 'EADDRINUSE', port });

  it('tries a range a port at a time, passing over taken ones', async () => {
    const tried: number[] = [];
    const result = await onFreePort(
      async (port) => {
        tried.push(port);
        if (port < 8002) throw taken(port);
        return port;
      },
      { startPort: 8000, endPort: 8010 },
    );
    expect(result).toBe(8002);
    expect(tried).toEqual([8000, 8001, 8002]);
  });

  it('passes over a port another user has (EACCES on Windows) or whose ::1 is taken', async () => {
    const tried: number[] = [];
    const result = await onFreePort(
      async (port) => {
        tried.push(port);
        if (port === 8000) throw Object.assign(new Error('access'), { code: 'EACCES' });
        if (port === 8001) throw Object.assign(new Error('::1'), { code: 'EADDRINUSE', loopbackTaken: port });
        return port;
      },
      { startPort: 8000, endPort: 8010 },
    );
    expect(result).toBe(8002);
  });

  it('stops at any other failure', async () => {
    const tried: number[] = [];
    await expect(
      onFreePort(
        async (port) => {
          tried.push(port);
          throw new Error('broken');
        },
        { startPort: 8000, endPort: 8010 },
      ),
    ).rejects.toThrow('broken');
    expect(tried).toEqual([8000]);
  });

  it('lets the system pick at the end of the range, or after 64 taken ports', async () => {
    const short: number[] = [];
    expect(
      await onFreePort(
        async (port) => {
          short.push(port);
          if (port !== 0) throw taken(port);
          return 'system';
        },
        { startPort: 9000, endPort: 9002 },
      ),
    ).toBe('system');
    expect(short).toEqual([9000, 9001, 9002, 0]);
    const long: number[] = [];
    await onFreePort(
      async (port) => {
        long.push(port);
        if (port !== 0) throw taken(port);
        return port;
      },
      { startPort: 8000, endPort: 65535 },
    );
    expect(long.length).toBe(65);
    expect(long.at(-2)).toBe(8063);
    expect(long.at(-1)).toBe(0);
  });

  it('starts a fixed port once, failure and all, and retries the system’s choice like before', async () => {
    const fixed: number[] = [];
    await expect(
      onFreePort(async (port) => {
        fixed.push(port);
        throw taken(port);
      }, 8123),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(fixed).toEqual([8123]);
    let attempts = 0;
    const result = await onFreePort(async (port) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('::1'), { loopbackTaken: 5555 });
      return port;
    }, 0);
    expect(result).toBe(0);
    expect(attempts).toBe(3);
  });
});

describe('holdIpv6Loopback', () => {
  /** A stand-in for Mockttp's listener on 127.0.0.1, answering "the proxy". */
  async function proxyLike(): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer((socket) =>
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nthe proxy'),
    );
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
    );
    cleanup.push(() => new Promise((done) => server.close(done)));
    return { server, port };
  }

  it.runIf(hasIPv6Loopback)(
    'hands ::1 connections to the proxy, and stops taking them once closed',
    async () => {
      const like = await proxyLike();
      const hold = await holdIpv6Loopback(like, false);
      expect(hold).toBeDefined();
      const text = await new Promise<string>((resolve) => {
        const socket = net.connect({ host: '::1', port: like.port });
        let got = '';
        socket.on('data', (d: Buffer) => (got += d.toString()));
        socket.on('end', () => resolve(got));
      });
      expect(text).toContain('the proxy');
      await new Promise((done) => hold!.close(done));
      expect(await connects('::1', like.port)).toBe(false);
    },
  );

  it('goes on without it where the system has no such address', async () => {
    const like = await proxyLike();
    // A documentation-only IPv6 address: no system has it.
    await expect(holdIpv6Loopback(like, false, '2001:db8::1')).resolves.toBeUndefined();
  });

  it.runIf(hasIPv6Loopback)('with ::1 taken: a fixed port goes on, any other moves on', async () => {
    const like = await proxyLike();
    if (!(await placeOther(like.port, '::1'))) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(holdIpv6Loopback(like, true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(holdIpv6Loopback(like, false)).rejects.toMatchObject({
      code: 'EADDRINUSE',
      loopbackTaken: like.port,
    });
  });

  // Ports below 1024 need root on Linux: EACCES, as Windows gives for another user's port.
  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0 && hasIPv6Loopback)(
    'takes EACCES as taken, like EADDRINUSE',
    async () => {
      const like = await proxyLike();
      const atLowPort = { server: like.server, port: 81 };
      await expect(holdIpv6Loopback(atLowPort, false)).rejects.toMatchObject({
        code: 'EACCES',
        loopbackTaken: 81,
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(holdIpv6Loopback(atLowPort, true)).resolves.toBeUndefined();
    },
  );

  it('passes any other failure on, and needs a listener to hand connections to', async () => {
    const like = await proxyLike();
    await expect(holdIpv6Loopback({ server: like.server, port: 70_000 } as never, false)).rejects.toThrow();
    await expect(holdIpv6Loopback({ port: like.port } as never, false)).rejects.toThrow(
      "Can't hold the proxy's port on ::1",
    );
  });
});

describe('assertListensOnLoopback', () => {
  it('stops the proxy from starting when Mockttp ignores the address, as without the patch', async () => {
    // Mockttp's listen is the one given a port and a host as arguments; unpatched, it gets the port alone.
    const original = net.Server.prototype.listen;
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (
      this: net.Server,
      ...args: unknown[]
    ) {
      const unpatched =
        typeof args[0] === 'number' && args[1] === '127.0.0.1' ? [args[0], ...args.slice(2)] : args;
      return (original as (...a: unknown[]) => net.Server).apply(this, unpatched);
    });
    const port = await freePort();
    await expect(proxy({ platform: 'win32', port })).rejects.toThrow(/Mockttp is not patched/);
    vi.restoreAllMocks();
    // And it let the port go again.
    expect(await connects('127.0.0.1', port)).toBe(false);
  });

  const listeningOn = (address: unknown) => ({ port: 1, server: { address: () => address } }) as never;

  it('passes a proxy on 127.0.0.1 alone', () => {
    expect(() =>
      assertListensOnLoopback(listeningOn({ address: '127.0.0.1', port: 1, family: 'IPv4' })),
    ).not.toThrow();
  });

  it('refuses one on all addresses, as an unpatched Mockttp listens', () => {
    for (const address of ['::', '0.0.0.0'])
      expect(() => assertListensOnLoopback(listeningOn({ address, port: 1, family: 'IPv6' }))).toThrow(
        /Mockttp is not patched/,
      );
    expect(() => assertListensOnLoopback({ port: 1 } as never)).toThrow(/Mockttp is not patched/);
  });
});
