import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';
import { loadOrCreateCA } from '../src/backend/ca';
import { DockerSetup } from '../src/backend/docker/setup';
import { startProxy, type RunningProxy } from '../src/backend/proxy';
import { InMemoryRequestStore } from '../src/backend/store';
import { WebSocketStore } from '../src/backend/websocket-store';

/** An IPv4 address of this computer that isn't loopback: connecting from it looks like another machine (or a container). */
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((info) => info && info.family === 'IPv4' && !info.internal)?.address;

/**
 * The proxy takes only this computer's loopback, except connections it's told to accept (on
 * Linux, containers Wirescry set up). It decides before Mockttp sees the connection, so a
 * container it doesn't accept reaches nothing at all, however it names its destination.
 */
describe.skipIf(!lan)('Proxy: connections from other addresses', () => {
  let dir: string;
  let proxy: RunningProxy;
  let local: http.Server;
  let localPort: number;
  let accept: (address: string) => boolean | Promise<boolean>;
  const asked: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-guard-'));
    // Only on loopback, like the services a container mustn't reach uninvited.
    local = http.createServer((req, res) => res.end(`reached ${req.url}`));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    localPort = (local.address() as net.AddressInfo).port;
    proxy = await startProxy({
      ca: await loadOrCreateCA(dir),
      store: new InMemoryRequestStore(1000),
      bodies: await HybridBodyStore.open(path.join(dir, 'bodies')),
      websockets: new WebSocketStore(),
      onExchange: () => undefined,
      acceptConnection: (address) => {
        asked.push(address);
        return accept(address);
      },
    });
  });

  afterAll(async () => {
    await proxy?.stop();
    await new Promise((resolve) => local?.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    accept = () => false;
    asked.length = 0;
  });

  /** A plain request through the proxy, from `from` (an address of this computer), on a new connection. */
  const via = (from: string, url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const target = new URL(url);
      const req = http.request(
        {
          host: from,
          port: proxy.port,
          localAddress: from,
          agent: false,
          path: url,
          headers: { host: target.host },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  /** A CONNECT tunnel to `target`, then a plain request inside it with a misleading Host. */
  const tunnel = (from: string, target: string, innerHost = 'example.com') =>
    new Promise<string>((resolve) => {
      const socket = net.connect({ host: from, port: proxy.port, localAddress: from });
      let data = '';
      let sent = false;
      socket.on('data', (d: Buffer) => {
        data += d.toString();
        if (!sent && data.includes(' 200')) {
          sent = true;
          socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${innerHost}\r\nConnection: close\r\n\r\n`);
        }
      });
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

  it('drops a connection it is told not to accept, before anything is read', async () => {
    await expect(via(lan!, `http://host.docker.internal:${localPort}/no`)).rejects.toThrow();
    expect(asked).toEqual([expect.stringContaining(lan!)]);
  });

  it('drops one whose check throws or rejects', async () => {
    for (const check of [
      () => {
        throw new Error('no');
      },
      () => Promise.reject(new Error('Docker went away')),
    ]) {
      accept = check;
      await expect(via(lan!, `http://host.docker.internal:${localPort}/x`)).rejects.toThrow();
    }
  });

  it('sends a refused client nothing at all, not even an answer to CONNECT', async () => {
    expect(await tunnel(lan!, `0.0.0.0:${localPort}`)).toBe('');
  });

  it('survives a client that resets the connection while the answer is looked up', async () => {
    accept = () => new Promise((resolve) => setTimeout(() => resolve(true), 300));
    for (let i = 0; i < 5; i++) {
      const socket = net.connect({ host: lan!, port: proxy.port, localAddress: lan! });
      socket.on('error', () => undefined);
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write('G');
      await new Promise((resolve) => setTimeout(resolve, 30));
      socket.resetAndDestroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Still answering: an unhandled reset would have thrown (and failed this run).
    accept = () => true;
    expect((await via(lan!, `http://host.docker.internal:${localPort}/after-resets`)).status).toBe(200);
  });

  it('lets an accepted client tunnel, and reuse its connection, after waiting', async () => {
    accept = () => new Promise((resolve) => setTimeout(() => resolve(true), 100));
    const target = `host.docker.internal:${localPort}`;
    expect(await tunnel(lan!, target, target)).toContain('reached /tunnel');
    // Two requests on one kept-alive connection: only the connection waits, once.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1, localAddress: lan! });
    const once = (p: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get(
            {
              host: lan!,
              port: proxy.port,
              agent,
              path: `http://host.docker.internal:${localPort}${p}`,
              headers: { host: `host.docker.internal:${localPort}` },
            },
            (res) => {
              let body = '';
              res.on('data', (c: Buffer) => (body += c.toString()));
              res.on('end', () => resolve(body));
            },
          )
          .on('error', reject);
      });
    // (A tunnel is checked again for the connection inside it, which Mockttp hands back.)
    const before = asked.length;
    expect(await once('/one')).toBe('reached /one');
    expect(await once('/two')).toBe('reached /two');
    expect(asked.length - before).toBe(1);
    agent.destroy();
  });

  it('lets an accepted client reach this computer, as a set-up container may', async () => {
    accept = () => true;
    expect(await via(lan!, `http://host.docker.internal:${localPort}/ok`)).toEqual({
      status: 200,
      body: 'reached /ok',
    });
  });

  it('holds a connection while the answer is looked up, losing nothing sent meanwhile', async () => {
    accept = () => new Promise((resolve) => setTimeout(() => resolve(true), 300));
    const started = Date.now();
    expect(await via(lan!, `http://host.docker.internal:${localPort}/later`)).toEqual({
      status: 200,
      body: 'reached /later',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('gives up on an answer that never comes', async () => {
    accept = () => new Promise(() => undefined);
    const started = Date.now();
    await expect(via(lan!, `http://host.docker.internal:${localPort}/never`)).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - started).toBeLessThan(7000);
  }, 15_000);

  it('drops a connection still waiting when the proxy stops, rather than hand it to a stopped proxy', async () => {
    let answer: (ok: boolean) => void = () => undefined;
    const second = await startProxy({
      ca: await loadOrCreateCA(dir),
      store: new InMemoryRequestStore(10),
      bodies: await HybridBodyStore.open(path.join(dir, 'bodies-2')),
      websockets: new WebSocketStore(),
      onExchange: () => undefined,
      acceptConnection: () => new Promise((resolve) => (answer = resolve)),
    });
    const socket = net.connect({ host: lan!, port: second.port, localAddress: lan! });
    let received = '';
    socket.on('data', (d: Buffer) => (received += d.toString()));
    socket.on('error', () => undefined);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await second.stop();
    answer(true);
    await closed;
    expect(received).toBe('');
  });

  it("never asks about this computer's own loopback clients", async () => {
    expect(await via('127.0.0.1', `http://127.0.0.1:${localPort}/self`)).toEqual({
      status: 200,
      body: 'reached /self',
    });
    expect(asked).toEqual([]);
  });
});

/** Docker setup on Linux, with a relay that answers set-up containers' addresses from a list. */
function setupWith(addresses: () => string[] | Error, delayMs = 20) {
  const setup = new DockerSetup({
    dataDir: os.tmpdir(),
    enabled: true,
    proxyPort: () => 1,
    containerDir: () => os.tmpdir(),
    platform: 'linux',
  });
  const lookups = { count: 0 };
  (setup as unknown as { relay: unknown }).relay = {
    setUpAddresses: async () => {
      lookups.count++;
      const now = addresses();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (now instanceof Error) throw now;
      return new Set(now);
    },
  };
  return { setup, lookups };
}

describe('Which containers the proxy accepts on Linux', () => {
  it('accepts requests a new container sends together, with one lookup', async () => {
    const { setup, lookups } = setupWith(() => ['172.18.0.5']);
    const answers = await Promise.all([1, 2, 3].map(() => setup.isSetUpContainer('172.18.0.5')));
    expect(answers).toEqual([true, true, true]);
    expect(lookups.count).toBe(1);
  });

  it('accepts a container that started just after another was looked up', async () => {
    let running = ['172.18.0.5'];
    const { setup } = setupWith(() => running);
    expect(await setup.isSetUpContainer('172.18.0.5')).toBe(true);
    // A second Compose service starts a moment later.
    running = ['172.18.0.5', '172.18.0.6'];
    expect(await setup.isSetUpContainer('172.18.0.6')).toBe(true);
  });

  it('looks again for an address that arrived during a lookup, rather than trust one that started before it', async () => {
    let running: string[] = [];
    const { setup } = setupWith(() => running, 100);
    const first = setup.isSetUpContainer('172.18.0.9');
    await new Promise((resolve) => setTimeout(resolve, 30));
    running = ['172.18.0.7'];
    const second = setup.isSetUpContainer('172.18.0.7');
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });

  it('forgets a container that has gone, even if its address is reused', async () => {
    let running = ['172.18.0.5'];
    const { setup } = setupWith(() => running);
    expect(await setup.isSetUpContainer('172.18.0.5')).toBe(true);
    running = [];
    // Another lookup (for some other address) replaces what was known.
    expect(await setup.isSetUpContainer('172.18.0.99')).toBe(false);
    expect(await setup.isSetUpContainer('172.18.0.5')).toBe(false);
  });

  it('finds a container Docker lists only a moment after its first connection', async () => {
    let calls = 0;
    const { setup, lookups } = setupWith(() => (++calls < 3 ? [] : ['172.18.0.8']));
    expect(await setup.isSetUpContainer('172.18.0.8')).toBe(true);
    expect(lookups.count).toBe(3);
  });

  it('refuses an address no set-up container has, after a short while', async () => {
    const { setup } = setupWith(() => ['172.18.0.5']);
    const started = performance.now();
    expect(await setup.isSetUpContainer('172.18.0.66')).toBe(false);
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(3000);
  });

  it('keeps trusting known containers when a lookup fails', async () => {
    let fail = false;
    const { setup } = setupWith(() => (fail ? new Error('Docker is busy') : ['172.18.0.5']));
    expect(await setup.isSetUpContainer('172.18.0.5')).toBe(true);
    fail = true;
    // A lookup for another address fails; the known one still counts.
    expect(await setup.isSetUpContainer('172.18.0.77')).toBe(false);
    expect(await setup.isSetUpContainer('172.18.0.5')).toBe(true);
  });

  it('spaces lookups out for a flood of unknown addresses', async () => {
    const { setup, lookups } = setupWith(() => [], 5);
    // The same clock the spacing uses: Date.now() is coarse on Windows, and could make the
    // run look shorter than it was.
    const started = performance.now();
    await Promise.all(Array.from({ length: 30 }, (_, i) => setup.isSetUpContainer(`172.18.1.${i}`)));
    const elapsed = performance.now() - started;
    // Lookups start at least 100 ms apart: at most one at the start and one per 100 ms after.
    expect(lookups.count).toBeLessThanOrEqual(Math.floor(elapsed / 100) + 1);
  });

  it('takes only Linux, and only Docker bridges', () => {
    const { setup } = setupWith(() => ['172.18.0.5']);
    // A LAN address isn't on a Docker bridge: refused without a lookup.
    expect(setup.acceptsConnection('192.168.1.50')).toBe(false);
    const mac = new DockerSetup({
      dataDir: os.tmpdir(),
      enabled: true,
      proxyPort: () => 1,
      containerDir: () => '/',
      platform: 'darwin',
    });
    (mac as unknown as { relay: unknown }).relay = {};
    expect(mac.acceptsConnection('172.17.0.2')).toBe(false);
    // This computer's LAN address is the network, not a container.
    if (lan) expect(setup.acceptsConnection(lan)).toBe(false);
  });
});
