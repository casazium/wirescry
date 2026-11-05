import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPOSE_HASH_LABEL, HASH_SUFFIX, LABELS, MOUNT_POINT } from '../src/backend/docker/container';
import type { DockerEndpoint } from '../src/backend/docker/endpoint';
import { DockerRelay, type ContainerCreated } from '../src/backend/docker/relay';

/** Stands in for the Docker daemon. */
class FakeDaemon {
  readonly creates: Array<{ url: string; body: Record<string, unknown> }> = [];
  osType = 'linux';
  refuseMounts = false;
  listed: unknown = [];
  readonly upgraded = new Set<net.Socket>();
  server = http.createServer((req, res) => void this.handle(req, res));

  constructor(readonly socketPath: string) {
    this.server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      this.upgraded.add(socket);
      socket.write(
        `HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
      );
      if (head.length) socket.write(head);
      // Echoes stdin back, upper-cased, like a container would answer.
      socket.on('data', (data: Buffer) => socket.write(data.toString().toUpperCase()));
      void req;
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
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = req.url ?? '';
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify(value);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        ...headers,
      });
      res.end(text);
    };
    if (url === '/_ping') {
      res.writeHead(200, { 'content-type': 'text/plain', ostype: this.osType, 'api-version': '1.47' });
      res.end(req.method === 'HEAD' ? undefined : 'OK');
      return;
    }
    if (url.startsWith('/v1.47/containers/create')) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      } catch {
        return json(400, { message: `invalid JSON: ${body.toString()}` });
      }
      this.creates.push({ url, body: parsed });
      const mounts = (parsed.HostConfig as { Mounts?: unknown[] } | undefined)?.Mounts ?? [];
      if (this.refuseMounts && mounts.length > 0) return json(400, { message: 'invalid mount config' });
      return json(201, { Id: 'c1', Warnings: [] });
    }
    if (url.startsWith('/containers/json') || url.startsWith('/v1.47/containers/json'))
      return json(200, this.listed);
    if (url === '/v1.47/containers/c1/json')
      return json(200, { Id: 'c1', Config: { Labels: { [COMPOSE_HASH_LABEL]: 'h' } } });
    if (url === '/v1.47/containers/gone/json') return json(404, { message: 'No such container: gone' });
    if (url === '/networks/app_default')
      return json(200, { Containers: { x: { Name: 'db' }, y: { Name: 'cache' } } });
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
    if (url === '/text-list') {
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

  it('works with the unversioned path too', async () => {
    daemon.creates.length = 0;
    const reply = await request('POST', '/containers/create', JSON.stringify({ Image: 'x' }));
    // The fake daemon only knows the versioned path, so this proves the relay changed it and passed it on.
    expect(reply.status).toBe(404);
  });

  it("names other containers on the container's networks as ones to reach directly", async () => {
    await create({
      Image: 'x',
      HostConfig: { NetworkMode: 'app_default' },
      NetworkingConfig: { EndpointsConfig: { app_default: { Aliases: ['web'] }, missing: {} } },
    });
    const env = daemon.creates[0]!.body.Env as string[];
    expect(env).toContain('NO_PROXY=localhost,127.0.0.1,::1,web,db,cache');
  });

  it('creates the container as written when Docker refuses the changed one', async () => {
    daemon.refuseMounts = true;
    const reply = await create({ Image: 'alpine', Env: ['A=1'] });
    expect(reply.status).toBe(201);
    expect(daemon.creates).toHaveLength(2);
    expect(daemon.creates[1]!.body).toEqual({ Image: 'alpine', Env: ['A=1'] });
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

  it('leaves Windows containers alone', async () => {
    daemon.osType = 'windows';
    await create({ Image: 'mcr.microsoft.com/windows/nanoserver', Env: ['A=1'] });
    expect(daemon.creates[0]!.body).toEqual({ Image: 'mcr.microsoft.com/windows/nanoserver', Env: ['A=1'] });
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

  it('says when Docker is on another computer, or missing', async () => {
    endpoint = { kind: 'remote', host: 'tcp://box:2376' };
    expect(JSON.parse((await request('GET', '/_ping')).body).message).toContain('not tcp://box:2376');
    endpoint = { kind: 'none' };
    expect(JSON.parse((await request('GET', '/_ping')).body).message).toContain("couldn't find Docker");
  });

  it.skipIf(windows)('keeps its socket private to this user, and replaces a stale one', async () => {
    expect((await stat(relay.listenPath)).mode & 0o777).toBe(0o600);
    await relay.stop();
    // A socket file left behind, as after a crash.
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(path.join(dir, 'stale.sock'), resolve));
    await new Promise<void>((resolve) => {
      stale.close(() => resolve());
    });
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
