import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCACertificate } from 'mockttp';
import WebSocket, { WebSocketServer } from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BodyContent, ExchangeDetail } from '../src/shared/api';
import {
  apiClient,
  latestExchange,
  localhostCertificate,
  requestViaProxy,
  TOKEN,
  tunnelThroughProxy,
  UI_ORIGIN,
} from './helpers';

// A plain-http request may offer to switch protocols: Apache HttpClient 5.6 sends "Upgrade:
// TLS/1.2" on every one, and curl --http2 "Upgrade: h2c". Mockttp handled every such request as a
// WebSocket; when the server answered normally, the client got a chunked header with an unframed
// body. Wirescry patches Mockttp (scripts/patch-mockttp.mjs) to handle them as ordinary requests,
// and not to pass the offer on.

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const CHUNKS = ['first part, ', 'second part'];

describe('requests offering an upgrade other than WebSocket, through Wirescry', () => {
  let dataDir: string;
  let backend: RunningBackend;
  // Ignores upgrade offers and answers as usual, as most servers do (example.com among them).
  let upstream: http.Server;
  let upstreamPort: number;
  // Takes any upgrade it's offered: it must never be offered one but WebSocket's through Wirescry.
  let eager: http.Server;
  let eagerPort: number;
  // The same over TLS, which Wirescry opens (the client trusts Wirescry's certificate).
  let secure: https.Server;
  let securePort: number;
  let ca: string;
  let wss: WebSocketServer;
  const seen: Seen[] = [];
  const upgradesSeen: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-upgrade-'));
    const respond = (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url!.startsWith('/gzip')) {
          // Chunked and compressed, as example.com answered Apache's request.
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          const gz = zlib.gzipSync(CHUNKS.join(''));
          res.write(gz.subarray(0, 10));
          res.end(gz.subarray(10));
          return;
        }
        // Chunked: written in parts, with no length.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write(CHUNKS[0]);
        setTimeout(() => res.end(CHUNKS[1]! + (body ? ` / got ${body}` : '')), 20);
      });
    };
    upstream = http.createServer(respond);
    eager = http.createServer(respond);
    const upstreamCA = await generateCACertificate();
    secure = https.createServer(await localhostCertificate(upstreamCA), respond);
    wss = new WebSocketServer({ noServer: true });
    eager.on('upgrade', (req, socket, head) => {
      upgradesSeen.push(String(req.headers.upgrade));
      if (String(req.headers.upgrade).toLowerCase() === 'websocket') {
        wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(`echo ${data}`)));
        return;
      }
      socket.end(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${req.headers.upgrade}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => eager.listen(0, '127.0.0.1', resolve));
    eagerPort = (eager.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
    securePort = (secure.address() as net.AddressInfo).port;
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
    ca = await readFile(backend.caCertPath, 'utf8');
  });

  afterAll(async () => {
    await backend?.stop();
    wss?.close();
    for (const server of [upstream, eager, secure]) {
      server?.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * Sends a request through the proxy with Node's client, which reads chunked bodies strictly.
   * Resolves with what arrived, or rejects (for a body that isn't framed as its headers say).
   */
  const viaWirescry = (
    urlPath: string,
    headers: Record<string, string>,
    body?: string,
    port = upstreamPort,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: backend.proxyPort,
          method: body === undefined ? 'GET' : 'POST',
          path: `http://127.0.0.1:${port}${urlPath}`,
          headers,
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => parts.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) }),
          );
          res.on('error', reject);
        },
      );
      req.on('upgrade', () => reject(new Error('switched protocols')));
      req.on('error', reject);
      req.end(body);
    });

  const lastSeen = (urlPath: string) => seen.filter((s) => s.url === urlPath).at(-1);

  it("answers Apache HttpClient 5.6's TLS upgrade offer with the server's response, framed as sent", async () => {
    const response = await viaWirescry('/apache?n=1', {
      'accept-encoding': 'gzip, deflate, x-gzip',
      upgrade: 'TLS/1.2',
      connection: 'Upgrade',
    });
    expect(response.status).toBe(200);
    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(response.body.toString()).toBe(CHUNKS.join(''));
  });

  it('keeps a compressed, chunked body intact', async () => {
    const response = await viaWirescry('/gzip?n=1', { upgrade: 'TLS/1.2', connection: 'Upgrade' });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(response.body).toString()).toBe(CHUNKS.join(''));
  });

  it("answers curl --http2's h2c offer over HTTP/1.1", async () => {
    const response = await viaWirescry('/h2c?n=1', {
      connection: 'Upgrade, HTTP2-Settings',
      upgrade: 'h2c',
      'http2-settings': 'AAMAAABkAAQAoAAAAAIAAAAA',
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(CHUNKS.join(''));
  });

  it("doesn't pass the offer on, so a server that takes upgrades answers normally", async () => {
    const before = upgradesSeen.length;
    const response = await viaWirescry(
      '/h2c?n=2',
      {
        connection: 'keep-alive, Upgrade, HTTP2-Settings',
        upgrade: 'h2c',
        'http2-settings': 'AAMAAABkAAQAoAAAAAIAAAAA',
        'x-other': 'kept',
      },
      undefined,
      eagerPort,
    );
    expect(response.body.toString()).toBe(CHUNKS.join(''));
    expect(upgradesSeen.length).toBe(before);
    const got = lastSeen('/h2c?n=2')!;
    expect(got.headers.upgrade).toBeUndefined();
    expect(got.headers['http2-settings']).toBeUndefined();
    // The rest of Connection, and other headers, go on as sent.
    expect(got.headers.connection).toBe('keep-alive');
    expect(got.headers['x-other']).toBe('kept');
  });

  it('passes on a request body sent with an offer', async () => {
    const response = await viaWirescry(
      '/post?n=1',
      { upgrade: 'TLS/1.2', connection: 'Upgrade', 'content-type': 'text/plain' },
      'hello there',
    );
    expect(response.body.toString()).toBe(`${CHUNKS.join('')} / got hello there`);
    expect(lastSeen('/post?n=1')).toMatchObject({ method: 'POST', body: 'hello there' });
  });

  it('records it as an ordinary exchange, with the headers the client sent and the body', async () => {
    const api = await apiClient(backend.apiPort);
    await viaWirescry('/recorded?n=1', { upgrade: 'TLS/1.2', connection: 'Upgrade' });
    const id = await api.completed('/recorded?n=1');
    // The newest copy: the first can come before the response.
    const summary = latestExchange(api.messages, (e) => e.id === id)!;
    expect(summary.websocket).toBeFalsy();
    expect(summary.status).toBe(200);
    const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId: id });
    expect(detail.requestHeaders).toContainEqual(['upgrade', 'TLS/1.2']);
    expect(detail.requestHeaders).toContainEqual(['connection', 'Upgrade']);
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId: id, side: 'response' });
    expect(Buffer.from(body.base64, 'base64').toString()).toBe(CHUNKS.join(''));
  });

  it("leaves an Upgrade header alone when the request offers no upgrade (Connection doesn't name it)", async () => {
    await viaWirescry('/no-offer?n=1', { upgrade: 'TLS/1.2', 'x-other': 'kept' });
    expect(lastSeen('/no-offer?n=1')!.headers.upgrade).toBe('TLS/1.2');
  });

  it('takes "upgrade" out of a Connection header that names it with no Upgrade header', async () => {
    const response = await viaWirescry('/no-upgrade-header?n=1', { connection: 'keep-alive, Upgrade' });
    expect(response.body.toString()).toBe(CHUNKS.join(''));
    expect(lastSeen('/no-upgrade-header?n=1')!.headers.connection).toBe('keep-alive');
  });

  it('handles an offer naming WebSocket among others as an ordinary request', async () => {
    // Mockttp's WebSocket server takes an Upgrade of "websocket" alone, so this would fail there.
    const before = upgradesSeen.length;
    const response = await viaWirescry(
      '/mixed?n=1',
      { connection: 'Upgrade', upgrade: 'h2c, websocket' },
      undefined,
      eagerPort,
    );
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(CHUNKS.join(''));
    expect(upgradesSeen.length).toBe(before);
  });

  it('answers an offer sent through a CONNECT tunnel', async () => {
    const socket = await tunnelThroughProxy(backend.proxyPort, `127.0.0.1:${upstreamPort}`);
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          path: '/tunnel?n=1',
          headers: { upgrade: 'TLS/1.2', connection: 'Upgrade' },
          createConnection: () => socket,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(response).toEqual({ status: 200, body: CHUNKS.join('') });
    expect(lastSeen('/tunnel?n=1')!.headers.upgrade).toBeUndefined();
  });

  it('answers an offer made over https, which Wirescry opens', async () => {
    const response = await requestViaProxy(
      backend.proxyPort,
      `https://localhost:${securePort}/https?n=1`,
      ca,
      {
        headers: { upgrade: 'TLS/1.2', connection: 'Upgrade' },
      },
    );
    expect(response).toEqual({ status: 200, body: CHUNKS.join('') });
    expect(lastSeen('/https?n=1')!.headers.upgrade).toBeUndefined();
  });

  it('runs on a Node that honors shouldUpgradeCallback (24.9 and later), which the patch needs', async () => {
    // On an older Node the option is ignored and the original bug returns, silently.
    const server = http.createServer({ shouldUpgradeCallback: () => false }, (_req, res) =>
      res.end('request'),
    );
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, headers: { upgrade: 'h2c', connection: 'Upgrade' } },
          (res) => {
            let got = '';
            res.on('data', (chunk: Buffer) => (got += chunk));
            res.on('end', () => resolve(got));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body, `Node ${process.versions.node}`).toBe('request');
    } finally {
      server.close();
    }
  });

  it('still handles WebSockets as WebSockets', async () => {
    const api = await apiClient(backend.apiPort);
    const before = upgradesSeen.length;
    const socket = await tunnelThroughProxy(backend.proxyPort, `127.0.0.1:${eagerPort}`);
    const ws = new WebSocket(`ws://127.0.0.1:${eagerPort}/ws`, { createConnection: () => socket });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once('open', () => ws.send('hi'));
      ws.once('message', (data) => resolve(String(data)));
      ws.once('error', reject);
    });
    expect(reply).toBe('echo hi');
    ws.close();
    expect(upgradesSeen.slice(before)).toEqual(['websocket']);
    await expect.poll(() => latestExchange(api.messages, (e) => e.path === '/ws')?.websocket).toBe(true);
  });

  it('takes the word WebSocket in any case, as the standard says', async () => {
    // The ws library always sends "websocket", so this handshake is written out by hand.
    const socket = await tunnelThroughProxy(backend.proxyPort, `127.0.0.1:${eagerPort}`);
    socket.write(
      'GET /ws-mixed-case HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${eagerPort}\r\n` +
        'Upgrade: WebSocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const head = await new Promise<string>((resolve, reject) => {
      let got = '';
      socket.on('data', (chunk: Buffer) => {
        got += chunk.toString('latin1');
        if (got.includes('\r\n\r\n')) resolve(got.split('\r\n')[0]!);
      });
      socket.once('error', reject);
    });
    socket.destroy();
    expect(head).toBe('HTTP/1.1 101 Switching Protocols');
  });
});
