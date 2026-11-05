import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DockerStatus } from '../../shared/api';
import { dockerBridgeChecker } from './bridges';
import { findDockerEndpoint, type DockerEndpoint } from './endpoint';
import { DockerRelay, makePrivateDir, type ContainerCreated } from './relay';

/** Unix socket paths longer than this don't fit in sockaddr_un on macOS (104 bytes, with the NUL). */
const MAX_SOCKET_PATH = 100;

export interface DockerSetupOptions {
  dataDir: string;
  enabled: boolean;
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
  let dir = path.join(dataDir, 'docker');
  if (Buffer.byteLength(path.join(dir, 'docker.sock')) > MAX_SOCKET_PATH) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    dir = path.join(os.tmpdir(), `wirescry-${uid}-${id}`);
  }
  const listenPath = path.join(dir, 'docker.sock');
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

  constructor(private readonly options: DockerSetupOptions) {
    this.platform = options.platform ?? process.platform;
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
    try {
      this.endpoint = await (this.options.findEndpoint ?? (() => findDockerEndpoint()))();
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
        onContainer: this.options.onContainer,
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
    return JSON.stringify(this.status()) !== before;
  }

  status(): DockerStatus {
    const { endpoint } = this;
    if (endpoint.kind === 'none') return { state: 'none' };
    if (endpoint.kind === 'remote') return { state: 'remote', daemon: endpoint.host };
    if (!this.relay) return { state: 'failed', daemon: endpoint.host, error: this.error ?? 'Not started.' };
    return { state: 'ready', daemon: endpoint.host };
  }

  /** What a Wirescry terminal adds to its environment for Docker. */
  terminalEnv(): Record<string, string> {
    if (!this.relay || this.endpoint.kind !== 'local') return {};
    return { DOCKER_HOST: relayAddress(this.options.dataDir, this.platform).dockerHost };
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
