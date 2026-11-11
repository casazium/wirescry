/**
 * Every update the proxy makes to an exchange, before the UI's batching: a reply Wirescry makes up
 * itself (Mockttp's 502, the device guard's refusal) is never recorded as a response arriving, not
 * even for a moment.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';
import { loadOrCreateCA } from '../src/backend/ca';
import { startProxy, type RunningProxy } from '../src/backend/proxy';
import { InMemoryRequestStore } from '../src/backend/store';
import { WebSocketStore } from '../src/backend/websocket-store';
import type { ExchangeDetail } from '../src/shared/api';
import { NOTHING_LISTENS } from './helpers';

/** GET through a proxy, resolving with the status once the reply has ended. */
const getVia = (proxyPort: number, url: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });

describe('updates the proxy makes for replies it makes up itself', () => {
  let dir: string;
  const proxies: RunningProxy[] = [];
  const updates: ExchangeDetail[] = [];

  const open = async (extra: Partial<Parameters<typeof startProxy>[0]> = {}) => {
    const proxy = await startProxy({
      ca: await loadOrCreateCA(dir),
      store: new InMemoryRequestStore(100),
      bodies: await HybridBodyStore.open(path.join(dir, `bodies-${proxies.length}`)),
      websockets: new WebSocketStore(),
      onExchange: (e) => updates.push(structuredClone(e)),
      port: 0,
      ...extra,
    });
    proxies.push(proxy);
    return proxy;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-live-proxy-'));
  });

  afterAll(async () => {
    for (const proxy of proxies) await proxy.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const of = (urlPath: string) => updates.filter((u) => u.summary.path === urlPath);

  it("never shows Mockttp's own 502 as a response arriving", async () => {
    const proxy = await open();
    expect(await getVia(proxy.port, `http://127.0.0.1:${NOTHING_LISTENS}/made-up`)).toBe(502);
    await expect.poll(() => of('/made-up').some((u) => u.summary.failure)).toBe(true);
    expect(
      of('/made-up').filter((u) => u.summary.responding || (u.summary.status === 502 && !u.summary.failure)),
    ).toEqual([]);
  });

  it("never shows the device guard's refusal as a response arriving", async () => {
    const proxy = await open({
      source: { kind: 'android', id: 'serial-1', label: 'Pixel' },
      egress: { allowLocal: () => false },
    });
    expect(await getVia(proxy.port, 'http://127.0.0.1:9/refused')).toBe(403);
    await expect.poll(() => of('/refused').some((u) => u.summary.failure)).toBe(true);
    expect(
      of('/refused').filter((u) => u.summary.responding || (u.summary.status && !u.summary.failure)),
    ).toEqual([]);
  });

  it('does show a real server reply as arriving before it finishes', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('part');
      setTimeout(() => res.end(' rest'), 300);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const proxy = await open();
      expect(await getVia(proxy.port, `http://127.0.0.1:${port}/real`)).toBe(200);
      await expect.poll(() => of('/real').some((u) => u.summary.durationMs !== undefined)).toBe(true);
      expect(of('/real').some((u) => u.summary.responding && u.summary.status === 200)).toBe(true);
    } finally {
      server.close();
    }
  });
});
