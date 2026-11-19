/**
 * An upload's size so far (src/backend/proxy.ts): set while a request body arrives, cleared when
 * it ends or the proxy stops, and sent with the response's size so far in one update a tick.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';
import { loadOrCreateCA } from '../src/backend/ca';
import { startProxy, type RunningProxy } from '../src/backend/proxy';
import { InMemoryRequestStore } from '../src/backend/store';
import { WebSocketStore } from '../src/backend/websocket-store';
import type { ExchangeDetail } from '../src/shared/api';

describe('an upload’s size so far', () => {
  let dir: string;
  let upstream: http.Server;
  let upstreamPort: number;
  const proxies: RunningProxy[] = [];
  const updates: ExchangeDetail[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-request-received-'));
    upstream = http.createServer((req, res) => {
      if (req.url === '/answers-early') {
        // Answers soon after the upload's first part (once it has been reported, well inside a
        // tick), then keeps reading the upload.
        req.once('data', () => setTimeout(() => res.writeHead(200).end('early'), 50));
        req.resume();
        return;
      }
      if (req.url === '/echo') {
        // Two-way: each chunk that arrives goes straight back.
        res.writeHead(200, { 'content-type': 'text/plain' });
        req.on('data', (chunk) => res.write(chunk));
        req.on('end', () => res.end());
        return;
      }
      req.resume();
      req.on('end', () => res.end('ok'));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const proxy of proxies) await proxy.stop().catch(() => undefined);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const open = async () => {
    const proxy = await startProxy({
      ca: await loadOrCreateCA(dir),
      store: new InMemoryRequestStore(100),
      bodies: await HybridBodyStore.open(path.join(dir, `bodies-${proxies.length}`)),
      websockets: new WebSocketStore(),
      onExchange: (e) => updates.push(structuredClone(e)),
      port: 0,
    });
    proxies.push(proxy);
    return proxy;
  };

  const upload = (proxy: RunningProxy, urlPath: string) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'POST',
      path: `http://127.0.0.1:${upstreamPort}${urlPath}`,
      headers: { host: `127.0.0.1:${upstreamPort}` },
    });
    req.on('error', () => undefined);
    req.on('response', (res) => res.resume());
    return req;
  };
  const of = (urlPath: string) => updates.filter((u) => u.summary.path === urlPath);

  it('is cleared when the proxy stops in the middle of an upload', async () => {
    const proxy = await open();
    const req = upload(proxy, '/cut');
    req.write('part of an upload');
    await expect.poll(() => of('/cut').at(-1)?.summary.requestReceived).toBeGreaterThan(0);
    await proxy.stop();
    await expect.poll(() => of('/cut').at(-1)?.summary.requestReceived).toBeUndefined();
    // And its body is recorded, cut short.
    await expect.poll(() => of('/cut').at(-1)?.requestBody).toBeDefined();
    req.destroy();
  });

  it('a stream going both ways gets both sizes so far in one update a tick', async () => {
    const proxy = await open();
    const req = upload(proxy, '/echo');
    for (let i = 0; i < 6; i++) {
      req.write(`chunk-${i} `);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await expect.poll(() => of('/echo').at(-1)?.summary.responseReceived).toBeGreaterThan(0);
    const ticks = of('/echo').filter((u, i, all) => {
      const before = all[i - 1]?.summary;
      return (
        before &&
        (u.summary.requestReceived !== before.requestReceived ||
          u.summary.responseReceived !== before.responseReceived)
      );
    });
    // Some tick carried both changes at once.
    expect(
      ticks.some((u) => {
        const before = of('/echo')[of('/echo').indexOf(u) - 1]!.summary;
        return (
          u.summary.requestReceived !== before.requestReceived &&
          u.summary.responseReceived !== before.responseReceived
        );
      }),
    ).toBe(true);
    // At most about four updates a second for 720 ms, not eight.
    expect(ticks.length).toBeLessThanOrEqual(5);
    req.end();
    await expect.poll(() => of('/echo').at(-1)?.summary.requestReceived).toBeUndefined();
  });

  it('keeps reporting an upload after its response has ended', async () => {
    const proxy = await open();
    const req = upload(proxy, '/answers-early');
    req.write('first part ');
    await expect.poll(() => of('/answers-early').at(-1)?.summary.durationMs).toBeDefined();
    // The part that came just before the response ended is still reported, with nothing more sent.
    await expect.poll(() => of('/answers-early').at(-1)?.summary.requestReceived ?? 0).toBeGreaterThan(0);
    const before = of('/answers-early').at(-1)!.summary.requestReceived ?? 0;
    req.write('x'.repeat(4000));
    await expect
      .poll(() => of('/answers-early').at(-1)?.summary.requestReceived ?? 0)
      .toBeGreaterThan(before);
    req.end();
    await expect.poll(() => of('/answers-early').at(-1)?.summary.requestReceived).toBeUndefined();
  });
});
