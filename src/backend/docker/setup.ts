import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DockerStatus } from '../../shared/api';
import { dockerBridgeChecker } from './bridges';
import { findDockerEndpoint, type DockerEndpoint } from './endpoint';
import { DockerRelay, makePrivateDir, type ContainerCreated } from './relay';
export type { ContainerCreated };

/** How long an address of a set-up container is trusted before the daemon is asked again. */
const SET_UP_ADDRESS_TTL_MS = 10_000;
/** The least time between two lookups of set-up containers' addresses. */
const LOOKUP_SPACING_MS = 100;
/** Unix socket paths longer than this don't fit in sockaddr_un on macOS (104 bytes, with the NUL). */
const MAX_SOCKET_PATH = 100;

export interface DockerSetupOptions {
  dataDir: string;
  /** false when Docker setup is turned off for this run (tests); the user's switch is `setActive`. */
  enabled: boolean;
  /** The user's setting: whether to set containers up. */
  active?: boolean;
  findEndpoint?: () => Promise<DockerEndpoint>;
  proxyPort: () => number;
  /** The folder mounted into containers. */
  containerDir: () => string;
  platform?: NodeJS.Platform;
  onContainer?: (event: ContainerCreated) => void;
}

/** Where the relay listens, and the DOCKER_HOST value for it. Stable across restarts, so open terminals keep working. */
export function relayAddress(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): {
  listenPath: string;
  dockerHost: string;
  dir?: string;
} {
  const id = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
  if (platform === 'win32') {
    const name = `wirescry-docker-${id}`;
    return { listenPath: `\\\\.\\pipe\\${name}`, dockerHost: `npipe:////./pipe/${name}` };
  }
  // Unix paths, whatever this process's own platform is.
  let dir = path.posix.join(dataDir, 'docker');
  // Too long for a socket, or with a space (macOS's "Application Support"), which Docker
  // clients other than the CLI, such as Java's, refuse in DOCKER_HOST.
  const candidate = path.posix.join(dir, 'docker.sock');
  if (Buffer.byteLength(candidate) > MAX_SOCKET_PATH || /\s/.test(candidate)) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    dir = path.posix.join(os.tmpdir(), `wirescry-${uid}-${id}`);
  }
  const listenPath = path.posix.join(dir, 'docker.sock');
  return { listenPath, dockerHost: `unix://${listenPath}`, dir };
}

/**
 * Docker setup for Wirescry terminals: finds the user's daemon, runs the relay in front of it,
 * and says what terminals need (DOCKER_HOST) and which container connections the proxy takes.
 */
export class DockerSetup {
  private endpoint: DockerEndpoint = { kind: 'none' };
  private relay?: DockerRelay;
  private error?: string;
  private refreshing?: Promise<boolean>;
  private readonly platform: NodeJS.Platform;
  private readonly fromBridge = dockerBridgeChecker();
  /** Addresses of containers Wirescry set up, each with when to stop trusting it without asking again. */
  private setUpIps = new Map<string, number>();
  private lookup?: Promise<void>;
  private lookupStarted = -Infinity;
  private unsupported?: string;
  private active: boolean;
  private lastContainer?: ContainerCreated;

  constructor(private readonly options: DockerSetupOptions) {
    this.platform = options.platform ?? process.platform;
    this.active = options.active ?? true;
  }

  /**
   * Turns setting containers up on or off. The relay keeps running either way, passing
   * everything on as written while off, so terminals already pointed at it keep working.
   */
  setActive(active: boolean): void {
    this.active = active;
  }

  /** Looks for Docker again and starts the relay if it's needed. Resolves to whether anything changed. */
  refresh(): Promise<boolean> {
    if (!this.options.enabled) return Promise.resolve(false);
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const before = JSON.stringify(this.status());
    const own = relayAddress(this.options.dataDir, this.platform).listenPath;
    const isOwn = (endpoint: DockerEndpoint): boolean =>
      endpoint.kind === 'local' && endpoint.socketPath === own;
    try {
      this.endpoint = await (this.options.findEndpoint ?? (() => findDockerEndpoint()))();
      // Wirescry started from one of its own terminals has DOCKER_HOST pointing at itself:
      // look past it, as the CLI would without it, rather than relay to itself for ever.
      if (isOwn(this.endpoint) && !this.options.findEndpoint) {
        this.endpoint = await findDockerEndpoint({ env: { ...process.env, DOCKER_HOST: undefined } });
      }
      if (isOwn(this.endpoint)) this.endpoint = { kind: 'none' };
    } catch {
      this.endpoint = { kind: 'none' };
    }
    if (this.endpoint.kind === 'local' && !this.relay) {
      const address = relayAddress(this.options.dataDir, this.platform);
      const relay = new DockerRelay({
        listenPath: address.listenPath,
        upstream: () => this.endpoint,
        proxyPort: this.options.proxyPort,
        configDir: this.options.containerDir(),
        onContainer: (event) => {
          this.lastContainer = event;
          this.options.onContainer?.(event);
        },
        platform: this.platform,
        active: () => this.active,
      });
      try {
        if (address.dir) await makePrivateDir(address.dir);
        await relay.start();
        this.relay = relay;
        this.error = undefined;
      } catch (error) {
        this.error = (error as Error)?.message ?? String(error);
        console.error('[wirescry] docker: could not start the relay:', error);
      }
    }
    // Which Docker this is, if it's running: one Wirescry doesn't set up is said so up front.
    // When it isn't running, the relay checks again for each container.
    this.unsupported = this.relay ? await this.relay.unsupportedReason().catch(() => undefined) : undefined;
    return JSON.stringify(this.status()) !== before;
  }

  status(): DockerStatus {
    const { endpoint } = this;
    if (endpoint.kind === 'none') return { state: 'none' };
    if (endpoint.kind === 'remote') return { state: 'remote', daemon: endpoint.host };
    if (!this.relay) return { state: 'failed', daemon: endpoint.host, error: this.error ?? 'Not started.' };
    if (!this.active) return { state: 'off', daemon: endpoint.host };
    if (this.unsupported) return { state: 'unsupported', daemon: endpoint.host, error: this.unsupported };
    const last = this.lastContainer;
    return { state: 'ready', daemon: endpoint.host, ...(last ? { lastContainer: { ...last } } : {}) };
  }

  /** What a Wirescry terminal adds to its environment for Docker. */
  terminalEnv(): Record<string, string> {
    if (!this.relay || this.endpoint.kind !== 'local' || this.unsupported || !this.active) return {};
    return { DOCKER_HOST: relayAddress(this.options.dataDir, this.platform).dockerHost };
  }

  /**
   * Whether the proxy takes a connection from this non-loopback address. Only on Linux, where
   * containers' connections come from Docker's bridges, and only from containers Wirescry set
   * up (asked of the daemon) or this computer's own address on a bridge (containers on the
   * host's network). Any other container could otherwise use the proxy to reach services that listen
   * only on this computer's localhost. Docker Desktop's connections arrive from 127.0.0.1 and
   * never get here.
   */
  acceptsConnection(address: string): boolean | Promise<boolean> {
    if (this.platform !== 'linux' || !this.relay) return false;
    const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (!this.fromBridge(v4)) return false;
    // This computer's own address on a Docker bridge (its gateway): a container on the host's
    // network reaching host.docker.internal. Its LAN address isn't accepted: that's the network.
    const own = Object.values(os.networkInterfaces())
      .flat()
      .some((info) => info?.address === v4);
    if (own) return true;
    return this.isSetUpContainer(v4);
  }

  /** Whether a container Wirescry set up has this address, as of a daemon lookup no older than its arrival. */
  async isSetUpContainer(address: string, now = Date.now()): Promise<boolean> {
    if ((this.setUpIps.get(address) ?? 0) > now) return true;
    await this.lookUpSince(now);
    return (this.setUpIps.get(address) ?? 0) > Date.now();
  }

  /**
   * Waits for a lookup that started at or after `since`: a container that started a moment ago
   * must be looked for after it started. Lookups don't overlap, and start at most every 100 ms,
   * so a burst of new addresses costs a few lookups, not one each.
   */
  private async lookUpSince(since: number): Promise<void> {
    for (;;) {
      if (this.lookup && this.lookupStarted >= since) return this.lookup;
      if (this.lookup) {
        await this.lookup;
        continue;
      }
      const wait = this.lookupStarted + LOOKUP_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.lookup) continue;
      this.lookupStarted = Date.now();
      this.lookup = (async () => {
        const relay = this.relay;
        const found = relay ? await relay.setUpAddresses().catch(() => new Set<string>()) : new Set<string>();
        // Replaces what was known: a container that's gone no longer counts, even if its
        // address is given to another.
        const until = Date.now() + SET_UP_ADDRESS_TTL_MS;
        this.setUpIps = new Map([...found].map((ip) => [ip, until]));
      })().finally(() => {
        this.lookup = undefined;
      });
      return this.lookup;
    }
  }

  async stop(): Promise<void> {
    await this.refreshing?.catch(() => undefined);
    const relay = this.relay;
    this.relay = undefined;
    await relay?.stop();
  }
}
