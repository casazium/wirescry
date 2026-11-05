import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPOSE_HASH_LABEL, HASH_SUFFIX, LABELS, MOUNT_POINT } from '../src/backend/docker/container';
import type { DockerEndpoint } from '../src/backend/docker/endpoint';
import { DockerRelay, unreachableReason, type ContainerCreated } from '../src/backend/docker/relay';

/** Stands in for the Docker daemon. */
class FakeDaemon {
  readonly creates: Array<{ url: string; body: Record<string, unknown> }> = [];
  osType = 'linux';
  operatingSystem = 'Docker Desktop';
  securityOptions: string[] = ['name=seccomp,profile=builtin'];
  /** The daemon machine's host name in /info, if it gives one. */
  name?: string;
  imageEnv: Record<string, string[]> = {};
  refuseMounts = false;
  /** Status the create answers with, to try Docker's other refusals. */
  createStatus?: { status: number; message: string; once?: boolean };
  readonly seenRelayHeader: string[] = [];
  listed: unknown = [];
  readonly upgraded = new Set<net.Socket>();
  followClosed = false;
  uploadsAborted = 0;
  lastListUrl = '';
  /** How many times the flaky route has been asked; it drops the first without answering. */
  flakyAsks = 0;
  server = http.createServer((req, res) => void this.handle(req, res));

  constructor(readonly socketPath: string) {
    this.server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      this.upgraded.add(socket);
      socket.write(
        `HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
      );
      // A body sent with the upgrade (exec start's JSON) is echoed as it came, wherever Node put it.
      // Node 24 puts body and what follows in `head`; Node 26 gives the body as data: either way,
      // the body comes first.
      req.on('data', (data: Buffer) => socket.write(data));
      req.once('end', () => {
        if (head.length) socket.write(head);
      });
      // Echoes stdin back, upper-cased, like a container would answer. On stdin's end, says
      // goodbye and closes, as a container whose input ended does.
      socket.on('data', (data: Buffer) => socket.write(data.toString().toUpperCase()));
      // The relay may close its side first; a container's socket ignores that too.
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end('BYE'));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    for (const socket of this.upgraded) socket.destroy();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(chunk as Buffer);
    } catch {
      this.uploadsAborted++;
      return;
    }
    const body = Buffer.concat(chunks);
    const url = req.url ?? '';
    if (req.headers['x-wirescry-relay']) this.seenRelayHeader.push(url);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify(value);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        ...headers,
      });
      res.end(text);
    };
    if (url === '/v1.47/containers/json?dies=1') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('[{"Id":');
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    if (url === '/v1.54/containers/c1/exec') {
      if (++this.flakyAsks === 1) {
        res.socket?.destroy();
        return;
      }
      return json(201, { Id: 'exec1', got: JSON.parse(body.toString()) as unknown });
    }
    if (url === '/info') {
      return json(200, {
        OSType: this.osType,
        OperatingSystem: this.operatingSystem,
        SecurityOptions: this.securityOptions,
        ...(this.name === undefined ? {} : { Name: this.name }),
      });
    }
    if (url.startsWith('/images/') && url.endsWith('/json')) {
      const name = decodeURIComponent(url.slice('/images/'.length, -'/json'.length));
      const env = this.imageEnv[name];
      return env ? json(200, { Config: { Env: env } }) : json(404, { message: `No such image: ${name}` });
    }
    if (url === '/_ping') {
      res.writeHead(200, { 'content-type': 'text/plain', ostype: this.osType, 'api-version': '1.47' });
      res.end(req.method === 'HEAD' ? undefined : 'OK');
      return;
    }
    if (url.startsWith('/v1.47/containers/create') || url.startsWith('/containers/create')) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      } catch {
        return json(400, { message: `invalid JSON: ${body.toString()}` });
      }
      this.creates.push({ url, body: parsed });
      const mounts = (parsed.HostConfig as { Mounts?: unknown[] } | undefined)?.Mounts ?? [];
      if (this.refuseMounts && mounts.length > 0) return json(400, { message: 'invalid mount config' });
      if (this.createStatus) {
        const { status, message, once } = this.createStatus;
        if (once) this.createStatus = undefined;
        return json(status, { message });
      }
      return json(201, { Id: 'c1', Warnings: [] });
    }
    if (
      (url.startsWith('/containers/json') || url.startsWith('/v1.47/containers/json')) &&
      !url.includes('text=1')
    ) {
      this.lastListUrl = url;
      return json(200, this.listed);
    }
    if (url === '/v1.47/containers/c1/json')
      return json(200, { Id: 'c1', Config: { Labels: { [COMPOSE_HASH_LABEL]: 'h' } } });
    if (url === '/v1.47/containers/gone/json') return json(404, { message: 'No such container: gone' });
    if (url === '/networks/app_default')
      return json(200, {
        Name: 'app_default',
        IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] },
        Containers: { x: { Name: 'db' }, y: { Name: 'cache' } },
      });
    if (url === '/containers/x/json')
      return json(200, {
        NetworkSettings: { Networks: { app_default: { Aliases: ['database'], DNSNames: ['db', 'x1'] } } },
      });
    if (url === '/networks/bridge')
      return json(200, { Name: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } });
    if (url === '/networks/slow') return; // Never answers.
    if (url === '/containers/plain/json')
      return json(200, { HostConfig: { ExtraHosts: [] }, Config: { Labels: {} } });
    if (url === '/containers/wired/json')
      return json(200, {
        HostConfig: { ExtraHosts: ['host.docker.internal:host-gateway'] },
        Config: { Labels: {} },
      });
    if (url === '/networks/missing') return json(404, { message: 'network missing not found' });
    if (url === '/echo') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-got-length': String(body.length),
        'x-te': String(req.headers['transfer-encoding'] ?? ''),
      });
      res.end(body);
      return;
    }
    if (url === '/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Docker flushes each event; Node's server otherwise may hold a small first write.
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      setImmediate(() => res.write('{"status":"start"}\n'));
      setTimeout(() => res.end('{"status":"die"}\n'), 150);
      return;
    }
    if (url === '/follow') {
      // `docker logs -f`: never ends by itself. Records when the relay hangs up.
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' });
      res.flushHeaders();
      const timer = setInterval(() => res.write('line\n'), 20);
      res.once('close', () => {
        clearInterval(timer);
        this.followClosed = true;
      });
      return;
    }
    if (url === '/dies') {
      // The daemon goes away halfway through a response.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"partial":');
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    if (url === '/v1.47/containers/json?text=1') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
      return;
    }
    json(404, { message: `page not found: ${url}` });
  }
}

const windows = process.platform === 'win32';
let pipes = 0;
/** A socket to listen on: a file in `dir`, or a named pipe on Windows, where Node has no Unix sockets. */
const socketIn = (folder: string, name: string): string =>
  windows ? `\\\\.\\pipe\\wirescry-test-${process.pid}-${++pipes}-${name}` : path.join(folder, name);

let dir: string;
let daemon: FakeDaemon;
let relay: DockerRelay;
let endpoint: DockerEndpoint;
let created: ContainerCreated[];
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wr-'));
  daemon = new FakeDaemon(socketIn(dir, 'daemon.sock'));
  await daemon.listen();
  endpoint = { kind: 'local', socketPath: daemon.socketPath, host: `unix://${daemon.socketPath}` };
  created = [];
  logs = [];
  relay = new DockerRelay({
    listenPath: socketIn(dir, 'relay.sock'),
    upstream: () => endpoint,
    proxyPort: () => 8001,
    configDir: '/data/docker-config',
    onContainer: (event) => created.push(event),
    log: (message) => logs.push(message),
  });
  await relay.start();
});

afterEach(async () => {
  await relay.stop();
  await daemon.close();
  await rm(dir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: relay.listenPath, method, path: url, headers: { host: 'docker', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const create = (definition: unknown, query = '?name=web') =>
  request('POST', `/v1.47/containers/create${query}`, JSON.stringify(definition), {
    'content-type': 'application/json',
  });

describe('Docker relay', () => {
  it('passes other requests on as they are', async () => {
    const ping = await request('GET', '/_ping');
    expect(ping.status).toBe(200);
    expect(ping.body).toBe('OK');
    expect(ping.headers.ostype).toBe('linux');
    const head = await request('HEAD', '/_ping');
    expect(head.status).toBe(200);
    const missing = await request('GET', '/v1.47/nothing');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).message).toContain('/v1.47/nothing');
  });

  it('passes request bodies on, sized or streamed', async () => {
    const sized = await request('POST', '/echo', 'x'.repeat(100_000));
    expect(sized.headers['x-got-length']).toBe('100000');
    expect(sized.body.length).toBe(100_000);
    const streamed = await new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: relay.listenPath,
          method: 'POST',
          path: '/echo',
          headers: { host: 'docker', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write('part one,');
      setTimeout(() => req.end('part two'), 50);
    });
    expect(streamed.body).toBe('part one,part two');
    expect(streamed.headers['x-te']).toBe('chunked');
  });

  it('streams responses as they come, not all at the end', async () => {
    const first = await new Promise<{ at: number; done: number; text: string }>((resolve, reject) => {
      const start = Date.now();
      let at: number | undefined;
      let text = '';
      http
        .get({ socketPath: relay.listenPath, path: '/events', headers: { host: 'docker' } }, (res) => {
          res.on('data', (c: Buffer) => {
            at ??= Date.now() - start;
            text += c.toString();
          });
          res.on('end', () => resolve({ at: at ?? Infinity, done: Date.now() - start, text }));
        })
        .on('error', reject);
    });
    expect(first.text).toBe('{"status":"start"}\n{"status":"die"}\n');
    expect(first.at).toBeLessThan(first.done - 100);
  });

  it("stops following Docker's stream when the client hangs up", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { socketPath: relay.listenPath, path: '/follow', headers: { host: 'docker' } },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('no data')), 3000);
    });
    await waitFor(() => daemon.followClosed);
  });

  it('cuts the client off, rather than ending cleanly, when Docker dies mid-response', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = http.get(
        { socketPath: relay.listenPath, path: '/dies', headers: { host: 'docker' } },
        (res) => {
          res.on('data', () => undefined);
          res.on('end', () => resolve(res.complete ? 'complete' : 'incomplete'));
          res.on('error', () => resolve('error'));
          res.on('close', () => resolve(res.complete ? 'complete' : 'cut off'));
        },
      );
      req.on('error', () => resolve('error'));
    });
    expect(outcome).not.toBe('complete');
  });

  it('aborts the upload to Docker when the client stops sending halfway', async () => {
    const req = http.request({
      socketPath: relay.listenPath,
      method: 'POST',
      path: '/echo',
      headers: { host: 'docker', 'transfer-encoding': 'chunked' },
    });
    req.on('error', () => undefined);
    req.write('the first part of a big image');
    await new Promise((resolve) => setTimeout(resolve, 50));
    req.destroy();
    await waitFor(() => daemon.uploadsAborted === 1);
  });

  it('answers with an error when Docker dies while sending a container list', async () => {
    const reply = await request('GET', '/v1.47/containers/json?dies=1');
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body).message).toContain("couldn't reach Docker");
  });

  it('answers several requests on one kept-alive connection, a create among them', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set<net.Socket>();
    const one = (method: string, url: string, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { socketPath: relay.listenPath, method, path: url, agent, headers: { host: 'docker' } },
          (res) => {
            sockets.add(res.socket as net.Socket);
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    expect(await one('GET', '/_ping')).toBe(200);
    expect(await one('POST', '/v1.47/containers/create', JSON.stringify({ Image: 'x' }))).toBe(201);
    expect(await one('GET', '/v1.47/containers/json')).toBe(200);
    expect(await one('POST', '/echo', 'abc')).toBe(200);
    expect(sockets.size).toBe(1);
    expect(daemon.creates[0]!.body.Env).toEqual(
      expect.arrayContaining([expect.stringMatching(/^HTTP_PROXY=/)]),
    );
    agent.destroy();
  });

  it('sets up containers created at the same time, each with its own settings', async () => {
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => create({ Image: 'x', Env: [`N=${i}`] }, `?name=c${i}`)),
    );
    expect(replies.every((r) => r.status === 201)).toBe(true);
    expect(daemon.creates).toHaveLength(10);
    for (const { url, body } of daemon.creates) {
      const n = new URL(url, 'http://d').searchParams.get('name')!.slice(1);
      expect(body.Env).toContain(`N=${n}`);
      expect((body.Env as string[]).filter((e) => e.startsWith('HTTP_PROXY='))).toHaveLength(1);
    }
  });

  it('sets up a new container', async () => {
    const reply = await create({ Image: 'node:22', Env: ['A=1'] });
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toEqual({ Id: 'c1', Warnings: [] });
    const sent = daemon.creates[0]!;
    expect(sent.url).toBe('/v1.47/containers/create?name=web');
    expect(sent.body.Env).toContain('HTTPS_PROXY=http://host.docker.internal:8001');
    expect(sent.body.Env).toContain('A=1');
    expect((sent.body.HostConfig as { Mounts: unknown[] }).Mounts).toEqual([
      { Type: 'bind', Source: '/data/docker-config', Target: MOUNT_POINT, ReadOnly: true },
    ]);
    expect(created).toEqual([{ name: 'web', image: 'node:22', setUp: true, reason: undefined }]);
  });

  it('sets up a container created on the unversioned path too', async () => {
    const reply = await request('POST', '/containers/create', JSON.stringify({ Image: 'x' }));
    expect(reply.status).toBe(201);
    expect(daemon.creates[0]!.url).toBe('/containers/create');
    expect(daemon.creates[0]!.body.Env).toEqual(
      expect.arrayContaining([expect.stringMatching(/^HTTP_PROXY=/)]),
    );
  });

  it("names other containers on the container's networks as ones to reach directly", async () => {
    await create({
      Image: 'x',
      HostConfig: { NetworkMode: 'app_default' },
      NetworkingConfig: { EndpointsConfig: { app_default: { Aliases: ['web'] }, missing: {} } },
    });
    const env = daemon.creates[0]!.body.Env as string[];
    const noProxy = env
      .find((e) => e.startsWith('NO_PROXY='))!
      .slice('NO_PROXY='.length)
      .split(',');
    // Its own alias, peers' names and aliases, and the network's addresses.
    expect(noProxy).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      'web',
      '172.20.0.0/16',
      'db',
      'database',
      'x1',
      'cache',
    ]);
    expect(env.find((e) => e.startsWith('JAVA_TOOL_OPTIONS='))).toContain('|172.20.*|');
  });

  it('creates the container as written when Docker refuses the changed one', async () => {
    daemon.refuseMounts = true;
    const reply = await create({ Image: 'alpine', Env: ['A=1'] });
    expect(reply.status).toBe(201);
    expect(daemon.creates).toHaveLength(2);
    expect(daemon.creates[1]!.body).toEqual({
      Image: 'alpine',
      Env: ['A=1'],
      Labels: { [LABELS.setup]: 'skipped' },
    });
    expect(created).toEqual([
      expect.objectContaining({
        name: 'web',
        setUp: false,
        reason: expect.stringContaining('invalid mount'),
      }),
    ]);
    expect(logs.join('\n')).toContain('creating it without them');
  });

  it("passes Docker's own refusal on when the original fails too", async () => {
    daemon.refuseMounts = true;
    const reply = await create({
      Image: 'alpine',
      HostConfig: { Mounts: [{ Type: 'bind', Source: '/x', Target: '/y' }] },
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({ message: 'invalid mount config' });
    expect(created).toEqual([]);
  });

  it('leaves containers alone on Docker it does not set up, labelled so Compose keeps them', async () => {
    const cases = [
      // colima or Lima on macOS.
      { operatingSystem: 'Ubuntu 24.04 LTS', securityOptions: [], platform: 'darwin', name: 'colima' },
      { operatingSystem: 'Ubuntu 24.04 LTS', securityOptions: ['name=rootless'], platform: 'linux' },
      // colima, Lima or Rancher Desktop on Linux: Docker in a VM, which has its own host name.
      { operatingSystem: 'Ubuntu 24.04 LTS', securityOptions: [], platform: 'linux', name: 'colima' },
      {
        operatingSystem: 'Alpine Linux v3.20',
        securityOptions: [],
        platform: 'linux',
        name: 'lima-rancher-desktop',
      },
    ] as const;
    for (const [i, { operatingSystem, securityOptions, platform, ...rest }] of cases.entries()) {
      daemon.creates.length = 0;
      daemon.operatingSystem = operatingSystem;
      daemon.securityOptions = [...securityOptions];
      daemon.name = 'name' in rest ? rest.name : undefined;
      // Remembered for a minute: a new relay asks again.
      await relay.stop();
      relay = new DockerRelay({
        listenPath: socketIn(dir, `relay-${i}.sock`),
        upstream: () => endpoint,
        proxyPort: () => 8001,
        configDir: '/x',
        platform,
      });
      await relay.start();
      await create({ Image: 'x', Env: ['A=1'] });
      expect(daemon.creates[0]!.body).toEqual({
        Image: 'x',
        Env: ['A=1'],
        Labels: { [LABELS.setup]: 'skipped' },
      });
      const reason = await relay.unsupportedReason();
      expect(reason).toBeTruthy();
      if (platform === 'linux' && 'name' in rest) expect(reason).toMatch(`another machine (${rest.name})`);
    }
  });

  it("sets up Docker on Linux that reports this computer's host name", async () => {
    daemon.operatingSystem = 'Ubuntu 24.04.3 LTS';
    daemon.name = os.hostname().toUpperCase();
    await relay.stop();
    relay = new DockerRelay({
      listenPath: relay.listenPath,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
      platform: 'linux',
    });
    await relay.start();
    await create({ Image: 'x' });
    expect((daemon.creates[0]!.body.Labels as Record<string, string>)[LABELS.setup]).toBe('proxy');
    expect(await relay.unsupportedReason()).toBeUndefined();
  });

  it("reads the image's environment, and keeps a certificate variable the container sets", async () => {
    daemon.imageEnv['registry.example.com:5000/team/app:1.2'] = ['JAVA_TOOL_OPTIONS=-Xss1m'];
    await create({
      Image: 'registry.example.com:5000/team/app:1.2',
      Env: ['NODE_EXTRA_CA_CERTS=/certs/ca.pem'],
    });
    const env = daemon.creates[0]!.body.Env as string[];
    expect(env.find((e) => e.startsWith('JAVA_TOOL_OPTIONS='))).toMatch(/^JAVA_TOOL_OPTIONS=-Xss1m -Dhttp/);
    expect(env).toContain('NODE_EXTRA_CA_CERTS=/certs/ca.pem');
  });

  it('carries on without the image when Docker does not know it', async () => {
    const reply = await create({ Image: 'not-pulled-yet' });
    expect(reply.status).toBe(201);
    expect(daemon.creates[0]!.body.Env).toEqual(
      expect.arrayContaining([expect.stringMatching(/^HTTP_PROXY=/)]),
    );
  });

  it('relabels the mount on a daemon with SELinux', async () => {
    daemon.securityOptions = ['name=selinux'];
    await create({ Image: 'x' });
    const hostConfig = daemon.creates[0]!.body.HostConfig as { Binds?: string[]; Mounts?: unknown };
    expect(hostConfig.Binds).toEqual([`/data/docker-config:${MOUNT_POINT}:ro,z`]);
    expect(hostConfig.Mounts).toBeUndefined();
  });

  it('lists the addresses of running containers it set up', async () => {
    daemon.listed = [
      {
        Id: 'a',
        NetworkSettings: {
          Networks: { bridge: { IPAddress: '172.17.0.5' }, app: { IPAddress: '172.20.0.3' } },
        },
      },
      { Id: 'b', NetworkSettings: { Networks: { none: { IPAddress: '' } } } },
    ];
    expect([...(await relay.setUpAddresses())].sort()).toEqual(['172.17.0.5', '172.20.0.3']);
    expect(daemon.lastListUrl).toContain(encodeURIComponent('app.wirescry.setup=proxy'));
    expect(daemon.lastListUrl).toContain('all=1');
  });

  it('leaves Windows containers alone', async () => {
    daemon.osType = 'windows';
    await create({ Image: 'mcr.microsoft.com/windows/nanoserver', Env: ['A=1'] });
    expect(daemon.creates[0]!.body).toEqual({
      Image: 'mcr.microsoft.com/windows/nanoserver',
      Env: ['A=1'],
      Labels: { [LABELS.setup]: 'skipped' },
    });
    expect(created[0]).toMatchObject({ setUp: false });
  });

  it('passes on a create body that is not JSON', async () => {
    const reply = await request('POST', '/v1.47/containers/create', '{broken');
    // Docker refuses it, as it would without Wirescry: what matters is it got there unchanged.
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).message).toBe('invalid JSON: {broken');
  });

  it("refuses a create body too big to be a container's", async () => {
    const reply = await request('POST', '/v1.47/containers/create', 'x'.repeat(17 * 1024 * 1024));
    expect(reply.status).toBe(413);
    expect(daemon.creates).toHaveLength(0);
  });

  it("reports Compose's hash so Compose recreates the containers that need it", async () => {
    daemon.listed = [
      { Id: 'a', Labels: { [COMPOSE_HASH_LABEL]: 'h1' } },
      {
        Id: 'b',
        Labels: {
          [COMPOSE_HASH_LABEL]: `h2${HASH_SUFFIX}`,
          [LABELS.setup]: 'proxy',
          [LABELS.port]: '8001',
          [LABELS.composeHash]: 'h2',
        },
      },
    ];
    const reply = await request('GET', '/v1.47/containers/json?all=1&filters=%7B%7D');
    const list = JSON.parse(reply.body) as Array<{ Labels: Record<string, string> }>;
    expect(list[0]!.Labels[COMPOSE_HASH_LABEL]).toBe(`h1${HASH_SUFFIX}`);
    expect(list[1]!.Labels[COMPOSE_HASH_LABEL]).toBe('h2');
    expect(reply.headers['content-length']).toBe(String(Buffer.byteLength(reply.body)));
    const inspect = JSON.parse((await request('GET', '/v1.47/containers/c1/json')).body) as {
      Config: { Labels: Record<string, string> };
    };
    expect(inspect.Config.Labels[COMPOSE_HASH_LABEL]).toBe(`h${HASH_SUFFIX}`);
  });

  it('passes errors and lists of other kinds on unchanged', async () => {
    const gone = await request('GET', '/v1.47/containers/gone/json');
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body)).toEqual({ message: 'No such container: gone' });
    daemon.listed = { not: 'a list' };
    expect(JSON.parse((await request('GET', '/containers/json')).body)).toEqual({ not: 'a list' });
  });

  it('passes attach and exec connections through both ways', async () => {
    const socket = net.connect(relay.listenPath);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'POST /v1.47/containers/c1/attach?stream=1&stdin=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    let received = '';
    socket.on('data', (data: Buffer) => {
      received += data.toString();
    });
    await waitFor(() => received.includes('101 UPGRADED'));
    socket.write('hello');
    await waitFor(() => received.endsWith('HELLO'));
    socket.destroy();
    // Docker's side closes with it.
    await waitFor(
      () => daemon.upgraded.size === 1 && [...daemon.upgraded].every((s) => s.destroyed || s.readableEnded),
    );
  });

  it('closes taken-over connections when it stops', async () => {
    const socket = net.connect(relay.listenPath);
    let received = '';
    socket.on('data', (d: Buffer) => (received += d.toString()));
    socket.write(
      'POST /containers/c1/attach HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    await waitFor(() => received.includes('101'));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await relay.stop();
    await closed;
  });

  it('passes a body sent with an upgrade on, as docker exec sends one', async () => {
    const socket = net.connect(relay.listenPath);
    let received = '';
    socket.on('data', (d: Buffer) => (received += d.toString()));
    const body = '{"Detach":false,"Tty":false}';
    socket.write(
      `POST /v1.47/exec/e1/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n${body}`,
    );
    await waitFor(() => received.includes('101 UPGRADED') && received.includes(body));
    socket.destroy();
  });

  // Windows named pipes have no half-close in Node, so this can't pass there; checked by hand
  // on Windows instead (docker run -i with piped input).
  it.skipIf(windows)('tells the container its input ended, and lets its last output through', async () => {
    const socket = net.connect(relay.listenPath);
    let received = '';
    socket.on('data', (d: Buffer) => (received += d.toString()));
    socket.write(
      'POST /containers/c1/attach HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    await waitFor(() => received.includes('101'));
    socket.write('last words');
    // Half-close: no more input, but still reading.
    socket.end();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await closed;
    expect(received).toMatch(/LAST WORDSBYE$/);
  });

  it('points a mount of its own socket at the daemon’s, as Testcontainers mounts DOCKER_HOST', async () => {
    const own = relay.listenPath;
    await create({
      Image: 'testcontainers/ryuk',
      HostConfig: {
        Binds: [`${own}:/var/run/docker.sock:rw`, '/src:/app'],
        Mounts: [{ Type: 'bind', Source: own, Target: '/docker.sock' }],
      },
    });
    const hostConfig = daemon.creates[0]!.body.HostConfig as {
      Binds: string[];
      Mounts: Array<{ Source: string; Target: string }>;
    };
    expect(hostConfig.Binds).toEqual(['/var/run/docker.sock:/var/run/docker.sock:rw', '/src:/app']);
    expect(hostConfig.Mounts.find((m) => m.Target === '/docker.sock')!.Source).toBe('/var/run/docker.sock');
  });

  it.skipIf(windows)('recognizes its own socket written through /private on macOS', async () => {
    const own = relay.listenPath;
    const other = own.startsWith('/private/') ? own.slice('/private'.length) : `/private${own}`;
    await create({ Image: 'x', HostConfig: { Binds: [`${other}:/var/run/docker.sock`] } });
    expect((daemon.creates[0]!.body.HostConfig as { Binds: string[] }).Binds[0]).toBe(
      '/var/run/docker.sock:/var/run/docker.sock',
    );
  });

  // Docker on Linux listens on a Unix socket; Windows has no such daemon.
  it.skipIf(windows)("uses the daemon's own socket path for the mount on Docker on Linux", async () => {
    daemon.operatingSystem = 'Ubuntu 24.04.3 LTS';
    await relay.stop();
    relay = new DockerRelay({
      listenPath: relay.listenPath,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
      platform: 'linux',
    });
    await relay.start();
    await create({ Image: 'x', HostConfig: { Binds: [`${relay.listenPath}:/var/run/docker.sock`] } });
    expect((daemon.creates[0]!.body.HostConfig as { Binds: string[] }).Binds[0]).toBe(
      `${daemon.socketPath}:/var/run/docker.sock`,
    );
  });

  it('leaves dev containers, BuildKit builders and Kubernetes nodes alone', async () => {
    await create({
      Image: 'mcr.microsoft.com/devcontainers/base',
      Labels: { 'devcontainer.local_folder': '/src' },
    });
    await create({ Image: 'moby/buildkit' }, '?name=buildx_buildkit_mybuilder0');
    await create({ Image: 'kindest/node', Labels: { 'io.x-k8s.kind.cluster': 'kind' } });
    expect(daemon.creates).toHaveLength(3);
    for (const { body } of daemon.creates) {
      expect((body.Labels as Record<string, string>)[LABELS.setup]).toBe('skipped');
      expect(body.Env).toBeUndefined();
    }
    expect(created.map((c) => c.reason)).toEqual([
      'it’s a dev container.',
      'it’s a BuildKit builder.',
      'it’s a Kubernetes node.',
    ]);
  });

  it("leaves a container sharing an unprepared container's network alone, off Docker Desktop", async () => {
    daemon.operatingSystem = 'Ubuntu 24.04.3 LTS';
    await relay.stop();
    relay = new DockerRelay({
      listenPath: relay.listenPath,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
      platform: 'linux',
    });
    await relay.start();
    await create({ Image: 'x', HostConfig: { NetworkMode: 'container:plain' } });
    expect((daemon.creates[0]!.body.Labels as Record<string, string>)[LABELS.setup]).toBe('skipped');
    // One that has the host entry is fine.
    await create({ Image: 'x', HostConfig: { NetworkMode: 'container:wired' } });
    expect((daemon.creates[1]!.body.Labels as Record<string, string>)[LABELS.setup]).toBe('proxy');
  });

  it('sets up a container sharing any network on Docker Desktop, which provides the name itself', async () => {
    await create({ Image: 'x', HostConfig: { NetworkMode: 'container:plain' } });
    expect((daemon.creates[0]!.body.Labels as Record<string, string>)[LABELS.setup]).toBe('proxy');
  });

  it("doesn't retry when Docker's refusal has nothing to do with Wirescry", async () => {
    for (const [status, message] of [
      [404, 'No such image: nope:latest'],
      [409, 'Conflict. The container name "/web" is already in use'],
    ] as const) {
      daemon.creates.length = 0;
      daemon.createStatus = { status, message };
      const reply = await create({ Image: 'nope' });
      expect(reply.status).toBe(status);
      expect(JSON.parse(reply.body).message).toBe(message);
      expect(daemon.creates).toHaveLength(1);
    }
    expect(logs.join('\n')).not.toContain('refused');
    // Nothing was made, so nothing is reported.
    expect(created).toEqual([]);
  });

  it('retries a 500 from the changed container, as Docker answers a mount it cannot make', async () => {
    daemon.createStatus = { status: 500, message: 'error while creating mount source path', once: true };
    expect((await create({ Image: 'x' })).status).toBe(201);
    expect(daemon.creates).toHaveLength(2);
    expect((daemon.creates[1]!.body.Labels as Record<string, string>)[LABELS.setup]).toBe('skipped');
  });

  it('marks what it passes on, and passes on untouched what another Wirescry relay sent', async () => {
    await request('GET', '/_ping');
    expect(daemon.seenRelayHeader).toContain('/_ping');
    const reply = await request(
      'POST',
      '/v1.47/containers/create',
      JSON.stringify({ Image: 'x', Env: ['A=1'] }),
      {
        'x-wirescry-relay': '1',
      },
    );
    expect(reply.status).toBe(201);
    expect(daemon.creates[0]!.body).toEqual({ Image: 'x', Env: ['A=1'] });
  });

  it('passes containers on as written while Docker setup is off', async () => {
    let active = false;
    await relay.stop();
    relay = new DockerRelay({
      listenPath: relay.listenPath,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
      active: () => active,
    });
    await relay.start();
    await create({ Image: 'x', Env: ['A=1'] });
    expect(daemon.creates[0]!.body).toEqual({ Image: 'x', Env: ['A=1'] });
    active = true;
    await create({ Image: 'x', Env: ['A=1'] });
    expect((daemon.creates[1]!.body.Labels as Record<string, string>)[LABELS.setup]).toBe('proxy');
  });

  it('asks for images by their full name, registry, port and digest included', async () => {
    daemon.imageEnv['registry.example.com:5000/team/app@sha256:abc123'] = ['NO_PROXY=from-image'];
    await create({ Image: 'registry.example.com:5000/team/app@sha256:abc123' });
    expect(daemon.creates[0]!.body.Env).toEqual(
      expect.arrayContaining([expect.stringMatching(/^NO_PROXY=from-image,/)]),
    );
  });

  it('waits only so long for a lookup Docker never answers', async () => {
    const started = Date.now();
    const reply = await create({ Image: 'x', HostConfig: { NetworkMode: 'slow' } });
    expect(reply.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it('passes a list that is not JSON on untouched', async () => {
    const reply = await request('GET', '/v1.47/containers/json?text=1');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('not json');
  });

  it('passes on what follows an upgrade body after the body, in order', async () => {
    const socket = net.connect(relay.listenPath);
    let received = '';
    socket.on('data', (d: Buffer) => (received += d.toString()));
    const body = '{"Detach":false}';
    socket.write(
      `POST /v1.47/exec/e1/start HTTP/1.1\r\nHost: docker\r\nContent-Length: ${body.length}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n${body}stdin-bytes`,
    );
    // The fake echoes the body as it came, then upper-cases what follows.
    await waitFor(() => received.includes(`${body}stdin-bytes`));

    socket.destroy();
  });

  it("leaves Compose's hash alone while Docker setup is off, so nothing is recreated for it", async () => {
    await relay.stop();
    relay = new DockerRelay({
      listenPath: socketIn(dir, 'off.sock'),
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
      active: () => false,
    });
    await relay.start();
    daemon.listed = [{ Id: 'a', Labels: { [COMPOSE_HASH_LABEL]: 'h1' } }];
    const list = JSON.parse((await request('GET', '/v1.47/containers/json')).body) as Array<{
      Labels: Record<string, string>;
    }>;
    expect(list[0]!.Labels[COMPOSE_HASH_LABEL]).toBe('h1');
  });

  it('sends a small request again once when Docker drops it without answering', async () => {
    const reply = await request(
      'POST',
      '/v1.54/containers/c1/exec',
      JSON.stringify({ Cmd: ['cat'], AttachStdin: true }),
      {
        'content-type': 'application/json',
      },
    );
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toEqual({ Id: 'exec1', got: { Cmd: ['cat'], AttachStdin: true } });
    expect(daemon.flakyAsks).toBe(2);
    expect(logs.join('\n')).toContain('Docker dropped POST /v1.54/containers/c1/exec before answering');
  });

  it("doesn't send a streamed request again: its body is gone", async () => {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: relay.listenPath,
          method: 'POST',
          path: '/v1.54/containers/c1/exec',
          headers: { host: 'docker', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end('{"Cmd":["x"]}');
    });
    expect(reply.status).toBe(502);
    expect(daemon.flakyAsks).toBe(1);
  });

  it('says when Docker is not running', async () => {
    await daemon.close();
    const reply = await request('GET', '/_ping');
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body).message).toBe(
      `Wirescry couldn't reach Docker at ${daemon.socketPath}. Is Docker running?`,
    );
    const createReply = await create({ Image: 'x' });
    expect(createReply.status).toBe(502);
    // And for attach.
    const socket = net.connect(relay.listenPath);
    let received = '';
    socket.on('data', (d: Buffer) => (received += d.toString()));
    socket.write(
      'POST /containers/c1/attach HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    await waitFor(() => received.includes('Is Docker running?'));
    expect(received).toMatch(/^HTTP\/1\.1 502/);
    socket.destroy();
  });

  // Unix permissions; root can open the socket whatever its mode.
  it.skipIf(windows || process.getuid?.() === 0)(
    "says what to do when Docker's socket refuses this user",
    async () => {
      const { chmod } = await import('node:fs/promises');
      await chmod(daemon.socketPath, 0o000);
      try {
        const reply = await request('GET', '/_ping');
        expect(reply.status).toBe(502);
        expect(JSON.parse(reply.body).message).toMatch(
          process.platform === 'linux' ? /permission to use Docker.*docker group/ : /permission/,
        );
        // And for attach.
        const socket = net.connect(relay.listenPath);
        let received = '';
        socket.on('data', (d: Buffer) => (received += d.toString()));
        socket.write(
          'POST /containers/c1/attach HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
        );
        await waitFor(() => received.includes('permission'));
        expect(received).toMatch(/^HTTP\/1\.1 502/);
        socket.destroy();
      } finally {
        await chmod(daemon.socketPath, 0o755);
      }
    },
  );

  it('explains why Docker could not be reached', () => {
    const error = (code: string, message = code) => Object.assign(new Error(message), { code });
    expect(unreachableReason(error('ENOENT'))).toBe('Is Docker running?');
    expect(unreachableReason(error('ECONNREFUSED'))).toBe('Is Docker running?');
    expect(unreachableReason(error('EACCES'), 'linux')).toMatch(/sudo usermod -aG docker \$USER/);
    expect(unreachableReason(error('EPERM'), 'linux')).toMatch(/docker group/);
    // Windows: a named pipe refusing the user is EPERM, and the group is docker-users.
    expect(unreachableReason(error('EPERM'), 'win32')).toMatch(/docker-users/);
    expect(unreachableReason(error('EACCES'), 'darwin')).toMatch(/Docker Desktop is running as you/);
    expect(unreachableReason(error('ETIMEDOUT', 'connect timed out'))).toBe('connect timed out');
  });

  it('says when Docker is on another computer, or missing', async () => {
    endpoint = { kind: 'remote', host: 'tcp://box:2376' };
    expect(JSON.parse((await request('GET', '/_ping')).body).message).toContain('not tcp://box:2376');
    endpoint = { kind: 'none' };
    expect(JSON.parse((await request('GET', '/_ping')).body).message).toContain("couldn't find Docker");
  });

  it.skipIf(windows)('keeps its socket private to this user, and replaces a stale one', async () => {
    expect((await stat(relay.listenPath)).mode & 0o777).toBe(0o600);
    await relay.stop();
    // A socket file left behind by a process that crashed: listening, then killed outright.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(relay.listenPath)}, () => console.log('up'))`,
    ]);
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect((await stat(relay.listenPath)).isSocket()).toBe(true);
    relay = new DockerRelay({
      listenPath: relay.listenPath,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
    });
    await relay.start();
    expect((await request('GET', '/_ping')).status).toBe(200);
  });

  it.skipIf(windows)("won't replace a file that isn't a socket", async () => {
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(dir, 'not-a-socket');
    await writeFile(file, 'data');
    const other = new DockerRelay({
      listenPath: file,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: '/x',
    });
    await expect(other.start()).rejects.toThrow(/isn't a socket/);
  });
});

describe.runIf(windows)('Docker relay on Windows', () => {
  it('refuses a pipe another program already has, instead of sharing it', async () => {
    const other = new DockerRelay({
      listenPath: relay.listenPath,
      upstream: () => endpoint,
      proxyPort: () => 8001,
      configDir: 'C:\\x',
    });
    await expect(other.start()).rejects.toThrow(/EADDRINUSE/);
    expect((await request('GET', '/_ping')).status).toBe(200);
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
