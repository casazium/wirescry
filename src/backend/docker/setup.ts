import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DockerStatus } from '../../shared/api';
import { dockerBridgeChecker } from './bridges';
import { firewallHint, type FirewallHint, type UfwFiles } from './firewall';
import type { DaemonInfo } from './runtime';
import { findDockerEndpoint, type DockerEndpoint } from './endpoint';
import { DockerRelay, makePrivateDir, type ContainerCreated } from './relay';
export type { ContainerCreated };

/** A clock that never jumps (unlike Date.now() across NTP changes or sleep), for spacing and expiry. */
const clock = (): number => performance.now();
/** How long a just-started container's address is looked for before its connection is refused. */
const NEW_CONTAINER_GRACE_MS = 1500;
/** How long one lookup may take. With the grace above, well inside the proxy's 5 s accept limit. */
const SET_UP_LOOKUP_TIMEOUT_MS = 1000;
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
  /** Called when the status changes other than through refresh() or a container: e.g. the firewall note goes. */
  onStatusChange?: () => void;
  /** Tests: ufw's files instead of /etc/ufw/ufw.conf and /etc/default/ufw. */
  readUfw?: () => UfwFiles;
  /** Tests: this machine's interfaces instead of os.networkInterfaces(). */
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
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
  /** What the daemon said it is at the last refresh, if it was running. */
  private daemon?: DaemonInfo;
  /** A container's connection got through to the proxy, so no firewall is in the way. */
  private bridgeReached = false;

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
    this.daemon = this.relay ? await this.relay.describeDaemon().catch(() => undefined) : undefined;
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
    const firewall = this.firewall();
    return {
      state: 'ready',
      daemon: endpoint.host,
      ...(last ? { lastContainer: { ...last } } : {}),
      ...(firewall ? { firewall } : {}),
    };
  }

  /**
   * A firewall that may block containers from the proxy. Only Docker Engine on Linux, as the
   * daemon says it is: there containers' connections come from Docker's bridges; Docker
   * Desktop's arrive from 127.0.0.1, which firewalls let through. Not once a container's
   * connection has got through: then nothing's in the way.
   */
  private firewall(): FirewallHint | undefined {
    if (this.platform !== 'linux' || this.endpoint.kind !== 'local' || this.bridgeReached) return undefined;
    const daemon = this.daemon;
    if (!daemon || daemon.osType !== 'linux' || /docker desktop/i.test(daemon.operatingSystem))
      return undefined;
    if (this.endpoint.socketPath.includes('/.docker/desktop/')) return undefined;
    return firewallHint(this.options.proxyPort(), this.options.readUfw, this.options.networkInterfaces);
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
    // From a container on a bridge: it got through any firewall here, so the note can go.
    if (!this.bridgeReached) {
      const hadNote = this.status().firewall !== undefined;
      this.bridgeReached = true;
      if (hadNote) this.options.onStatusChange?.();
    }
    return this.isSetUpContainer(v4);
  }

  /**
   * Whether a container Wirescry set up has this address, as of a daemon lookup that started
   * after it arrived. Docker lists a container's address a few milliseconds after its process
   * starts (measured: 15-19 ms, in about 1 in 20 starts), so an address not found yet is
   * looked for again for a little while before it's refused.
   */
  async isSetUpContainer(address: string, arrived = clock()): Promise<boolean> {
    if ((this.setUpIps.get(address) ?? 0) > arrived) return true;
    // A lookup that began just before the connection arrived may still have been after the
    // container started; if it missed it, the next one won't.
    let since = arrived - LOOKUP_SPACING_MS / 2;
    for (;;) {
      await this.lookUpSince(since);
      if ((this.setUpIps.get(address) ?? 0) > clock()) return true;
      if (clock() - arrived >= NEW_CONTAINER_GRACE_MS) return false;
      since = clock();
    }
  }

  /**
   * Waits for a lookup that started at or after `since`. Lookups don't overlap, and start at
   * most every 100 ms, so a burst of new addresses costs a few lookups, not one each. A lookup
   * that fails leaves what was known as it was (entries still run out).
   */
  private async lookUpSince(since: number): Promise<void> {
    for (;;) {
      if (this.lookup && this.lookupStarted >= since) return this.lookup;
      if (this.lookup) {
        await this.lookup;
        continue;
      }
      const wait = this.lookupStarted + LOOKUP_SPACING_MS - clock();
      if (wait > 0) {
        // Timers can fire a little early (Windows' are coarse), so look again rather than
        // assume the spacing has passed.
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.ceil(wait), LOOKUP_SPACING_MS)));
        continue;
      }
      this.lookupStarted = clock();
      this.lookup = (async () => {
        const relay = this.relay;
        if (!relay) return;
        try {
          const found = await relay.setUpAddresses(SET_UP_LOOKUP_TIMEOUT_MS);
          // Replaces what was known: a container that's gone no longer counts, even if its
          // address is given to another.
          const until = clock() + SET_UP_ADDRESS_TTL_MS;
          this.setUpIps = new Map([...found].map((ip) => [ip, until]));
        } catch {
          // Docker didn't answer: keep what's known.
        }
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
