import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { expect } from 'vitest';
import WebSocket from 'ws';
import {
  API_PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ClientCommand,
  type ExchangeSummary,
  type ServerMessage,
} from '../src/shared/api';

export const TOKEN = 'test-token-0123456789';
export const UI_ORIGIN = 'http://localhost:5173';

/** Sends one HTTPS request through an HTTP proxy using CONNECT, trusting only `ca`. */
export function requestViaProxy(
  proxyPort: number,
  url: string,
  ca: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
    });
    connect.once('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT failed: ${res.statusCode}`));
      const req = https.request(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: options.method ?? 'GET',
          headers: options.headers,
          ca,
          servername: target.hostname,
          // Run TLS over the CONNECT tunnel.
          createConnection: () => tls.connect({ socket, servername: target.hostname, ca }),
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      req.once('error', reject);
      req.end(options.body);
    });
    connect.once('error', reject);
    connect.end();
  });
}

export function connectApi(
  port: number,
  opts: { token?: string; origin?: string; host?: string } = {},
): WebSocket {
  const protocols = [API_PROTOCOL];
  if (opts.token !== undefined) protocols.push(`${TOKEN_PROTOCOL_PREFIX}${opts.token}`);
  return new WebSocket(`ws://127.0.0.1:${port}/`, protocols, {
    headers: {
      ...(opts.origin ? { Origin: opts.origin } : {}),
      ...(opts.host ? { Host: opts.host } : {}),
    },
  });
}

/** All exchange updates pushed so far, oldest first. */
export function exchangesIn(messages: ServerMessage[]): ExchangeSummary[] {
  return messages.flatMap((m) => (m.type === 'exchanges' ? m.exchanges : []));
}

export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Opens an authorised API connection that can send commands and collects pushed messages. */
export async function apiClient(port: number) {
  const ws = connectApi(port, { token: TOKEN, origin: UI_ORIGIN });
  const messages: ServerMessage[] = [];
  const waiting = new Map<number, (m: Extract<ServerMessage, { type: 'result' }>) => void>();
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    if (message.type === 'result') waiting.get(message.id)?.(message);
    else messages.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  return {
    messages,
    close: () => ws.close(),
    async send<T>(command: DistributiveOmit<ClientCommand, 'id'>): Promise<T> {
      const id = nextId++;
      const result = await new Promise<Extract<ServerMessage, { type: 'result' }>>((resolve) => {
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ ...command, id }));
      });
      if (!result.ok) throw new Error(result.error);
      return result.value as T;
    },
    /** Waits for the exchange at `pathAndQuery` to finish and returns its id. */
    async completed(pathAndQuery: string): Promise<string> {
      let found: ExchangeSummary | undefined;
      await expect
        .poll(() => {
          found = exchangesIn(messages).find((e) => e.path === pathAndQuery && e.status !== undefined);
          return found;
        })
        .toBeTruthy();
      return found!.id;
    },
  };
}

export function rejectedStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('Connection was accepted')));
    ws.once('error', () => undefined);
  });
}
