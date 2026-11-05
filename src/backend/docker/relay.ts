import { mkdir, lstat, unlink, chmod } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { composeNames } from './compose';
import {
  HOST_NAME,
  isHostName,
  LABELS,
  infrastructureReason,
  redirectSocketMounts,
  skippedDefinition,
  namesInDefinition,
  rewriteListed,
  setUpContainer,
  userNetworks,
  type SetUpResult,
} from './container';
import type { DockerEndpoint } from './endpoint';
import { parseInfo, unsupportedReason, type DaemonInfo } from './runtime';

const VERSION = String.raw`(?:/v\d+(?:\.\d+)*)?`;
const CREATE = new RegExp(`^${VERSION}/containers/create(?:\\?|$)`);
const LIST = new RegExp(`^${VERSION}/containers/json(?:\\?|$)`);
const INSPECT = new RegExp(`^${VERSION}/containers/[^/?]+/json(?:\\?|$)`);

/** Create bodies are a few KB; anything this big isn't one Wirescry should be changing. */
const MAX_CREATE_BODY = 16 * 1024 * 1024;
/** Container lists bigger than this get an error instead: Wirescry would have to hold them whole. */
const MAX_LIST_BODY = 64 * 1024 * 1024;
/** How many containers on a network are looked at for their aliases. */
const MAX_PEERS = 50;
/** How long the relay waits for the daemon when asking it something on its own behalf. */
const LOOKUP_TIMEOUT_MS = 3000;

/** Marks requests a Wirescry relay passed on, so a second relay in front of the daemon leaves them alone. */
const RELAY_HEADER = 'X-Wirescry-Relay';

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
  /** The platform Wirescry runs on, which decides which Docker setups it sets up. */
  platform?: NodeJS.Platform;
  /** false while the user has Docker setup turned off: containers are then passed on as written. */
  active?: () => boolean;
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
    let ended = false;
    stream.once('end', () => {
      ended = true;
      resolve(over ? undefined : Buffer.concat(chunks));
    });
    stream.once('error', reject);
    // A connection that drops mid-body closes without 'end', and not always with 'error'.
    stream.once('close', () => {
      if (!ended) reject(new Error('The connection closed before the whole message arrived.'));
    });
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
  private readonly info = new Map<string, { value: DaemonInfo; at: number }>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: DockerRelayOptions) {
    this.platform = options.platform ?? process.platform;
  }

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
      const request = http.request({
        socketPath,
        method,
        path,
        headers: [...rawHeaders, RELAY_HEADER, '1'],
        agent: false,
      });
      request.once('response', resolve);
      request.once('error', reject);
      if (Buffer.isBuffer(body)) request.end(body);
      else if (body) {
        // A client that stops sending halfway aborts the request to Docker too.
        pipeline(body, request, (error) => {
          if (error) request.destroy(error);
        });
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
    // Either side breaking off ends the other: a client that hangs up stops the stream from
    // Docker, and Docker dying mid-response cuts the client off instead of leaving it waiting.
    pipeline(response, res, (error) => {
      if (error) {
        response.destroy();
        res.destroy();
      }
    });
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
    // Already through another Wirescry relay (a second install in front of this one's daemon):
    // that one has set the container up, so this one only passes it on.
    const relayed = req.headers[RELAY_HEADER.toLowerCase()] !== undefined;
    try {
      if (!relayed && method === 'POST' && CREATE.test(url)) return await this.create(req, res, target, url);
      if (!relayed && method === 'GET' && (LIST.test(url) || INSPECT.test(url))) {
        return await this.listed(req, res, target, url);
      }
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
    const info = await this.daemonInfo(socketPath);
    // A client that mounts the socket from DOCKER_HOST (Testcontainers' Ryuk, act) gets the
    // daemon's own socket: set up or not, the relay's can't be mounted reliably.
    redirectSocketMounts(definition, this.relayPaths(), this.daemonSocketInside(info, socketPath));
    // Left as written, but labelled so: Compose would otherwise see it as not set up, and
    // recreate it on every `up` from a Wirescry terminal.
    const asWritten = Buffer.from(JSON.stringify(skippedDefinition(definition)));
    const leaveAlone = async (reason: string): Promise<void> => {
      this.options.onContainer?.({ ...describe(definition, url), setUp: false, reason });
      return passOn(asWritten);
    };

    if (this.options.active && !this.options.active()) return passOn(Buffer.from(JSON.stringify(definition)));
    const unsupported = unsupportedReason(info, this.platform);
    if (unsupported) return leaveAlone(unsupported);
    const infrastructure = infrastructureReason(definition, describe(definition, url).name);
    if (infrastructure) return leaveAlone(`${infrastructure}.`);
    const sharedNetwork = await this.sharedNetworkReason(socketPath, definition, info);
    if (sharedNetwork) return leaveAlone(sharedNetwork);

    const result: SetUpResult = setUpContainer(definition, {
      proxyPort: this.options.proxyPort(),
      configDir: this.options.configDir,
      direct: await this.directNames(socketPath, definition),
      imageEnv: await this.imageEnv(socketPath, definition),
      selinux: info?.selinux,
    });
    const changed = Buffer.from(JSON.stringify(result.body));
    const first = await this.buffered(socketPath, 'POST', url, withBody(changed), changed);
    if (!first) throw new Error('Docker sent a reply too big to pass on.');
    // Only a refusal Wirescry's settings could have caused is worth retrying: not "no such
    // image" (404) or "name already in use" (409), which the original would get too.
    const refusedSettings = first.status === 400 || first.status >= 500;
    if (!refusedSettings || !result.setUp) {
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
    const second = await this.buffered(socketPath, 'POST', url, withBody(asWritten), asWritten);
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

  /** Ways a client may write the relay's own path, e.g. in a bind mount taken from DOCKER_HOST. */
  private relayPaths(): string[] {
    const own = this.options.listenPath;
    if (own.startsWith('\\\\')) return [own, own.replace(/\\/g, '/')];
    // macOS: /var and /tmp are links into /private.
    return [own, own.startsWith('/private/') ? own.slice('/private'.length) : `/private${own}`];
  }

  /** The daemon's socket as a container mount sees it. */
  private daemonSocketInside(info: DaemonInfo | undefined, socketPath: string): string {
    // Docker Desktop's VM has the socket here, whatever the path on this computer.
    if (!info || /docker desktop/i.test(info.operatingSystem) || socketPath.startsWith('\\\\')) {
      return '/var/run/docker.sock';
    }
    return socketPath;
  }

  /**
   * A container sharing another's network (`--network container:x`) uses that one's host
   * entries. Unless that one was set up, or Docker Desktop provides host.docker.internal
   * anyway, the proxy's name wouldn't resolve and all its HTTP would fail.
   */
  private async sharedNetworkReason(
    socketPath: string,
    definition: unknown,
    info: DaemonInfo | undefined,
  ): Promise<string | undefined> {
    const mode = (definition as { HostConfig?: { NetworkMode?: unknown } } | null)?.HostConfig?.NetworkMode;
    if (typeof mode !== 'string' || !mode.startsWith('container:')) return undefined;
    if (info && /docker desktop/i.test(info.operatingSystem)) return undefined;
    const other = mode.slice('container:'.length);
    try {
      const response = await withTimeout(
        this.buffered(socketPath, 'GET', `/containers/${encodeURIComponent(other)}/json`, ['Host', 'docker']),
        LOOKUP_TIMEOUT_MS,
      );
      if (response?.status === 200) {
        const inspected = JSON.parse(response.body.toString('utf8')) as {
          HostConfig?: { ExtraHosts?: unknown };
          Config?: { Labels?: Record<string, unknown> };
        };
        const hosts = Array.isArray(inspected.HostConfig?.ExtraHosts) ? inspected.HostConfig.ExtraHosts : [];
        const hasHost = hosts.some(
          (entry) => typeof entry === 'string' && entry.toLowerCase().split(/[:=]/)[0] === HOST_NAME,
        );
        if (hasHost || inspected.Config?.Labels?.[LABELS.setup] === 'proxy') return undefined;
      }
    } catch {
      // Can't tell: leave it alone rather than risk cutting off its HTTP.
    }
    return `it shares the network of ${other}, which Wirescry didn't set up.`;
  }

  /** The environment the container's image sets, which the container gets unless told otherwise. */
  private async imageEnv(socketPath: string, definition: unknown): Promise<string[]> {
    const image = (definition as { Image?: unknown } | null)?.Image;
    if (typeof image !== 'string' || !image) return [];
    try {
      // Image names keep their / and : in the path, as the Docker CLI sends them.
      const name = image
        .split('/')
        .map(encodeURIComponent)
        .join('/')
        .replace(/%3A/gi, ':')
        .replace(/%40/g, '@');
      const response = await withTimeout(
        this.buffered(
          socketPath,
          'GET',
          `/images/${name}/json`,
          ['Host', 'docker'],
          undefined,
          8 * 1024 * 1024,
        ),
        LOOKUP_TIMEOUT_MS,
      );
      if (!response || response.status !== 200) return [];
      const env = (JSON.parse(response.body.toString('utf8')) as { Config?: { Env?: unknown } }).Config?.Env;
      return Array.isArray(env) ? env.filter((e): e is string => typeof e === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Names and addresses this container may use for other containers, which must skip the proxy
   * (the proxy runs on this computer and can't reach them): Compose services, aliases, the
   * names and aliases of containers already on its networks, and those networks' subnets.
   */
  private async directNames(socketPath: string, definition: unknown): Promise<string[]> {
    const labels = (definition as { Labels?: unknown } | null)?.Labels;
    const names = [...namesInDefinition(definition), ...(await composeNames(labels).catch(() => []))];
    const get = async (path: string): Promise<unknown> => {
      const response = await withTimeout(
        this.buffered(socketPath, 'GET', path, ['Host', 'docker'], undefined, 8 * 1024 * 1024),
        LOOKUP_TIMEOUT_MS,
      );
      return response?.status === 200 ? (JSON.parse(response.body.toString('utf8')) as unknown) : undefined;
    };
    const networks = userNetworks(definition);
    // The default bridge has no names, but its containers are reached by address.
    const mode = (definition as { HostConfig?: { NetworkMode?: unknown } } | null)?.HostConfig?.NetworkMode;
    const onDefaultBridge = mode === undefined || mode === '' || mode === 'default' || mode === 'bridge';
    for (const network of onDefaultBridge ? [...networks, 'bridge'] : networks) {
      try {
        const info = (await get(`/networks/${encodeURIComponent(network)}`)) as
          | {
              Name?: unknown;
              IPAM?: { Config?: Array<{ Subnet?: unknown }> };
              Containers?: Record<string, { Name?: unknown }>;
            }
          | undefined;
        if (!info) continue;
        for (const config of info.IPAM?.Config ?? []) {
          if (typeof config?.Subnet === 'string') names.push(config.Subnet);
        }
        if (network === 'bridge') continue;
        const peers = Object.entries(info.Containers ?? {}).slice(0, MAX_PEERS);
        for (const [id, container] of peers) {
          if (typeof container?.Name === 'string') names.push(container.Name);
          // Aliases (--network-alias, Testcontainers' withNetworkAliases) need the container itself.
          const inspected = (await get(`/containers/${encodeURIComponent(id)}/json`).catch(
            () => undefined,
          )) as
            | { NetworkSettings?: { Networks?: Record<string, { Aliases?: unknown; DNSNames?: unknown }> } }
            | undefined;
          const endpoint =
            inspected?.NetworkSettings?.Networks?.[typeof info.Name === 'string' ? info.Name : network];
          for (const list of [endpoint?.Aliases, endpoint?.DNSNames]) {
            if (Array.isArray(list)) names.push(...list.filter((n): n is string => typeof n === 'string'));
          }
        }
      } catch {
        // The network may not exist yet; Docker will say so when it creates the container.
      }
    }
    return names.filter(
      (name) => isHostName(name) || /^[\d.]+\/\d+$/.test(name) || /^[\da-f:]+\/\d+$/i.test(name),
    );
  }

  /** Why the daemon's containers are left alone, if they are; undefined if not, or if it can't be asked. */
  async unsupportedReason(): Promise<string | undefined> {
    const target = this.socketPath();
    if (typeof target !== 'string') return undefined;
    return unsupportedReason(await this.daemonInfo(target), this.platform);
  }

  /** The addresses of running containers Wirescry set up, from the daemon. */
  async setUpAddresses(): Promise<Set<string>> {
    const target = this.socketPath();
    const addresses = new Set<string>();
    if (typeof target !== 'string') return addresses;
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${LABELS.setup}=proxy`], status: ['running'] }),
    );
    const response = await withTimeout(
      this.buffered(target, 'GET', `/containers/json?filters=${filters}`, ['Host', 'docker']),
      LOOKUP_TIMEOUT_MS,
    );
    if (!response || response.status !== 200) return addresses;
    const list = JSON.parse(response.body.toString('utf8')) as Array<{
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: unknown }> };
    }>;
    for (const container of Array.isArray(list) ? list : []) {
      for (const network of Object.values(container.NetworkSettings?.Networks ?? {})) {
        if (typeof network?.IPAddress === 'string' && network.IPAddress) addresses.add(network.IPAddress);
      }
    }
    return addresses;
  }

  /** What the daemon is, from GET /info. Remembered for a minute per daemon. */
  private async daemonInfo(socketPath: string): Promise<DaemonInfo | undefined> {
    const cached = this.info.get(socketPath);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    try {
      const response = await withTimeout(
        this.buffered(socketPath, 'GET', '/info', ['Host', 'docker'], undefined, 4 * 1024 * 1024),
        LOOKUP_TIMEOUT_MS,
      );
      if (!response || response.status !== 200) return undefined;
      const version = await withTimeout(
        this.buffered(socketPath, 'GET', '/version', ['Host', 'docker'], undefined, 1024 * 1024),
        LOOKUP_TIMEOUT_MS,
      ).catch(() => undefined);
      let versionBody: unknown;
      try {
        versionBody = version?.status === 200 ? JSON.parse(version.body.toString('utf8')) : undefined;
      } catch {
        versionBody = undefined;
      }
      const value = parseInfo(JSON.parse(response.body.toString('utf8')), versionBody);
      if (value) this.info.set(socketPath, { value, at: Date.now() });
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
    const forget = (): void => {
      if (client.destroyed && daemon.destroyed) {
        this.upgraded.delete(client);
        this.upgraded.delete(daemon);
      }
    };
    const destroyBoth = (): void => {
      client.destroy();
      daemon.destroy();
      forget();
    };
    // Written at once, in order: a socket queues writes until it connects.
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    // Other Wirescry relays pass this on untouched (see handle()).
    lines.push(`${RELAY_HEADER}: 1`);
    daemon.write(`${lines.join('\r\n')}\r\n\r\n`);
    // A body sent with the upgrade (exec start's JSON) comes in `head` up to Node 24, and as
    // the request's own data from Node 26: pass on both.
    if (head.length > 0) daemon.write(head);
    req.on('data', (chunk: Buffer) => daemon.write(chunk));
    daemon.once('connect', () => {
      connected = true;
      // pipe() passes each side's end on as a half-close, which `docker run -i` relies on to
      // tell the container stdin has ended, and lets the last output drain before closing.
      daemon.pipe(client);
      client.pipe(daemon);
    });
    daemon.once('error', (error) => {
      if (connected) return destroyBoth();
      this.log(`couldn't reach Docker: ${error.message}`);
      daemon.destroy();
      endWithError(client, `Wirescry couldn't reach Docker at ${target}. Is Docker running?`);
      client.once('close', forget);
    });
    client.once('error', destroyBoth);
    // Once both directions have ended, nothing more can pass: close what's left.
    for (const socket of [client, daemon]) {
      socket.once('close', () => {
        const other = socket === client ? daemon : client;
        if (connected && !other.destroyed) other.end();
        // A side that never finishes closing after the other went away is closed after a while.
        setTimeout(() => other.destroy(), 30_000).unref();
        forget();
      });
    }
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
