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
  const tunnel = (from: string, target: string) =>
    new Promise<string>((resolve) => {
      const socket = net.connect({ host: from, port: proxy.port, localAddress: from });
      let data = '';
      let sent = false;
      socket.on('data', (d: Buffer) => {
        data += d.toString();
        if (!sent && data.includes(' 200')) {
          sent = true;
          socket.write('GET /tunnel HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
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

  it('reaches nothing, however a refused client names this computer', async () => {
    for (const url of [
      `http://[::ffff:7f00:1]:${localPort}/a`,
      `http://[::ffff:127.0.0.1]:${localPort}/b`,
      `http://0.0.0.0:${localPort}/c`,
      `http://host.docker.internal:${localPort}/d`,
    ]) {
      await expect(via(lan!, url), url).rejects.toThrow();
    }
    for (const target of [`0.0.0.0:${localPort}`, `[::ffff:7f00:1]:${localPort}`]) {
      expect(await tunnel(lan!, target)).not.toContain('reached');
    }
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
  }, 15_000);

  it("never asks about this computer's own loopback clients", async () => {
    expect(await via('127.0.0.1', `http://127.0.0.1:${localPort}/self`)).toEqual({
      status: 200,
      body: 'reached /self',
    });
    expect(asked).toEqual([]);
  });
});

/** Docker setup on Linux, with a relay that answers set-up containers' addresses from a list. */
function setupWith(addresses: () => string[], delayMs = 20) {
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
    expect(await setup.isSetUpContainer('172.18.0.5', Date.now() + 1)).toBe(false);
  });

  it('spaces lookups out for a flood of unknown addresses', async () => {
    const { setup, lookups } = setupWith(() => [], 5);
    const started = Date.now();
    await Promise.all(Array.from({ length: 30 }, (_, i) => setup.isSetUpContainer(`172.18.1.${i}`)));
    const elapsed = Date.now() - started;
    expect(lookups.count).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 1);
  });

  it('takes only Linux, and only Docker bridges or this computer', () => {
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
    if (lan) expect(setup.acceptsConnection(lan)).toBe(true);
  });
});
