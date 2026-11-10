/**
 * The window's connection to the backend's API (src/renderer/src/api-client.ts), against a real
 * WebSocket server: every other window test replaces it with a fake.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { ApiClient } from '../src/renderer/src/api-client';
import { API_PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ServerMessage } from '../src/shared/api';

let server: WebSocketServer;
let url: string;
/** The server's side of the latest connection, and what it received. */
let socket: ServerSocket;
let received: Array<Record<string, unknown>>;
let protocols: string[];

beforeEach(async () => {
  received = [];
  server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (offered) => {
      protocols = [...offered];
      return API_PROTOCOL;
    },
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterEach(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
});

/** A client connected to the server, with what it was told. */
async function connected() {
  const messages: ServerMessage[] = [];
  const onClose = vi.fn();
  const serverSide = new Promise<ServerSocket>((resolve) => server.once('connection', resolve));
  const client = new ApiClient({ apiUrl: url, token: 'secret-token' }, (m) => messages.push(m), onClose);
  socket = await serverSide;
  socket.on('message', (data) => received.push(JSON.parse(String(data))));
  // Commands can go once the client's own socket is open.
  const own = (client as unknown as { socket: WebSocket }).socket;
  await vi.waitFor(() => expect(own.readyState).toBe(WebSocket.OPEN));
  return { client, messages, onClose };
}
const reply = (message: ServerMessage) => socket.send(JSON.stringify(message));

describe('ApiClient', () => {
  it('connects with the API protocol and the token', async () => {
    await connected();
    expect(protocols).toEqual([API_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}secret-token`]);
  });

  it('numbers each command, and resolves each with its own result, in any order', async () => {
    const { client } = await connected();
    const first = client.send({ command: 'getStatus' } as never);
    const second = client.send({ command: 'getExchange', exchangeId: 'a' });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      { command: 'getStatus', id: 1 },
      { command: 'getExchange', exchangeId: 'a', id: 2 },
    ]);
    reply({ type: 'result', id: 2, ok: true, value: { second: true } });
    reply({ type: 'result', id: 1, ok: true, value: 'first' });
    expect(await second).toEqual({ second: true });
    expect(await first).toBe('first');
    // Answered commands aren't kept: a long session sends many thousands.
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it('rejects a command the backend refused, with its message', async () => {
    const { client } = await connected();
    const refused = client.send({ command: 'getExchange', exchangeId: 'gone' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    reply({ type: 'result', id: 1, ok: false, error: 'Exchange not found' });
    await expect(refused).rejects.toThrow('Exchange not found');
  });

  it('passes other messages on, and not results', async () => {
    const { client, messages } = await connected();
    const pending = client.send({ command: 'clear' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    reply({ type: 'paused', paused: true } as ServerMessage);
    reply({ type: 'result', id: 1, ok: true });
    await pending;
    expect(messages).toEqual([{ type: 'paused', paused: true }]);
  });

  it('ignores a result for no command it sent', async () => {
    const { client, messages } = await connected();
    reply({ type: 'result', id: 99, ok: true, value: 'stray' });
    const pending = client.send({ command: 'clear' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    reply({ type: 'result', id: 1, ok: true, value: 'mine' });
    expect(await pending).toBe('mine');
    expect(messages).toEqual([]);
  });

  it('rejects every unanswered command when the connection closes, and says it closed', async () => {
    const { client, onClose } = await connected();
    const a = client.send({ command: 'clear' });
    const b = client.send({ command: 'getStatus' } as never);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    socket.close();
    await expect(a).rejects.toThrow('Disconnected');
    await expect(b).rejects.toThrow('Disconnected');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
  });

  it('closes its connection when asked', async () => {
    const { client, onClose } = await connected();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    client.close();
    await closed;
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
