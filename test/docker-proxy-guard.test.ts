import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';
import { loadOrCreateCA } from '../src/backend/ca';
import { startProxy, type RunningProxy } from '../src/backend/proxy';
import { InMemoryRequestStore } from '../src/backend/store';
import { WebSocketStore } from '../src/backend/websocket-store';

/** An IPv4 address of this computer that isn't loopback: connecting from it looks like another machine (or a container). */
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((info) => info && info.family === 'IPv4' && !info.internal)?.address;

/**
 * The proxy normally accepts only this computer's loopback. On Linux it also takes containers on
 * Docker's bridges, and must then stop containers Wirescry didn't set up from reaching services
 * that listen only on localhost.
 */
describe.skipIf(!lan)('Proxy: containers reaching this computer', () => {
  let dir: string;
  let proxy: RunningProxy;
  let local: http.Server;
  let localPort: number;
  let allow: (address: string) => boolean;
  let mayReach: (address: string) => Promise<boolean>;
  const asked: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-guard-'));
    // Listens on every address, so it's reachable on the LAN address too.
    local = http.createServer((req, res) => res.end(`reached ${req.url}`));
    await new Promise<void>((resolve) => local.listen(0, resolve));
    localPort = (local.address() as net.AddressInfo).port;
    proxy = await startProxy({
      ca: await loadOrCreateCA(dir),
      store: new InMemoryRequestStore(1000),
      bodies: await HybridBodyStore.open(path.join(dir, 'bodies')),
      websockets: new WebSocketStore(),
      onExchange: () => undefined,
      allowAddress: (address) => allow(address),
      mayReachThisComputer: (address) => {
        asked.push(address);
        return mayReach(address);
      },
    });
  });

  afterAll(async () => {
    await proxy?.stop();
    await new Promise((resolve) => local?.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    allow = () => true;
    mayReach = async () => false;
    asked.length = 0;
  });

  /** A request through the proxy, from `from` (an address of this computer). */
  const via = (from: string, url: string, extraHeaders: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const target = new URL(url);
      const req = http.request(
        {
          host: from === '127.0.0.1' ? '127.0.0.1' : from,
          port: proxy.port,
          localAddress: from,
          agent: false,
          path: url,
          headers: { host: target.host, ...extraHeaders },
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

  it("refuses a client Wirescry didn't set up that asks for this computer's loopback, in any spelling", async () => {
    for (const url of [
      `http://127.0.0.1:${localPort}/a`,
      `http://localhost:${localPort}/b`,
      `http://host.docker.internal:${localPort}/c`,
      `http://[::1]:${localPort}/d`,
      `http://0.0.0.0:${localPort}/e`,
      `http://wirescry.localhost:${localPort}/f`,
    ]) {
      const reply = await via(lan!, url);
      expect(reply.status, url).toBe(403);
      expect(reply.body).toMatch(/only lets containers it set up/);
    }
    expect(asked.every((a) => a.endsWith(lan!))).toBe(true);
  });

  it('lets a container Wirescry set up through', async () => {
    mayReach = async () => true;
    expect(await via(lan!, `http://host.docker.internal:${localPort}/ok`)).toEqual({
      status: 200,
      body: 'reached /ok',
    });
    expect(await via(lan!, `http://127.0.0.1:${localPort}/ok2`)).toEqual({
      status: 200,
      body: 'reached /ok2',
    });
  });

  it('refuses when the check itself fails', async () => {
    mayReach = async () => {
      throw new Error('Docker went away');
    };
    expect((await via(lan!, `http://127.0.0.1:${localPort}/x`)).status).toBe(403);
  });

  it("lets anyone it accepts reach other hosts, without asking: those aren't this computer's loopback", async () => {
    const reply = await via(lan!, `http://${lan}:${localPort}/lan`);
    expect(reply).toEqual({ status: 200, body: 'reached /lan' });
    expect(asked).toEqual([]);
  });

  it('never asks about this computer’s own loopback clients', async () => {
    expect(await via('127.0.0.1', `http://127.0.0.1:${localPort}/self`)).toEqual({
      status: 200,
      body: 'reached /self',
    });
    expect(asked).toEqual([]);
  });

  it('drops a connection from an address it was told not to accept, or whose check throws', async () => {
    for (const check of [
      () => false,
      () => {
        throw new Error('no');
      },
    ]) {
      allow = check;
      await expect(via(lan!, `http://${lan}:${localPort}/no`)).rejects.toThrow();
    }
  });
});
