/**
 * Clients that close their side after sending a whole request, and wait for the answer. BusyBox
 * wget (Alpine's) does this for every HTTPS URL through a proxy: measured November 9, 2026, it
 * sends `GET https://example.com/ HTTP/1.1` in plain text to http_proxy, then closes its side
 * 1 ms later. For http:// URLs it doesn't.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import type { ServerMessage } from '../src/shared/api';
import { apiClient, exchangesIn, startBackendOnPickedPort, TOKEN, UI_ORIGIN } from './helpers';

interface Answer {
  /** Everything the proxy sent back. */
  text: string;
  /** Whether the proxy closed the connection (within the wait). */
  closed: boolean;
}

/**
 * Sends `raw` to the proxy, then closes this side (unless `halfClose` is false), and collects
 * what comes back until the proxy closes the connection or `waitMs` passes.
 */
function send(port: number, raw: string, { halfClose = true, waitMs = 5000 } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => {
      if (raw) socket.write(raw);
      if (halfClose) socket.end();
    });
    let text = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => (text += chunk));
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ text, closed: false });
    }, waitMs);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ text, closed: true });
    });
    socket.on('error', reject);
  });
}

const request = (url: string, host: string): string =>
  `GET ${url} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Wget\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

describe('A client that closes its side after its request', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-half-close-'));
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream.forGet('/hello').thenReply(200, 'hello from upstream');
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await upstream?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('still gets the answer to an https:// URL sent in plain text, as BusyBox wget sends it', async () => {
    const api = await apiClient(backend.apiPort);
    try {
      const url = `https://localhost:${upstream.port}/hello`;
      const answer = await send(backend.proxyPort, request(url, `localhost:${upstream.port}`));
      expect(answer.text).toMatch(/^HTTP\/1\.1 200 /);
      expect(answer.text).toContain('hello from upstream');
      // The proxy closes the connection once it has answered.
      expect(answer.closed).toBe(true);
      // And it's in Traffic, as answered.
      await expect.poll(() => exchangesIn(api.messages).find((e) => e.url === url)?.status).toBe(200);
    } finally {
      api.close();
    }
  });

  it('is answered, then closed, when it asked to keep the connection', async () => {
    const url = `https://localhost:${upstream.port}/hello`;
    const keepAlive = request(url, `localhost:${upstream.port}`).replace(
      'Connection: close',
      'Connection: keep-alive',
    );
    const answer = await send(backend.proxyPort, keepAlive);
    expect(answer.text).toMatch(/^HTTP\/1\.1 200 /);
    expect(answer.text).toContain('hello from upstream');
    // Its side is closed, so there's nothing more to come: not left open.
    expect(answer.closed).toBe(true);
  });

  it('is taken as gone after a plain http:// URL, as when a browser cancels one', async () => {
    const api = await apiClient(backend.apiPort);
    const slow = getLocal();
    await slow.start();
    try {
      // Answers after the client closed its side: too late, the request was given up.
      await slow.forGet('/plain').thenCallback(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { statusCode: 200, body: 'plain answer' };
      });
      const url = `http://localhost:${slow.port}/plain`;
      const answer = await send(backend.proxyPort, request(url, `localhost:${slow.port}`));
      expect(answer.closed).toBe(true);
      expect(answer.text).not.toContain('plain answer');
      // Recorded a moment later on a slow runner (Windows CI was over a second).
      await expect
        .poll(() => exchangesIn(api.messages).find((e) => e.url === url)?.failure?.code, { timeout: 10_000 })
        .toBe('CLIENT_CLOSED');
    } finally {
      api.close();
      await slow.stop();
    }
  }, 20_000);

  it('is answered the same when it keeps its side open', async () => {
    const url = `https://localhost:${upstream.port}/hello`;
    const answer = await send(backend.proxyPort, request(url, `localhost:${upstream.port}`), {
      halfClose: false,
      waitMs: 1500,
    });
    expect(answer.text).toMatch(/^HTTP\/1\.1 200 /);
    expect(answer.text).toContain('hello from upstream');
  });
});

describe('A client that closes its side without a whole request', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let messages: ServerMessage[];
  let closeApi: () => void;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-half-close-'));
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
    });
    const api = await apiClient(backend.apiPort);
    messages = api.messages;
    closeApi = api.close;
  });

  afterAll(async () => {
    closeApi?.();
    await backend?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is closed straight away when it sent nothing at all, not left open', async () => {
    const answer = await send(backend.proxyPort, '', { waitMs: 3000 });
    expect(answer).toEqual({ text: '', closed: true });
  });

  it('is closed when it stops partway through the request, and nothing is sent upstream', async () => {
    const answer = await send(backend.proxyPort, 'GET https://example.com/partial HTTP/1.1\r\nHost: exa', {
      waitMs: 3000,
    });
    expect(answer.closed).toBe(true);
    expect(answer.text).not.toMatch(/^HTTP\/1\.1 200 /);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exchangesIn(messages).some((e) => e.path === '/partial')).toBe(false);
  });
});
