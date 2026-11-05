import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Where the user's Docker daemon is, as far as Wirescry can tell. */
export type DockerEndpoint =
  /** A daemon on this machine, reached through a Unix socket or a Windows named pipe. */
  | { kind: 'local'; socketPath: string; host: string }
  /** A daemon on another machine (tcp://, ssh://). Wirescry doesn't set those up. */
  | { kind: 'remote'; host: string }
  /** No Docker found. */
  | { kind: 'none' };

interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Whether a file exists; replaced in tests. */
  exists?: (file: string) => Promise<boolean>;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads a DOCKER_HOST-style address. Undefined if it isn't one. */
export function parseDockerHost(
  host: string,
  platform: NodeJS.Platform = process.platform,
): DockerEndpoint | undefined {
  const value = host.trim();
  if (value.startsWith('unix://')) {
    const socketPath = value.slice('unix://'.length);
    return socketPath ? { kind: 'local', socketPath, host: value } : undefined;
  }
  if (value.startsWith('npipe://')) {
    // npipe:////./pipe/docker_engine → \\.\pipe\docker_engine
    const rest = value.slice('npipe://'.length).replace(/\//g, '\\');
    const pipe = /^\\\\([^\\]+)\\pipe\\[^\\]+$/i.exec(rest);
    if (!pipe) return undefined;
    // \\server\pipe\name is Docker on another computer, reached over the network.
    if (pipe[1] !== '.') return { kind: 'remote', host: value };
    return { kind: 'local', socketPath: rest, host: value };
  }
  if (/^(tcp|ssh|http|https):\/\//i.test(value)) return { kind: 'remote', host: value };
  // A bare path is how some tools write a socket.
  if (platform !== 'win32' && value.startsWith('/'))
    return { kind: 'local', socketPath: value, host: `unix://${value}` };
  return undefined;
}

/** The Docker CLI's config folder. */
function configDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.DOCKER_CONFIG || path.join(home, '.docker');
}

/** The name of the context the Docker CLI would use, or undefined for its default. */
async function currentContext(env: NodeJS.ProcessEnv, home: string): Promise<string | undefined> {
  if (env.DOCKER_CONTEXT) return env.DOCKER_CONTEXT;
  try {
    const config = JSON.parse(await readFile(path.join(configDir(env, home), 'config.json'), 'utf8')) as {
      currentContext?: unknown;
    };
    return typeof config.currentContext === 'string' && config.currentContext
      ? config.currentContext
      : undefined;
  } catch {
    return undefined;
  }
}

/** The daemon address a named context points at, from the CLI's context store. */
async function contextHost(name: string, env: NodeJS.ProcessEnv, home: string): Promise<string | undefined> {
  const id = createHash('sha256').update(name).digest('hex');
  try {
    const meta = JSON.parse(
      await readFile(path.join(configDir(env, home), 'contexts', 'meta', id, 'meta.json'), 'utf8'),
    ) as { Endpoints?: { docker?: { Host?: unknown } } };
    const host = meta.Endpoints?.docker?.Host;
    return typeof host === 'string' ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the daemon the Docker CLI would talk to, the way the CLI does: DOCKER_HOST, then the
 * current context, then the platform's usual socket. Reads files only; runs nothing.
 */
export async function findDockerEndpoint(options: FindOptions = {}): Promise<DockerEndpoint> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? fileExists;

  if (env.DOCKER_HOST) return parseDockerHost(env.DOCKER_HOST, platform) ?? { kind: 'none' };

  const context = await currentContext(env, home);
  if (context && context !== 'default') {
    const host = await contextHost(context, env, home);
    // A context that names no daemon, or can't be read, leaves Docker as the CLI would fail to use it.
    if (host) return parseDockerHost(host, platform) ?? { kind: 'none' };
    return { kind: 'none' };
  }

  if (platform === 'win32') {
    // Docker Desktop's pipe. Named pipes can't be checked for without connecting, so assume it
    // when Docker's config folder is there.
    return (await exists(configDir(env, home)))
      ? { kind: 'local', socketPath: '\\\\.\\pipe\\docker_engine', host: 'npipe:////./pipe/docker_engine' }
      : { kind: 'none' };
  }
  const candidates = ['/var/run/docker.sock'];
  // Docker Desktop's own socket, used when the /var/run link isn't set up.
  if (platform === 'darwin') candidates.push(path.join(home, '.docker', 'run', 'docker.sock'));
  if (platform === 'linux') candidates.push(path.join(home, '.docker', 'desktop', 'docker.sock'));
  for (const socketPath of candidates) {
    if (await exists(socketPath)) return { kind: 'local', socketPath, host: `unix://${socketPath}` };
  }
  return { kind: 'none' };
}
