/**
 * The local API server's per-connection context (src/backend/api.ts): each command learns which
 * connection it came on, can message only that one, and hears when it closes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { startApiServer, type CommandContext, type RunningApiServer } from '../src/backend/api';
import type { ClientCommand, ServerMessage } from '../src/shared/api';
import { connectApi, TOKEN, UI_ORIGIN } from './helpers';

let server: RunningApiServer;
let contexts: CommandContext[];

beforeEach(async () => {
  contexts = [];
  server = await startApiServer({
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    handlers: {
      hello: () => ({ type: 'cleared' }),
      command: async (command: ClientCommand, context) => {
        contexts.push(context);
        if (command.command === 'setPaused') context.notify({ type: 'paused', paused: command.paused });
        return 'ok';
      },
    },
  });
});
afterEach(async () => {
  await server.stop();
});

async function client(): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  const ws = connectApi(server.port, { token: TOKEN, origin: UI_ORIGIN });
  const messages: ServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await expect.poll(() => messages.length).toBe(1);
  return { ws, messages };
}
const send = (ws: WebSocket, command: Record<string, unknown>) => ws.send(JSON.stringify(command));

describe('the API server’s command context', () => {
  it('gives each command its connection’s context, the same for every command on it', async () => {
    const a = await client();
    const b = await client();
    send(a.ws, { id: 1, command: 'clear' });
    send(a.ws, { id: 2, command: 'clear' });
    send(b.ws, { id: 1, command: 'clear' });
    await expect.poll(() => contexts.length).toBe(3);
    expect(contexts[0]!.signal).toBe(contexts[1]!.signal);
    expect(contexts[2]!.signal).not.toBe(contexts[0]!.signal);
    a.ws.close();
    b.ws.close();
  });

  it('notify reaches only the connection the command came on', async () => {
    const a = await client();
    const b = await client();
    send(a.ws, { id: 1, command: 'setPaused', paused: true });
    await expect.poll(() => a.messages.some((m) => m.type === 'paused')).toBe(true);
    await expect.poll(() => a.messages.some((m) => m.type === 'result')).toBe(true);
    expect(b.messages.map((m) => m.type)).toEqual(['cleared']);
    a.ws.close();
    b.ws.close();
  });

  it('its signal aborts when that connection closes, and not before', async () => {
    const a = await client();
    const b = await client();
    send(a.ws, { id: 1, command: 'clear' });
    send(b.ws, { id: 1, command: 'clear' });
    await expect.poll(() => contexts.length).toBe(2);
    const [ofA, ofB] = contexts;
    expect(ofA!.signal.aborted).toBe(false);
    a.ws.close();
    await expect.poll(() => ofA!.signal.aborted).toBe(true);
    expect(ofB!.signal.aborted).toBe(false);
    // Notifying a closed connection does nothing, and doesn't throw.
    expect(() => ofA!.notify({ type: 'cleared' })).not.toThrow();
    b.ws.close();
    await expect.poll(() => ofB!.signal.aborted).toBe(true);
  });

  it('a stopped server aborts every connection’s signal', async () => {
    const a = await client();
    send(a.ws, { id: 1, command: 'clear' });
    await expect.poll(() => contexts.length).toBe(1);
    await server.stop();
    await expect.poll(() => contexts[0]!.signal.aborted).toBe(true);
    // afterEach stops it again: harmless.
    server = { ...server, stop: async () => undefined };
  });
});
