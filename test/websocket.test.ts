import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { WebSocketStore } from '../src/backend/websocket-store';
import type { WebSocketMessages } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

/** Opens a CONNECT tunnel through the proxy. */
function tunnel(proxyPort: number, target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.once('connect', (_res, socket) => resolve(socket));
    req.once('error', reject);
    req.end();
  });
}

describe('WebSocketStore', () => {
  const msg = (text: string, fromClient = true) => ({
    fromClient,
    content: Buffer.from(text),
    isBinary: false,
    time: 0,
  });

  it('numbers messages per connection and returns those after an index', () => {
    const store = new WebSocketStore();
    store.add('a', msg('one'));
    store.add('b', msg('other'));
    store.add('a', msg('two', false));
    expect(store.count('a')).toBe(2);
    const after0 = store.get('a', 0);
    expect(after0.total).toBe(2);
    expect(
      after0.messages.map((m) => [m.index, m.fromClient, Buffer.from(m.base64, 'base64').toString()]),
    ).toEqual([[1, false, 'two']]);
  });

  it('keeps at most maxMessageBytes of each message but records its full size', () => {
    const store = new WebSocketStore({ maxMessageBytes: 4 });
    store.add('a', msg('0123456789'));
    const [m] = store.get('a').messages;
    expect(m!.size).toBe(10);
    expect(Buffer.from(m!.base64, 'base64').toString()).toBe('0123');
  });

  it('drops the oldest messages across connections to stay within the budget', () => {
    const store = new WebSocketStore({ maxTotalBytes: 10 });
    store.add('a', msg('aaaa'));
    store.add('b', msg('bbbb'));
    store.add('a', msg('cccc')); // 12 bytes now: the first 'a' message goes.
    expect(store.bytes).toBe(8);
    expect(store.get('a')).toMatchObject({ dropped: 1, total: 2 });
    expect(store.get('a').messages.map((m) => m.index)).toEqual([1]);
    expect(store.get('b').messages).toHaveLength(1);
  });

  it('forgets a deleted connection, and its bytes', () => {
    const store = new WebSocketStore();
    store.add('a', msg('abc'));
    store.delete('a');
    expect(store.bytes).toBe(0);
    expect(store.get('a')).toEqual({ messages: [], dropped: 0, total: 0 });
  });
});

describe('WebSocket messages through the proxy', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-ws-test-'));
    upstream = getLocal();
    await upstream.forAnyWebSocket().thenEcho();
    await upstream.start();
    backend = await startBackend({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });
  });

  afterAll(async () => {
    await backend?.stop();
    await upstream?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('records text and binary messages in both directions, in order, and the close reason', async () => {
    const api = await apiClient(backend.apiPort);
    const target = `localhost:${upstream.port}`;
    const socket = await tunnel(backend.proxyPort, target);
    const ws = new WebSocket(`ws://${target}/live`, { createConnection: () => socket });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const replies: string[] = [];
    ws.on('message', (data, isBinary) => replies.push(isBinary ? 'binary' : data.toString()));
    ws.send('{"hello":"world"}');
    await expect.poll(() => replies.length).toBe(1);
    ws.send(Buffer.from([0, 1, 2, 255]), { binary: true });
    await expect.poll(() => replies.length).toBe(2);
    ws.close(4000, 'done here');

    const exchange = async () =>
      exchangesIn(api.messages)
        .filter((e) => e.path === '/live')
        .at(-1);
    await expect.poll(async () => (await exchange())?.closeCode).toBe(4000);
    expect(await exchange()).toMatchObject({ messageCount: 4, closeReason: 'done here', websocket: true });

    const { messages, total, dropped } = await api.send<WebSocketMessages>({
      command: 'getWebSocketMessages',
      exchangeId: (await exchange())!.id,
    });
    expect({ total, dropped }).toEqual({ total: 4, dropped: 0 });
    expect(
      messages.map((m) => [
        m.index,
        m.fromClient ? 'client' : 'server',
        m.isBinary,
        m.isBinary
          ? Buffer.from(m.base64, 'base64').toJSON().data
          : Buffer.from(m.base64, 'base64').toString(),
      ]),
    ).toEqual([
      [0, 'client', false, '{"hello":"world"}'],
      [1, 'server', false, '{"hello":"world"}'],
      [2, 'client', true, [0, 1, 2, 255]],
      [3, 'server', true, [0, 1, 2, 255]],
    ]);
    expect(messages.every((m, i) => i === 0 || m.time >= messages[i - 1]!.time)).toBe(true);

    const later = await api.send<WebSocketMessages>({
      command: 'getWebSocketMessages',
      exchangeId: (await exchange())!.id,
      after: 1,
    });
    expect(later.messages.map((m) => m.index)).toEqual([2, 3]);
    api.close();
  });
});
