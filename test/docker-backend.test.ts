import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { MOUNT_POINT } from '../src/backend/docker/container';
import type { DockerEndpoint } from '../src/backend/docker/endpoint';
import type { ProxyStatus } from '../src/shared/api';
import { apiClient, exchangesIn, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** A daemon that records what it was asked to create. */
async function fakeDaemon(socketPath: string) {
  const creates: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.includes('/containers/create')) creates.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(req.url === '/_ping' ? 200 : 201, {
        'content-type': 'application/json',
        ostype: 'linux',
      });
      res.end(req.url === '/_ping' ? 'OK' : '{"Id":"c1"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    creates,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function dockerRequest(socketPath: string, method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path: url, headers: { host: 'docker', 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const relaySocket = (status: ProxyStatus): string =>
  status.terminalEnv.DOCKER_HOST!.replace(/^unix:\/\//, '');

describe('Docker setup in the backend', () => {
  let dataDir: string;
  let daemonDir: string;
  let daemon: Awaited<ReturnType<typeof fakeDaemon>>;
  let backend: RunningBackend;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let upstream: Mockttp;
  let local: http.Server;
  let localPort: number;
  let wss: WebSocketServer;
  let wsPort: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-docker-backend-'));
    daemonDir = await mkdtemp(path.join(os.tmpdir(), 'wd-'));
    const socketPath = path.join(daemonDir, 'docker.sock');
    daemon = await fakeDaemon(socketPath);
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream
      .forGet('/secure')
      .thenCallback((req) => ({ statusCode: 200, body: `secure, host ${req.headers.host}` }));
    // A dev server on this computer, which containers reach as host.docker.internal.
    local = http.createServer((req, res) => res.end(`local ${req.url}, host ${req.headers.host}`));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    localPort = (local.address() as net.AddressInfo).port;
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo ${m.toString()}`)));
    await new Promise((resolve) => wss.once('listening', resolve));
    wsPort = (wss.address() as net.AddressInfo).port;
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      dockerEndpoint: async () => ({ kind: 'local', socketPath, host: `unix://${socketPath}` }),
    });
    api = await apiClient(backend.apiPort);
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    await daemon?.close();
    await upstream?.stop();
    await new Promise((resolve) => local?.close(resolve));
    await new Promise((resolve) => wss?.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(daemonDir, { recursive: true, force: true });
  });

  const status = (): ProxyStatus => (api.messages[0] as { status: ProxyStatus }).status;

  it('says Docker is set up, and gives terminals DOCKER_HOST', async () => {
    expect(status().docker).toEqual({
      state: 'ready',
      daemon: expect.stringMatching(/^unix:\/\/.*docker\.sock$/),
    });
    expect(status().terminalEnv.DOCKER_HOST).toMatch(/^unix:\/\/.+\/docker\.sock$/);
    const script = await readFile(status().terminalScripts.posix!, 'utf8');
    expect(script).toContain(`export DOCKER_HOST='${status().terminalEnv.DOCKER_HOST}'`);
  });

  it("sets new containers up for this proxy's port, with the certificate folder", async () => {
    const reply = await dockerRequest(relaySocket(status()), 'POST', '/v1.47/containers/create', {
      Image: 'alpine',
    });
    expect(reply.status).toBe(201);
    const sent = daemon.creates.at(-1)!;
    expect(sent.Env).toContain(`HTTP_PROXY=http://host.docker.internal:${backend.proxyPort}`);
    const mount = (sent.HostConfig as { Mounts: Array<{ Source: string }> }).Mounts[0]!;
    expect(mount.Source).toBe(path.join(dataDir, 'docker-config'));
    // The folder holds the current certificate, and config with paths as the container sees them.
    const ca = await readFile(backend.caCertPath, 'utf8');
    expect((await readFile(path.join(mount.Source, 'ca.pem'), 'utf8')).trim()).toBe(ca.trim());
    expect(await readFile(path.join(mount.Source, 'ca-bundle.pem'), 'utf8')).toContain(ca.trim());
    expect(await readFile(path.join(mount.Source, 'php', 'wirescry.ini'), 'utf8')).toContain(
      `${MOUNT_POINT}/ca-bundle.pem`,
    );
    expect(
      (await readFile(path.join(mount.Source, 'java', 'wirescry-truststore.jks'))).length,
    ).toBeGreaterThan(100);
  });

  /** A plain HTTP request through the proxy, as a client in a container sends it. */
  const viaProxy = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const target = new URL(url);
      const req = http.request(
        { host: '127.0.0.1', port: backend.proxyPort, path: url, headers: { host: target.host, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('sends requests for host.docker.internal to this computer, keeping the Host header', async () => {
    const reply = await viaProxy(`http://host.docker.internal:${localPort}/from-container`);
    expect(reply.body).toBe(`local /from-container, host host.docker.internal:${localPort}`);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.path === '/from-container')?.host)
      .toBe(`host.docker.internal:${localPort}`);
  });

  it('only for that name: other hosts go where they say', async () => {
    const reply = await viaProxy(`http://127.0.0.1:${localPort}/direct`);
    expect(reply.body).toBe(`local /direct, host 127.0.0.1:${localPort}`);
    // A name that merely starts the same isn't remapped (and doesn't resolve).
    const other = await viaProxy(`http://host.docker.internal.example.invalid:${localPort}/x`);
    expect(other.status).toBe(502);
  });

  it('does the same over HTTPS', async () => {
    const reply = await requestViaProxy(
      backend.proxyPort,
      `https://host.docker.internal:${upstream.port}/secure`,
      await readFile(backend.caCertPath, 'utf8'),
      { headers: { host: `host.docker.internal:${upstream.port}` } },
    );
    expect(reply).toEqual({ status: 200, body: `secure, host host.docker.internal:${upstream.port}` });
  });

  it('and for WebSockets', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: backend.proxyPort,
        path: `http://host.docker.internal:${wsPort}/`,
        headers: {
          host: `host.docker.internal:${wsPort}`,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(String(res.statusCode));
      });
      req.on('response', (res) => resolve(`plain ${res.statusCode}`));
      req.on('error', reject);
      req.end();
    });
    expect(reply).toBe('101');
  });

  it('closes the relay when it stops', async () => {
    const socketPath = relaySocket(status());
    const second = await startBackend({
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'wirescry-docker-stop-')),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      dockerEndpoint: async () => ({
        kind: 'local',
        socketPath: '/nowhere.sock',
        host: 'unix:///nowhere.sock',
      }),
    });
    const client = await apiClient(second.apiPort);
    const theirs = relaySocket((client.messages[0] as { status: ProxyStatus }).status);
    expect(theirs).not.toBe(socketPath);
    expect((await dockerRequest(theirs, 'GET', '/_ping')).status).toBe(502);
    client.close();
    await second.stop();
    await expect(dockerRequest(theirs, 'GET', '/_ping')).rejects.toThrow();
  });
});

describe('Docker setup when it does not apply', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function statusWith(options: { docker?: boolean; endpoint?: DockerEndpoint }): Promise<ProxyStatus> {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-docker-none-'));
    dirs.push(dataDir);
    const backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: options.docker,
      dockerEndpoint: options.endpoint ? async () => options.endpoint! : undefined,
    });
    const client = await apiClient(backend.apiPort);
    const result = (client.messages[0] as { status: ProxyStatus }).status;
    client.close();
    await backend.stop();
    return result;
  }

  it('leaves DOCKER_HOST alone with no Docker', async () => {
    const status = await statusWith({ endpoint: { kind: 'none' } });
    expect(status.docker).toEqual({ state: 'none' });
    expect(status.terminalEnv.DOCKER_HOST).toBeUndefined();
  });

  it('leaves DOCKER_HOST alone for Docker on another computer, and says so', async () => {
    const status = await statusWith({ endpoint: { kind: 'remote', host: 'ssh://me@box' } });
    expect(status.docker).toEqual({ state: 'remote', daemon: 'ssh://me@box' });
    expect(status.terminalEnv.DOCKER_HOST).toBeUndefined();
  });

  it('does nothing when turned off', async () => {
    const status = await statusWith({
      docker: false,
      endpoint: { kind: 'local', socketPath: '/x.sock', host: 'unix:///x.sock' },
    });
    expect(status.docker).toEqual({ state: 'none' });
    expect(status.terminalEnv.DOCKER_HOST).toBeUndefined();
  });
});
