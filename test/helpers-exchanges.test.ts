/**
 * exchangesIn: every copy of every exchange a test's API client has been sent, including those in
 * the backend's hello. Leaving the hello out missed an exchange that had finished before the client
 * connected, which on a slow Windows runner made trailers.test.ts fail with no copies at all.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import type { ExchangeSummary, ServerMessage } from '../src/shared/api';
import {
  apiClient,
  exchangesIn,
  latestExchange,
  startBackendOnPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

const summary = (id: string, extra: Partial<ExchangeSummary> = {}) => ({ id, ...extra }) as ExchangeSummary;

describe('exchangesIn', () => {
  it('reads the hello first, then each update, and nothing else', () => {
    const messages = [
      { type: 'hello', status: {}, exchanges: [summary('a'), summary('b')], paused: false },
      { type: 'cleared' },
      { type: 'exchanges', exchanges: [summary('b', { status: 200 })], removed: [] },
      { type: 'exchanges', exchanges: [summary('c')], removed: ['a'] },
    ] as unknown as ServerMessage[];
    expect(exchangesIn(messages).map((e) => e.id)).toEqual(['a', 'b', 'b', 'c']);
    expect(latestExchange(messages, (e) => e.id === 'b')?.status).toBe(200);
  });

  it('is empty with no exchanges at all', () => {
    expect(
      exchangesIn([
        { type: 'hello', status: {}, exchanges: [], paused: false },
      ] as unknown as ServerMessage[]),
    ).toEqual([]);
  });
});

describe('an API client that connects after an exchange has finished', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-helpers-'));
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
    });
  });

  afterAll(async () => {
    await backend?.stop();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('sees it, finished, from the hello alone', async () => {
    const url = `http://127.0.0.1:${port}/finished-before`;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: backend.proxyPort, path: url }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    // Wait, with another client, until the exchange's last update has gone out.
    const first = await apiClient(backend.apiPort);
    await expect.poll(() => latestExchange(first.messages, (e) => e.url === url)?.durationMs).toBeDefined();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 600));

    const late = await apiClient(backend.apiPort);
    try {
      // Nothing more is coming for it: only the hello has it.
      expect(late.messages.filter((m) => m.type === 'exchanges')).toEqual([]);
      const seen = latestExchange(late.messages, (e) => e.url === url);
      expect(seen?.status).toBe(200);
      expect(seen?.durationMs).toBeDefined();
    } finally {
      late.close();
    }
  });
});
