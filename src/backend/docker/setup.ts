import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DockerStatus } from '../../shared/api';
import { dockerBridgeChecker } from './bridges';
import { findDockerEndpoint, type DockerEndpoint } from './endpoint';
import { DockerRelay, makePrivateDir, type ContainerCreated } from './relay';
export type { ContainerCreated };

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
  private setUpIps = new Set<string>();
  private unsupported?: string;
  private active: boolean;
  private lastContainer?: ContainerCreated;
  private setUpIpsAt = -Infinity;

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
   * Whether a container at this address may reach services on this computer's loopback through
   * the proxy: only containers Wirescry set up, or this computer's own addresses (containers on
   * the host's network). The daemon is asked again when an address is new, at most every 250 ms.
   */
  async mayReachThisComputer(address: string): Promise<boolean> {
    const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
    const own = Object.values(os.networkInterfaces())
      .flat()
      .some((info) => info?.address === v4);
    if (own) return true;
    if (!this.relay) return false;
    if (this.setUpIps.has(v4)) return true;
    if (Date.now() - this.setUpIpsAt < 250) return false;
    this.setUpIpsAt = Date.now();
    this.setUpIps = await this.relay.setUpAddresses().catch(() => new Set<string>());
    return this.setUpIps.has(v4);
  }

  /** Whether the proxy takes a connection from this address: a container on a Linux Docker bridge. */
  allowsAddress(address: string): boolean {
    return this.platform === 'linux' && !!this.relay && this.fromBridge(address);
  }

  async stop(): Promise<void> {
    await this.refreshing?.catch(() => undefined);
    const relay = this.relay;
    this.relay = undefined;
    await relay?.stop();
  }
}
