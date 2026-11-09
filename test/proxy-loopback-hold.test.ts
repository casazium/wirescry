/**
 * Another program can't take Wirescry's proxy port on 127.0.0.1 after Wirescry started (see
 * holdLoopback in src/backend/proxy.ts). Measured on macOS before: Mockttp listens on all
 * addresses (::), another program could then still listen on 127.0.0.1 on that port, and the
 * traffic users and devices send to 127.0.0.1 went to it. Device listeners hung up at random in
 * the full test run because other test files listen on picked ports.
 *
 * Only macOS shows the change: Linux refuses that listen anyway, so the checks there hold with or
 * without it. On Windows the outcome is logged, as it isn't measured yet.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';
import { loadOrCreateCA } from '../src/backend/ca';
import {
  holdLoopback,
  onFreeLoopback,
  startProxy,
  type PortChoice,
  type ProxyOptions,
  type RunningProxy,
} from '../src/backend/proxy';
import { InMemoryRequestStore } from '../src/backend/store';
import { WebSocketStore } from '../src/backend/websocket-store';
import { httpViaProxy, onPickedPort, PORT_TAKEN, requestViaProxy } from './helpers';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function proxy(options: Partial<ProxyOptions> = {}): Promise<RunningProxy & { ca: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-loopback-hold-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const ca = await loadOrCreateCA(dir);
  const running = await startProxy({
    ca,
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
    ca: ca.cert,
    stop: () => {
      stopped = true;
      return stop();
    },
  });
}

/** Tries to listen as another program would; resolves with the error code, or 'listening'. */
function listenAs(port: number, host: string): Promise<string> {
  const server = net.createServer((socket) => socket.end('HTTP/1.1 418 Not Wirescry\r\n\r\n'));
  return new Promise((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    server.listen({ port, host }, () => {
      cleanup.push(() => new Promise((done) => server.close(done)));
      resolve('listening');
    });
  });
}

const hasIPv6Loopback = Object.values(os.networkInterfaces())
  .flat()
  .some((a) => a?.address === '::1');

describe('The proxy’s port on 127.0.0.1', () => {
  it.each([
    ['a proxy on a port the system picked (a device listener)', { port: 0 }],
    ['a proxy on the lowest free port from 8000 (no port setting)', {}],
  ])('can’t be taken by another program after %s starts', async (_name, options) => {
    const running = await proxy(options);
    const taken = [await listenAs(running.port, '127.0.0.1'), await listenAs(running.port, '0.0.0.0')];
    if (process.platform === 'win32')
      console.info(`Windows: another program listening beside the proxy: ${taken}`);
    else expect(taken).toEqual(['EADDRINUSE', 'EADDRINUSE']);
    // And the proxy still answers there: Wirescry's own page.
    expect((await httpViaProxy(running.port, 'http://wirescry.internal/')).status).toBe(200);
  });

  it('is still served for HTTPS through CONNECT, and on ::1', async () => {
    const running = await proxy({ port: 0 });
    // Wirescry's own page over HTTPS, through a CONNECT tunnel to the proxy on 127.0.0.1.
    const page = await requestViaProxy(running.port, 'https://wirescry.internal:443/', running.ca);
    expect(page.status).toBe(200);
    if (!hasIPv6Loopback) return;
    const viaIPv6 = await new Promise<number>((resolve, reject) => {
      const socket = net.connect({ host: '::1', port: running.port }, () =>
        socket.write(
          'GET http://wirescry.internal/ HTTP/1.1\r\nHost: wirescry.internal\r\nConnection: close\r\n\r\n',
        ),
      );
      let text = '';
      socket.on('data', (d: Buffer) => (text += d.toString('latin1')));
      socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
      socket.on('error', reject);
    });
    expect(viaIPv6).toBe(200);
  });

  it('is free again once the proxy stops', async () => {
    const running = await proxy({ port: 0 });
    const { port } = running;
    await running.stop();
    expect(await listenAs(port, '127.0.0.1')).toBe('listening');
  });

  // Mockttp's port search (get-port) checks 127.0.0.1 itself; this keeps it so. The retry for a
  // port taken in the moment after that check is tested with onFreeLoopback below.
  it('is skipped when another program already has 127.0.0.1 there and the proxy picks its port', async () => {
    // Another program on 127.0.0.1 only, on a port the proxy would otherwise pick first.
    const held = await onPickedPort(async (port) => {
      const result = await listenAs(port, '127.0.0.1');
      return result === 'listening' ? port : PORT_TAKEN;
    });
    const running = await proxy({ portRange: { startPort: held, endPort: Math.min(held + 50, 65535) } });
    expect(running.port).not.toBe(held);
    expect(running.port).toBeGreaterThan(held);
    // Each answers its own port: the other program keeps 127.0.0.1 on its port.
    const other = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: held });
      let text = '';
      socket.on('data', (d: Buffer) => (text += d.toString('latin1')));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    expect(other).toMatch(/^HTTP\/1\.1 418 Not Wirescry/);
    expect((await httpViaProxy(running.port, 'http://wirescry.internal/')).status).toBe(200);
  });

  // The check from before the proxy starts (assertLoopbackPortFree) refuses it: kept so here.
  it('refuses a fixed port another program already has on 127.0.0.1, rather than move', async () => {
    const held = await onPickedPort(async (port) => {
      const result = await listenAs(port, '127.0.0.1');
      return result === 'listening' ? port : PORT_TAKEN;
    });
    await expect(proxy({ port: held })).rejects.toMatchObject({ code: 'EADDRINUSE', port: held });
  });
});

/** A stand-in for Mockttp: an HTTP server on all addresses, as Mockttp listens. */
async function allAddresses(): Promise<{ server: net.Server; port: number }> {
  const server = http.createServer((_req, res) => res.end('the proxy'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  cleanup.push(() => new Promise((done) => server.close(done)));
  return { server, port: (server.address() as net.AddressInfo).port };
}

const getText = (port: number): Promise<string> =>
  new Promise((resolve, reject) =>
    http
      .get({ host: '127.0.0.1', port, agent: false }, (res) => {
        let text = '';
        res.on('data', (d: Buffer) => (text += d.toString()));
        res.on('end', () => resolve(text));
      })
      .on('error', reject),
  );

describe('holdLoopback', () => {
  it('holds 127.0.0.1 and hands its connections to the proxy, or isn’t needed (Linux)', async () => {
    const proxyLike = await allAddresses();
    const hold = await holdLoopback(proxyLike);
    if (hold) cleanup.push(() => new Promise((done) => hold.close(done)));
    if (process.platform === 'linux') expect(hold).toBeUndefined();
    if (process.platform === 'darwin') expect(hold).toBeDefined();
    if (process.platform === 'win32') console.info(`Windows: 127.0.0.1 held beside all addresses: ${!!hold}`);
    // Either way, the proxy answers 127.0.0.1.
    expect(await getText(proxyLike.port)).toBe('the proxy');
    if (process.platform !== 'win32') expect(await listenAs(proxyLike.port, '127.0.0.1')).toBe('EADDRINUSE');
  });

  it('says the port is taken when another program got 127.0.0.1 first, on macOS only', async () => {
    const proxyLike = await allAddresses();
    // Linux won't let the other program in beside the proxy: nothing to test there.
    if ((await listenAs(proxyLike.port, '127.0.0.1')) !== 'listening') return;
    await expect(holdLoopback(proxyLike, 'darwin')).rejects.toMatchObject({
      code: 'EADDRINUSE',
      port: proxyLike.port,
      loopbackTaken: proxyLike.port,
    });
    // Elsewhere a refusal can be the proxy's own listener: the proxy runs as before.
    await expect(holdLoopback(proxyLike, 'linux')).resolves.toBeUndefined();
    await expect(holdLoopback(proxyLike, 'win32')).resolves.toBeUndefined();
  });

  it('has nothing to hold on a system without the address (no IPv4 loopback)', async () => {
    const proxyLike = await allAddresses();
    // 192.0.2.1 is for documentation only: no system has it, as some have no 127.0.0.1.
    await expect(holdLoopback(proxyLike, 'darwin', '192.0.2.1')).resolves.toBeUndefined();
  });

  it('passes on any other failure, and needs Mockttp’s server', async () => {
    const proxyLike = await allAddresses();
    await expect(
      holdLoopback({ server: proxyLike.server, port: 70_000 } as never, 'linux'),
    ).rejects.toThrow();
    await expect(holdLoopback({ port: proxyLike.port } as never)).rejects.toThrow(
      "Can't hold the proxy's port on 127.0.0.1",
    );
  });
});

describe('onFreeLoopback', () => {
  const taken = (port: number) =>
    Object.assign(new Error('taken'), { code: 'EADDRINUSE', port, loopbackTaken: port });

  it('starts once when the port is free', async () => {
    const tries: PortChoice[] = [];
    expect(await onFreeLoopback(async (port) => (tries.push(port), 'started'), 0)).toBe('started');
    expect(tries).toEqual([0]);
  });

  it('tries the next ports in a range, and the system’s choice again, when 127.0.0.1 was taken', async () => {
    const tries: PortChoice[] = [];
    const result = await onFreeLoopback(
      async (port) => {
        tries.push(port);
        if (tries.length < 3) throw taken(typeof port === 'number' ? 4000 : port.startPort + 2);
        return 'started';
      },
      { startPort: 8000, endPort: 8100 },
    );
    expect(result).toBe('started');
    expect(tries).toEqual([
      { startPort: 8000, endPort: 8100 },
      { startPort: 8003, endPort: 8100 },
      { startPort: 8006, endPort: 8100 },
    ]);
    // A range used up, or a port outside it (Mockttp's fallback): the system's choice instead.
    for (const [range, at] of [
      [{ startPort: 8000, endPort: 8005 }, 8005],
      [{ startPort: 8000, endPort: 8005 }, 51000],
      [{ startPort: 8000, endPort: 8005 }, 7000],
    ] as const) {
      const after: PortChoice[] = [];
      await onFreeLoopback(async (port) => {
        after.push(port);
        if (after.length === 1) throw taken(at);
      }, range);
      expect(after).toEqual([range, 0]);
    }
    const systemTries: PortChoice[] = [];
    await onFreeLoopback(async (port) => {
      systemTries.push(port);
      if (systemTries.length === 1) throw taken(51234);
    }, 0);
    expect(systemTries).toEqual([0, 0]);
  });

  it('doesn’t move a fixed port, retry other failures, or try forever', async () => {
    let calls = 0;
    await expect(onFreeLoopback(async () => (calls++, Promise.reject(taken(9000))), 9000)).rejects.toThrow(
      'taken',
    );
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      onFreeLoopback(async () => (calls++, Promise.reject(new Error('other'))), 0),
    ).rejects.toThrow('other');
    expect(calls).toBe(1);
    calls = 0;
    await expect(onFreeLoopback(async () => (calls++, Promise.reject(taken(1))), 0)).rejects.toThrow('taken');
    expect(calls).toBe(5);
  });
});
