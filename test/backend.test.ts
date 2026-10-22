import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import { chromiumArgs } from '../src/backend/browsers';
import {
  API_PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ExchangeSummary,
  type ServerMessage,
} from '../src/shared/api';

const TOKEN = 'test-token-0123456789';
const UI_ORIGIN = 'http://localhost:5173';

/** Sends one HTTPS request through an HTTP proxy using CONNECT, trusting only `ca`. */
function requestViaProxy(
  proxyPort: number,
  url: string,
  ca: string,
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
          method: 'GET',
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
      req.end();
    });
    connect.once('error', reject);
    connect.end();
  });
}

function connectApi(port: number, opts: { token?: string; origin?: string; host?: string } = {}): WebSocket {
  const protocols = [API_PROTOCOL];
  if (opts.token !== undefined) protocols.push(`${TOKEN_PROTOCOL_PREFIX}${opts.token}`);
  return new WebSocket(`ws://127.0.0.1:${port}/`, protocols, {
    headers: {
      ...(opts.origin ? { Origin: opts.origin } : {}),
      ...(opts.host ? { Host: opts.host } : {}),
    },
  });
}

function rejectedStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('Connection was accepted')));
    ws.once('error', () => undefined);
  });
}

describe('backend', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-test-'));

    // A local HTTPS server standing in for a real website, with its own CA.
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream.forGet('/hello').thenReply(200, 'hello from upstream');

    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await upstream?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a CA in the data folder with a private key only the user can read', async () => {
    const keyStat = await stat(path.join(dataDir, 'ca.key'));
    expect(keyStat.mode & 0o077).toBe(0);
    const cert = await readFile(backend.caCertPath, 'utf8');
    expect(cert).toContain('BEGIN CERTIFICATE');
  });

  it('reuses the same CA on the next start', async () => {
    const first = await loadOrCreateCA(dataDir);
    const second = await loadOrCreateCA(dataDir);
    expect(second.spkiFingerprint).toBe(first.spkiFingerprint);
    expect(first.spkiFingerprint).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('intercepts HTTPS through the proxy and streams it to the UI', async () => {
    const ws = connectApi(backend.apiPort, { token: TOKEN, origin: UI_ORIGIN });
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const ca = await readFile(backend.caCertPath, 'utf8');
    const url = `https://localhost:${upstream.port}/hello?x=1`;
    const response = await requestViaProxy(backend.proxyPort, url, ca);
    expect(response).toEqual({ status: 200, body: 'hello from upstream' });

    await expect
      .poll(() =>
        messages.find(
          (m): m is Extract<ServerMessage, { type: 'exchange' }> =>
            m.type === 'exchange' && m.exchange.status !== undefined,
        ),
      )
      .toBeTruthy();

    const hello = messages[0];
    expect(hello?.type).toBe('hello');
    if (hello?.type === 'hello') expect(hello.status.proxyPort).toBe(backend.proxyPort);

    const completed = messages
      .filter((m) => m.type === 'exchange')
      .map((m) => (m as { exchange: ExchangeSummary }).exchange)
      .find((e) => e.status !== undefined);
    expect(completed).toMatchObject({
      method: 'GET',
      status: 200,
      host: `localhost:${upstream.port}`,
      path: '/hello?x=1',
      protocol: 'https',
    });
    ws.close();
  });

  it('rejects API connections without the right token', async () => {
    expect(await rejectedStatus(connectApi(backend.apiPort, { origin: UI_ORIGIN }))).toBe(401);
    expect(await rejectedStatus(connectApi(backend.apiPort, { token: 'wrong', origin: UI_ORIGIN }))).toBe(
      401,
    );
  });

  it('rejects API connections from other origins or hosts', async () => {
    expect(
      await rejectedStatus(connectApi(backend.apiPort, { token: TOKEN, origin: 'https://evil.example' })),
    ).toBe(403);
    expect(
      await rejectedStatus(
        connectApi(backend.apiPort, {
          token: TOKEN,
          origin: UI_ORIGIN,
          host: `evil.example:${backend.apiPort}`,
        }),
      ),
    ).toBe(403);
  });
});

describe('chromiumArgs', () => {
  it('routes through the proxy, trusts the CA by SPKI and disables QUIC', () => {
    const args = chromiumArgs({ proxyPort: 8000, spkiFingerprint: 'abc=', profileDir: '/tmp/p' });
    expect(args).toContain('--proxy-server=127.0.0.1:8000');
    expect(args).toContain('--ignore-certificate-errors-spki-list=abc=');
    expect(args).toContain('--user-data-dir=/tmp/p');
    expect(args).toContain('--disable-quic');
  });
});
