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
import { parseDockerHost, type DockerEndpoint } from '../src/backend/docker/endpoint';
import { WINDOWS_NOT_YET } from '../src/backend/docker/setup';
import type { ProxyStatus } from '../src/shared/api';
import { apiClient, exchangesIn, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** A daemon that records what it was asked to create. */
async function fakeDaemon(socketPath: string, operatingSystem = 'Docker Desktop') {
  const creates: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', ostype: 'linux' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.url === '/_ping') return send(200, 'OK');
      if (req.url === '/info') return send(200, { OSType: 'linux', OperatingSystem: operatingSystem });
      if (req.url?.includes('/containers/create')) {
        creates.push(JSON.parse(Buffer.concat(chunks).toString()));
        return send(201, { Id: 'c1' });
      }
      send(404, { message: 'not here' });
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

/** Where the relay listens, read from the DOCKER_HOST terminals get (a socket, or a pipe on Windows). */
const relaySocket = (status: ProxyStatus): string => {
  const endpoint = parseDockerHost(status.terminalEnv.DOCKER_HOST!);
  if (endpoint?.kind !== 'local')
    throw new Error(`not a local DOCKER_HOST: ${status.terminalEnv.DOCKER_HOST}`);
  return endpoint.socketPath;
};

// Docker setup is off on Windows (WINDOWS_NOT_YET): there are no containers to set up, only the
// host.docker.internal rule, which applies everywhere.
const windows = process.platform === 'win32';

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
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\wirescry-test-daemon-${process.pid}`
        : path.join(daemonDir, 'docker.sock');
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

  it.skipIf(windows)('says Docker is set up, and gives terminals DOCKER_HOST', async () => {
    expect(status().docker).toEqual({
      state: 'ready',
      // The daemon given to the backend, as given.
      daemon: expect.stringMatching(/^unix:\/\/.*(docker\.sock|wirescry-test-daemon-\d+)$/),
    });
    expect(status().terminalEnv.DOCKER_HOST).toMatch(
      process.platform === 'win32'
        ? /^npipe:\/\/\/\/\.\/pipe\/wirescry-docker-[0-9a-f]{12}$/
        : /^unix:\/\/.+\/docker\.sock$/,
    );
    const script = await readFile(status().terminalScripts.posix!, 'utf8');
    expect(script).toContain(`export DOCKER_HOST='${status().terminalEnv.DOCKER_HOST}'`);
  });

  it.skipIf(windows)(
    "sets new containers up for this proxy's port, with the certificate folder",
    async () => {
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
    },
  );

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

  it.skipIf(windows)('shows what happened to the last container on the Setup page', async () => {
    await dockerRequest(relaySocket(status()), 'POST', '/v1.47/containers/create?name=shown', {
      Image: 'alpine',
    });
    await expect
      .poll(() => {
        const latest = [...api.messages].reverse().find((m) => m.type === 'status') as
          { status: ProxyStatus } | undefined;
        return latest?.status.docker.lastContainer;
      })
      .toEqual({ name: 'shown', image: 'alpine', setUp: true });
  });

  it.skipIf(windows)(
    'can be turned off and on, remembering the choice, and keeps open terminals working',
    async () => {
      const socketPath = relaySocket(status());
      await api.send({ command: 'setDockerSetup', enabled: false });
      const latest = () =>
        ([...api.messages].reverse().find((m) => m.type === 'status') as { status: ProxyStatus }).status;
      expect(latest().docker.state).toBe('off');
      expect(latest().terminalEnv.DOCKER_HOST).toBeUndefined();
      expect(await readFile(latest().terminalScripts.posix!, 'utf8')).not.toContain('DOCKER_HOST');
      expect(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).dockerSetup).toBe(false);
      // A terminal that already has DOCKER_HOST still reaches Docker; its containers are left as written.
      const before = daemon.creates.length;
      expect(
        (await dockerRequest(socketPath, 'POST', '/v1.47/containers/create', { Image: 'x' })).status,
      ).toBe(201);
      expect(daemon.creates[before]).toEqual({ Image: 'x' });

      await api.send({ command: 'setDockerSetup', enabled: true });
      expect(latest().docker.state).toBe('ready');
      expect(latest().terminalEnv.DOCKER_HOST).toBeDefined();
      expect(
        JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).dockerSetup,
      ).toBeUndefined();
    },
  );

  it.skipIf(windows)('closes the relay when it stops', async () => {
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

  it('says so, and leaves DOCKER_HOST alone, for Docker it does not set up', async () => {
    const daemonDir = await mkdtemp(path.join(os.tmpdir(), 'wd-'));
    dirs.push(daemonDir);
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\wirescry-test-colima-${process.pid}`
        : path.join(daemonDir, 'd.sock');
    // colima on a Mac, or Docker in a VM elsewhere: Linux, not Docker Desktop.
    const daemon = await fakeDaemon(socketPath, 'Ubuntu 24.04 LTS');
    try {
      const status = await statusWith({
        endpoint: { kind: 'local', socketPath, host: `unix://${socketPath}` },
      });
      if (process.platform === 'linux') {
        expect(status.docker.state).toBe('ready');
      } else if (windows) {
        expect(status.docker).toMatchObject({ state: 'unsupported', error: WINDOWS_NOT_YET });
        expect(status.terminalEnv.DOCKER_HOST).toBeUndefined();
      } else {
        expect(status.docker).toMatchObject({
          state: 'unsupported',
          error: expect.stringContaining('Ubuntu 24.04 LTS'),
        });
        expect(status.terminalEnv.DOCKER_HOST).toBeUndefined();
      }
    } finally {
      await daemon.close();
    }
  });

  it.runIf(windows)(
    'on Windows, says it doesn’t set Docker up yet, and gives terminals no DOCKER_HOST',
    async () => {
      const socketPath = `\\\\.\\pipe\\wirescry-test-desktop-${process.pid}`;
      const daemon = await fakeDaemon(socketPath);
      try {
        const status = await statusWith({
          endpoint: { kind: 'local', socketPath, host: `npipe:////./pipe/x` },
        });
        expect(status.docker).toEqual({
          state: 'unsupported',
          daemon: 'npipe:////./pipe/x',
          error: WINDOWS_NOT_YET,
        });
        expect(status.terminalEnv.DOCKER_HOST).toBeUndefined();
      } finally {
        await daemon.close();
      }
    },
  );

  it('does not relay to itself when DOCKER_HOST points at its own relay', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-docker-self-'));
    dirs.push(dataDir);
    const { relayAddress } = await import('../src/backend/docker/setup');
    const own = relayAddress(dataDir).listenPath;
    const backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      dockerEndpoint: async () => ({ kind: 'local', socketPath: own, host: `unix://${own}` }),
    });
    const client = await apiClient(backend.apiPort);
    const status = (client.messages[0] as { status: ProxyStatus }).status;
    client.close();
    await backend.stop();
    expect(status.docker.state).toBe('none');
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
