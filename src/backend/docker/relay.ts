import { mkdir, lstat, unlink, chmod } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { composeNames } from './compose';
import {
  namesInDefinition,
  rewriteListed,
  setUpContainer,
  userNetworks,
  type SetUpResult,
} from './container';
import type { DockerEndpoint } from './endpoint';

const VERSION = String.raw`(?:/v\d+(?:\.\d+)*)?`;
const CREATE = new RegExp(`^${VERSION}/containers/create(?:\\?|$)`);
const LIST = new RegExp(`^${VERSION}/containers/json(?:\\?|$)`);
const INSPECT = new RegExp(`^${VERSION}/containers/[^/?]+/json(?:\\?|$)`);

/** Create bodies are a few KB; anything this big isn't one Wirescry should be changing. */
const MAX_CREATE_BODY = 16 * 1024 * 1024;
/** Container lists bigger than this are passed on unchanged. */
const MAX_LIST_BODY = 64 * 1024 * 1024;
/** How long the relay waits for the daemon when asking it something on its own behalf. */
const LOOKUP_TIMEOUT_MS = 3000;

/** Headers that belong to one connection, not to the request. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']);

export interface ContainerCreated {
  name?: string;
  image?: string;
  setUp: boolean;
  reason?: string;
}

export interface DockerRelayOptions {
  /** A Unix socket path, or a Windows named pipe (\\.\pipe\name). */
  listenPath: string;
  /** The user's real daemon. Asked on each request, so a change is picked up. */
  upstream: () => DockerEndpoint;
  proxyPort: () => number;
  /** Host folder with the certificates containers get. */
  configDir: string;
  onContainer?: (event: ContainerCreated) => void;
  log?: (message: string) => void;
}

interface Buffered {
  status: number;
  message: string;
  rawHeaders: string[];
  body: Buffer;
}

/** Raw headers without the hop-by-hop ones and any named in `drop`. */
function forwardHeaders(raw: string[], drop: string[] = []): string[] {
  const skip = new Set([...HOP_BY_HOP, ...drop]);
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!skip.has(raw[i]!.toLowerCase())) out.push(raw[i]!, raw[i + 1]!);
  }
  return out;
}

function readAll(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    stream.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(over ? undefined : Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

/**
 * A Docker API endpoint of Wirescry's own, which terminals it sets up point DOCKER_HOST at.
 * Every request goes on to the user's daemon as it came, except that new containers get the
 * proxy settings, and Compose's config hash is reported so Compose recreates the containers
 * that need it (see container.ts).
 */
export class DockerRelay {
  private server?: http.Server;
  private readonly upgraded = new Set<net.Socket>();
  private osType?: { value: string; at: number };

  constructor(private readonly options: DockerRelayOptions) {}

  get listenPath(): string {
    return this.options.listenPath;
  }

  async start(): Promise<void> {
    const { listenPath } = this.options;
    const windowsPipe = listenPath.startsWith('\\\\');
    if (!windowsPipe) await removeStaleSocket(listenPath);
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.log(`request failed: ${(error as Error)?.message ?? error}`);
        if (!res.headersSent)
          this.fail(
            res,
            500,
            `Wirescry couldn't pass this request on to Docker: ${(error as Error)?.message ?? error}`,
          );
        else res.destroy();
      });
    });
    // Builds, image loads and log streams can take as long as they take.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 30_000;
    server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) =>
      this.upgrade(req, socket, head),
    );
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (!windowsPipe) await chmod(listenPath, 0o600).catch(() => undefined);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const socket of this.upgraded) socket.destroy();
    this.upgraded.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => console.log(`[wirescry] docker: ${m}`)))(message);
  }

  private socketPath(): string | { error: string } {
    const upstream = this.options.upstream();
    if (upstream.kind === 'local') return upstream.socketPath;
    if (upstream.kind === 'remote') {
      return { error: `Wirescry only sets up Docker running on this computer, not ${upstream.host}.` };
    }
    return { error: "Wirescry couldn't find Docker on this computer." };
  }

  /** A JSON error the Docker CLI shows as "Error response from daemon: …". */
  private fail(res: http.ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ message });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  private unreachable(res: http.ServerResponse, socketPath: string, error: Error): void {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' || code === 'ECONNREFUSED' ? 'Is Docker running?' : error.message;
    this.fail(res, 502, `Wirescry couldn't reach Docker at ${socketPath}. ${why}`);
  }

  /** Sends a request to the daemon and gives back its response, unread. */
  private send(
    socketPath: string,
    method: string,
    path: string,
    rawHeaders: string[],
    body?: Buffer | http.IncomingMessage,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath, method, path, headers: rawHeaders, agent: false });
      request.once('response', resolve);
      request.once('error', reject);
      if (Buffer.isBuffer(body)) request.end(body);
      else if (body) {
        const stream: http.IncomingMessage = body;
        stream.pipe(request);
        stream.once('error', (error: Error) => request.destroy(error));
      } else request.end();
    });
  }

  private async buffered(
    socketPath: string,
    method: string,
    path: string,
    rawHeaders: string[],
    body?: Buffer,
    limit = MAX_LIST_BODY,
  ): Promise<Buffered | undefined> {
    const response = await this.send(socketPath, method, path, rawHeaders, body);
    const data = await readAll(response, limit);
    if (!data) return undefined;
    return {
      status: response.statusCode ?? 502,
      message: response.statusMessage ?? '',
      rawHeaders: response.rawHeaders,
      body: data,
    };
  }

  private reply(res: http.ServerResponse, response: Buffered): void {
    res.writeHead(response.status, response.message, [
      ...forwardHeaders(response.rawHeaders, ['content-length', 'transfer-encoding']),
      'Content-Length',
      String(response.body.length),
    ]);
    res.end(response.body);
  }

  /** Pipes a response from the daemon to the client as it comes. */
  private pipe(response: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(response.statusCode ?? 502, response.statusMessage, forwardHeaders(response.rawHeaders));
    // Docker streams (logs -f, events, pull progress) arrive in pieces; send each at once.
    res.flushHeaders();
    response.pipe(res);
    res.once('close', () => response.destroy());
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = this.socketPath();
    if (typeof target !== 'string') {
      req.resume();
      this.fail(res, 502, target.error);
      return;
    }
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    try {
      if (method === 'POST' && CREATE.test(url)) return await this.create(req, res, target, url);
      if (method === 'GET' && (LIST.test(url) || INSPECT.test(url)))
        return await this.listed(req, res, target, url);
      const response = await this.send(target, method, url, forwardHeaders(req.rawHeaders), req);
      this.pipe(response, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      this.unreachable(res, target, error as Error);
    }
  }

  private async listed(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    socketPath: string,
    url: string,
  ): Promise<void> {
    req.resume();
    const response = await this.send(socketPath, 'GET', url, forwardHeaders(req.rawHeaders));
    const type = String(response.headers['content-type'] ?? '');
    if (response.statusCode !== 200 || !type.includes('json')) {
      this.pipe(response, res);
      return;
    }
    const data = await readAll(response, MAX_LIST_BODY);
    if (!data) {
      this.fail(res, 502, 'Docker sent a container list too big for Wirescry to pass on.');
      return;
    }
    let body = data;
    try {
      const parsed = JSON.parse(data.toString('utf8')) as unknown;
      const rewritten = rewriteListed(parsed, this.options.proxyPort());
      if (rewritten !== parsed) body = Buffer.from(JSON.stringify(rewritten));
    } catch {
      // Not JSON after all: pass it on as it came.
    }
    this.reply(res, {
      status: 200,
      message: response.statusMessage ?? 'OK',
      rawHeaders: response.rawHeaders,
      body,
    });
  }

  private async create(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    socketPath: string,
    url: string,
  ): Promise<void> {
    const original = await readAll(req, MAX_CREATE_BODY);
    const headers = forwardHeaders(req.rawHeaders, ['content-length', 'transfer-encoding']);
    if (!original) {
      this.fail(res, 413, 'This container definition is too big for Wirescry to pass on.');
      return;
    }
    const withBody = (body: Buffer): string[] => [...headers, 'Content-Length', String(body.length)];
    const passOn = async (body: Buffer): Promise<void> => {
      const response = await this.buffered(socketPath, 'POST', url, withBody(body), body);
      if (!response) throw new Error('Docker sent a reply too big to pass on.');
      this.reply(res, response);
    };

    let definition: unknown;
    try {
      definition = JSON.parse(original.toString('utf8'));
    } catch {
      return passOn(original);
    }
    if ((await this.daemonOS(socketPath)) === 'windows') {
      // Windows containers have none of the paths or variables used here.
      this.options.onContainer?.({
        ...describe(definition, url),
        setUp: false,
        reason: 'Windows containers aren’t set up',
      });
      return passOn(original);
    }

    const result: SetUpResult = setUpContainer(definition, {
      proxyPort: this.options.proxyPort(),
      configDir: this.options.configDir,
      direct: await this.directNames(socketPath, definition),
    });
    const changed = Buffer.from(JSON.stringify(result.body));
    const first = await this.buffered(socketPath, 'POST', url, withBody(changed), changed);
    if (!first) throw new Error('Docker sent a reply too big to pass on.');
    if (first.status < 400 || !result.setUp) {
      this.options.onContainer?.({
        ...describe(definition, url),
        setUp: result.setUp,
        reason: result.setUp ? undefined : result.reason,
      });
      this.reply(res, first);
      return;
    }
    // Docker refused the changed container (e.g. it can't share Wirescry's folder). A failed
    // create makes nothing, so try once as the user wrote it: Wirescry mustn't break `docker run`.
    const why = first.body.toString('utf8').slice(0, 500);
    this.log(
      `Docker refused the container with Wirescry's settings (${first.status} ${why}); creating it without them.`,
    );
    const second = await this.buffered(socketPath, 'POST', url, withBody(original), original);
    if (!second) throw new Error('Docker sent a reply too big to pass on.');
    if (second.status < 400) {
      this.options.onContainer?.({
        ...describe(definition, url),
        setUp: false,
        reason: `Docker refused the settings: ${why}`,
      });
    }
    this.reply(res, second);
  }

  /** Other containers' names this one may use, which must skip the proxy. */
  private async directNames(socketPath: string, definition: unknown): Promise<string[]> {
    const labels = (definition as { Labels?: unknown } | null)?.Labels;
    const names = [...namesInDefinition(definition), ...(await composeNames(labels).catch(() => []))];
    for (const network of userNetworks(definition)) {
      try {
        const response = await withTimeout(
          this.buffered(
            socketPath,
            'GET',
            `/networks/${encodeURIComponent(network)}`,
            ['Host', 'docker'],
            undefined,
            8 * 1024 * 1024,
          ),
          LOOKUP_TIMEOUT_MS,
        );
        if (!response || response.status !== 200) continue;
        const info = JSON.parse(response.body.toString('utf8')) as {
          Containers?: Record<string, { Name?: unknown }>;
        };
        for (const container of Object.values(info.Containers ?? {})) {
          if (typeof container?.Name === 'string') names.push(container.Name);
        }
      } catch {
        // The network may not exist yet; Docker will say so when it creates the container.
      }
    }
    return names;
  }

  /** The daemon's OS ("linux" or "windows"), from its ping reply. Remembered for a minute. */
  private async daemonOS(socketPath: string): Promise<string | undefined> {
    if (this.osType && Date.now() - this.osType.at < 60_000) return this.osType.value;
    try {
      const response = await withTimeout(
        this.buffered(socketPath, 'GET', '/_ping', ['Host', 'docker'], undefined, 1024),
        LOOKUP_TIMEOUT_MS,
      );
      const index =
        response?.rawHeaders.findIndex((name, i) => i % 2 === 0 && name.toLowerCase() === 'ostype') ?? -1;
      const value = index >= 0 ? response!.rawHeaders[index + 1]!.toLowerCase() : undefined;
      if (value) this.osType = { value, at: Date.now() };
      return value;
    } catch {
      return undefined;
    }
  }

  /** Attach, exec and BuildKit sessions take over the connection: pass bytes both ways as they are. */
  private upgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    const target = this.socketPath();
    if (typeof target !== 'string') {
      endWithError(client, target.error);
      return;
    }
    const daemon = net.connect(target);
    let connected = false;
    this.upgraded.add(client);
    this.upgraded.add(daemon);
    const done = (): void => {
      client.destroy();
      daemon.destroy();
      this.upgraded.delete(client);
      this.upgraded.delete(daemon);
    };
    daemon.once('connect', () => {
      connected = true;
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      daemon.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) daemon.write(head);
      daemon.pipe(client);
      client.pipe(daemon);
    });
    daemon.once('error', (error) => {
      if (connected) return done();
      this.log(`couldn't reach Docker: ${error.message}`);
      this.upgraded.delete(daemon);
      endWithError(client, `Wirescry couldn't reach Docker at ${target}. Is Docker running?`);
      this.upgraded.delete(client);
    });
    client.once('error', done);
    daemon.once('close', () => {
      if (connected) done();
    });
    client.once('close', done);
  }
}

/** Answers a taken-over connection with a JSON error and closes it. */
function endWithError(socket: net.Socket, message: string): void {
  const body = JSON.stringify({ message });
  socket.end(
    `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function describe(definition: unknown, url: string): { name?: string; image?: string } {
  const name = new URL(url, 'http://docker').searchParams.get('name') ?? undefined;
  const image = (definition as { Image?: unknown } | null)?.Image;
  return { name, image: typeof image === 'string' ? image : undefined };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Removes a socket left by an earlier run. Refuses anything that isn't a socket. */
async function removeStaleSocket(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isSocket()) throw new Error(`${file} exists and isn't a socket`);
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Makes the folder for the relay's socket, private to this user. */
export async function makePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${dir} isn't a folder`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user`);
  }
  await chmod(dir, 0o700);
}
