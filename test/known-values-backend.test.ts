/**
 * Known values for the window's View › Hide Secrets, through a real backend: nothing sent until
 * the window watches, catching up with getKnownValues, values pushed ahead of the summaries they
 * came from, getExchange and getKnownValues flushing what's waiting first, Clear, and collecting
 * stopping once no window is connected.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ExchangeDetail, KnownPage, KnownPush, ServerMessage } from '../src/shared/api';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

// Fake tokens, made at run time so the file holds nothing a secret scanner flags.
const token = (n: number): string => `Zq9x${n}Tk7Lm2Pw4Rt8Vn6Yb3`;

let dir: string;
let upstream: http.Server;
let base: string;
let backend: RunningBackend;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-known-values-'));
  upstream = http.createServer((req, res) => {
    // Echoes the bearer token in a header of its own, as the earlier probe did.
    const auth = req.headers.authorization ?? '';
    res.setHeader('x-echo', `you sent ${auth.replace(/^Bearer /, '')}`);
    res.end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  backend = await startBackend({
    dataDir: path.join(dir, 'data'),
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    knownIdleMs: 300,
  });
});

afterAll(async () => {
  await backend?.stop();
  upstream?.close();
  await rm(dir, { recursive: true, force: true });
});

const pushes = (messages: ServerMessage[]): KnownPush[] =>
  messages.flatMap((m) => (m.type === 'exchanges' && m.known ? [m.known] : []));

async function caughtUp(api: Awaited<ReturnType<typeof apiClient>>, epoch?: string): Promise<KnownPage[]> {
  const pages: KnownPage[] = [];
  let after = 0;
  for (;;) {
    const page = await api.send<KnownPage>({
      command: 'getKnownValues',
      ...(epoch ? { epoch } : {}),
      after,
    });
    pages.push(page);
    if (page.done) return pages;
    epoch = page.epoch;
    after = page.next;
  }
}

describe('known values for the window', () => {
  it('sends none until watched, then pages, then pushes ahead of the summaries', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      await httpViaProxy(backend.proxyPort, `${base}/before`, { authorization: `Bearer ${token(1)}` });
      await expect.poll(() => exchangesIn(api.messages).some((e) => e.path === '/before')).toBe(true);
      // Not watching: no values anywhere, and pages refused.
      expect(pushes(api.messages)).toEqual([]);
      await expect(api.send({ command: 'getKnownValues', after: 0 })).rejects.toThrow(
        'aren’t being collected',
      );

      const { epoch } = await api.send<{ epoch: string }>({ command: 'watchKnownValues', on: true });
      expect(typeof epoch).toBe('string');
      // On again keeps the epoch.
      expect(await api.send({ command: 'watchKnownValues', on: true })).toEqual({ epoch });
      const pages = await caughtUp(api, epoch);
      const values = pages.flatMap((p) => p.values);
      expect(values).toContain(token(1));
      // An ordinary value isn't one.
      expect(values.some((v) => v.includes('you sent'))).toBe(false);
      const last = pages.at(-1)!;

      // Now each exchange's values come with it, numbered on from the page's end.
      await httpViaProxy(backend.proxyPort, `${base}/after?id=${token(2)}`, {
        authorization: `Bearer ${token(2)}`,
      });
      await expect.poll(() => pushes(api.messages).some((p) => p.values.includes(token(2)))).toBe(true);
      const message = api.messages.find(
        (m) => m.type === 'exchanges' && m.known?.values.includes(token(2)),
      ) as Extract<ServerMessage, { type: 'exchanges' }>;
      expect(Object.keys(message)).toEqual(['type', 'known', 'exchanges', 'removed']);
      expect(message.known).toMatchObject({ epoch, from: last.next, full: false });
      // In the same message as the exchange that taught it, or one before.
      const at = api.messages.indexOf(message);
      const first = api.messages.findIndex(
        (m) => m.type === 'exchanges' && m.exchanges.some((e) => e.path.startsWith('/after')),
      );
      expect(first).toBeGreaterThanOrEqual(at);
    } finally {
      api.close();
    }
  });

  it('covers an exchange stored just before the page: its summary is sent first', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      const { epoch } = await api.send<{ epoch: string }>({ command: 'watchKnownValues', on: true });
      await caughtUp(api, epoch);
      for (let i = 0; i < 5; i++) {
        await httpViaProxy(backend.proxyPort, `${base}/just-before-${i}`, {
          authorization: `Bearer ${token(100 + i)}`,
        });
        const page = await api.send<KnownPage>({ command: 'getKnownValues', epoch, after: 0 });
        // Whatever the batcher held went out before the reply: the window has the summary, and
        // the page (or a push before it) has its value.
        expect(exchangesIn(api.messages).some((e) => e.path === `/just-before-${i}`)).toBe(true);
        const all = [...page.values, ...pushes(api.messages).flatMap((p) => p.values)];
        expect(all).toContain(token(100 + i));
      }
    } finally {
      api.close();
    }
  });

  it('sends what getExchange’s exchange taught before the detail, while watching', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      const { epoch } = await api.send<{ epoch: string }>({ command: 'watchKnownValues', on: true });
      await caughtUp(api, epoch);
      await httpViaProxy(backend.proxyPort, `${base}/detail`, { authorization: `Bearer ${token(200)}` });
      // The id, from the proxy's first message about it, if it's out yet; else ask for the list.
      let id: string | undefined;
      await expect
        .poll(() => (id = exchangesIn(api.messages).find((e) => e.path === '/detail')?.id))
        .toBeTruthy();
      const before = pushes(api.messages).flatMap((p) => p.values);
      const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id! });
      expect(detail.responseHeaders).toContainEqual(['x-echo', `you sent ${token(200)}`]);
      const after = pushes(api.messages).flatMap((p) => p.values);
      expect([...before, ...after]).toContain(token(200));
    } finally {
      api.close();
    }
  });

  it('starts a new, empty epoch on Clear', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      const { epoch } = await api.send<{ epoch: string }>({ command: 'watchKnownValues', on: true });
      const before = await caughtUp(api, epoch);
      expect(before.flatMap((p) => p.values).length).toBeGreaterThan(0);
      await api.send({ command: 'clear' });
      const after = await api.send<KnownPage>({
        command: 'getKnownValues',
        epoch,
        after: before.at(-1)!.next,
      });
      expect(after.epoch).not.toBe(epoch);
      expect(after).toMatchObject({ values: [], next: 0, done: true });
    } finally {
      api.close();
    }
  });

  it('tells the window of a Clear before anything about the new, empty set', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      const { epoch } = await api.send<{ epoch: string }>({ command: 'watchKnownValues', on: true });
      await caughtUp(api, epoch);
      // Asked right behind the Clear, so it's answered while the Clear is still finishing.
      const clearing = api.send({ command: 'clear' });
      const page = await api.send<KnownPage>({ command: 'getKnownValues', epoch, after: 0 });
      const seenByThen = api.messages.length;
      await clearing;
      expect(page.epoch).not.toBe(epoch);
      expect(api.messages.slice(0, seenByThen).some((m) => m.type === 'cleared')).toBe(true);
    } finally {
      api.close();
    }
  });

  it('refuses arguments of the wrong shape', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      await api.send({ command: 'watchKnownValues', on: true });
      await expect(api.send({ command: 'getKnownValues', after: -1 })).rejects.toThrow('whole number');
      await expect(api.send({ command: 'getKnownValues', after: 1.5 })).rejects.toThrow('whole number');
      await expect(
        api.send({ command: 'getKnownValues', epoch: 5 as unknown as string, after: 0 }),
      ).rejects.toThrow('epoch must be a string');
      await expect(
        api.send({ command: 'watchKnownValues', on: 'yes' as unknown as boolean }),
      ).rejects.toThrow('true or false');
    } finally {
      api.close();
    }
  });

  it('stops collecting once no window has been connected for a while, and goes on while one is', async () => {
    const api = await apiClient(backend.apiPort);
    await api.send({ command: 'watchKnownValues', on: true });
    // Connected past the idle time: still collecting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await api.send({ command: 'getKnownValues', after: 0 });
    api.close();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const again = await apiClient(backend.apiPort);
    try {
      await expect(again.send({ command: 'getKnownValues', after: 0 })).rejects.toThrow(
        'aren’t being collected',
      );
      // Watching again works, under a new epoch.
      await again.send({ command: 'watchKnownValues', on: true });
      expect((await again.send<KnownPage>({ command: 'getKnownValues', after: 0 })).done).toBe(true);
    } finally {
      again.close();
    }
  });

  it('stops collecting when turned off', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      await api.send({ command: 'watchKnownValues', on: true });
      expect(await api.send({ command: 'watchKnownValues', on: false })).toEqual({});
      await expect(api.send({ command: 'getKnownValues', after: 0 })).rejects.toThrow(
        'aren’t being collected',
      );
      const count = pushes(api.messages).length;
      await httpViaProxy(backend.proxyPort, `${base}/off`, { authorization: `Bearer ${token(300)}` });
      await expect.poll(() => exchangesIn(api.messages).some((e) => e.path === '/off')).toBe(true);
      expect(pushes(api.messages).length).toBe(count);
    } finally {
      api.close();
    }
  });
});
