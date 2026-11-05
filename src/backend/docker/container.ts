import { javaToolOptions } from '../../shared/terminal-env';

/** Where a set-up container sees Wirescry's certificates and config files (a read-only bind mount). */
export const MOUNT_POINT = '/run/wirescry';
/** The name containers reach the host by. Docker Desktop provides it; elsewhere Wirescry adds it. */
export const HOST_NAME = 'host.docker.internal';

/** Labels Wirescry puts on containers it creates. */
export const LABELS = {
  /** "proxy" when the container got the proxy settings, "skipped" when it was left as it was. */
  setup: 'app.wirescry.setup',
  /** The proxy port the container was pointed at. */
  port: 'app.wirescry.proxy-port',
  /** Compose's own config hash, before Wirescry changed it. */
  composeHash: 'app.wirescry.compose-hash',
} as const;
export const COMPOSE_HASH_LABEL = 'com.docker.compose.config-hash';
export const COMPOSE_FILES_LABEL = 'com.docker.compose.project.config_files';
export const COMPOSE_DIR_LABEL = 'com.docker.compose.project.working_dir';
/** Added to Compose's hash, so Compose sees the container as out of date. */
export const HASH_SUFFIX = '-wirescry';

/** Files in the folder mounted at MOUNT_POINT. */
export const CONTAINER_FILES = {
  ca: 'ca.pem',
  bundle: 'ca-bundle.pem',
  phpDir: 'php',
  javaTrustStore: 'java/wirescry-truststore.jks',
} as const;

const inMount = (file: string): string => `${MOUNT_POINT}/${file}`;

/** The variables a set-up container gets. NO_PROXY is added separately, merged with the container's own. */
export function containerEnv(proxyPort: number): Record<string, string> {
  const proxy = `http://${HOST_NAME}:${proxyPort}`;
  const bundle = inMount(CONTAINER_FILES.bundle);
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: inMount(CONTAINER_FILES.ca),
    SSL_CERT_FILE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    CURL_CA_BUNDLE: bundle,
    GIT_SSL_CAINFO: bundle,
    PHP_INI_SCAN_DIR: `:${inMount(CONTAINER_FILES.phpDir)}`,
    JAVA_TOOL_OPTIONS: javaToolOptions(proxyPort, inMount(CONTAINER_FILES.javaTrustStore), HOST_NAME),
    WIRESCRY_PROXY: proxy,
  };
}

/** Names that skip the proxy in every set-up container. */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1'];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Splits a NO_PROXY value into its entries. */
function noProxyEntries(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Keeps the first of each entry, ignoring case. */
function unique(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface SetUpOptions {
  proxyPort: number;
  /** The host folder mounted at MOUNT_POINT. */
  configDir: string;
  /** Names the container may use for other containers, which must skip the proxy. */
  direct: string[];
  /**
   * The image's own environment (its ENV lines). The container gets these unless the create
   * request sets them, so they count as the container's when merging.
   */
  imageEnv?: string[];
  /** The daemon labels files for SELinux: the mount then needs relabelling to be readable. */
  selinux?: boolean;
}

/**
 * Variables naming a certificate file the container's tools trust. One the user set for the
 * container (compose `environment:`, `docker run -e`) is kept: replacing it would break the
 * container's HTTPS to hosts that skip the proxy (often other containers, with an internal CA).
 * Tools reading it then don't trust Wirescry, and their HTTPS through it fails, which shows in
 * Wirescry.
 */
const CA_VARIABLES = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
];

/** An IPv4 CIDR range on an octet boundary as a Java wildcard, e.g. 10.0.0.0/8 → 10.*. */
function cidrAsWildcard(cidr: string): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(8|16|24)$/.exec(cidr);
  if (!match) return undefined;
  const octets = Number(match[5]) / 8;
  return `${match.slice(1, 1 + octets).join('.')}.*`;
}

/** NO_PROXY entries as a Java http.nonProxyHosts value, which the JVM reads instead of NO_PROXY. */
export function javaNonProxyHosts(entries: string[]): string {
  const hosts = new Set<string>();
  for (const raw of entries) {
    let entry = raw.trim();
    if (!entry || entry === '*') continue;
    if (entry.includes('/')) {
      // Java has no CIDR; whole-octet ranges become wildcards (172.18.0.0/16 → 172.18.*).
      const pattern = cidrAsWildcard(entry);
      if (pattern) hosts.add(pattern);
      continue;
    }
    if (entry.startsWith('['))
      entry = entry.slice(1, entry.indexOf(']') > 0 ? entry.indexOf(']') : undefined);
    else if (/^[^:]+:\d+$/.test(entry)) entry = entry.slice(0, entry.lastIndexOf(':')); // host:port
    if (entry.startsWith('.')) entry = `*${entry}`;
    if (!/^[A-Za-z0-9.*_:-]+$/.test(entry)) continue;
    hosts.add(entry.includes(':') ? `[${entry}]` : entry);
    if (entry === '127.0.0.1') hosts.add('127.*');
  }
  return [...hosts].join('|');
}

/**
 * Containers that tools start once and restart by themselves later (dev containers, BuildKit
 * builders, Kubernetes-in-Docker nodes). Set up, they'd lose their HTTP whenever Wirescry
 * isn't running, long after the terminal that made them, so they're left alone.
 */
export function infrastructureReason(input: unknown, name: string | undefined): string | undefined {
  const labels = isObject(input) && isObject(input.Labels) ? input.Labels : {};
  const keys = Object.keys(labels);
  if (keys.some((key) => key.startsWith('devcontainer.'))) return 'it’s a dev container';
  if (name?.startsWith('buildx_buildkit_')) return 'it’s a BuildKit builder';
  if (
    keys.some((key) => key.startsWith('io.x-k8s.kind.') || key.startsWith('k3d.') || key.includes('minikube'))
  ) {
    return 'it’s a Kubernetes node';
  }
  return undefined;
}

/**
 * Points mounts of Wirescry's relay socket (which a client found in DOCKER_HOST, as
 * Testcontainers does for Ryuk) at the daemon's own socket instead: the relay's socket is
 * on this computer, where the daemon may not be able to mount it, and goes away with Wirescry.
 * `relayPaths` are the ways the relay's path can be written; `daemonSocket` is the daemon's
 * own socket as the daemon sees it. Changes the body in place.
 */
export function redirectSocketMounts(body: unknown, relayPaths: string[], daemonSocket: string): void {
  if (!isObject(body) || !isObject(body.HostConfig)) return;
  const hostConfig = body.HostConfig;
  const isRelay = (source: string): boolean => relayPaths.includes(source);
  if (Array.isArray(hostConfig.Binds)) {
    hostConfig.Binds = hostConfig.Binds.map((bind) => {
      if (typeof bind !== 'string') return bind;
      for (const relayPath of relayPaths) {
        if (bind.startsWith(`${relayPath}:`)) return `${daemonSocket}${bind.slice(relayPath.length)}`;
      }
      return bind;
    });
  }
  if (Array.isArray(hostConfig.Mounts)) {
    hostConfig.Mounts = hostConfig.Mounts.map((mount) =>
      isObject(mount) && typeof mount.Source === 'string' && isRelay(mount.Source)
        ? { ...mount, Source: daemonSocket }
        : mount,
    );
  }
}

/** The definition as the user wrote it, labelled as left alone, so Compose doesn't keep recreating it. */
export function skippedDefinition(input: unknown): unknown {
  if (!isObject(input)) return input;
  const body: Json = structuredClone(input);
  body.Labels = { ...(isObject(body.Labels) ? body.Labels : {}), [LABELS.setup]: 'skipped' };
  return body;
}

export type SetUpResult = { setUp: true; body: Json } | { setUp: false; body: Json; reason: string };

/** Whether a mount (Binds entry or Mounts item) already uses MOUNT_POINT. */
function mountPointTaken(hostConfig: Json): boolean {
  const binds = Array.isArray(hostConfig.Binds) ? hostConfig.Binds : [];
  const mounts = Array.isArray(hostConfig.Mounts) ? hostConfig.Mounts : [];
  const under = (target: string): boolean =>
    target === MOUNT_POINT ||
    target.startsWith(`${MOUNT_POINT}/`) ||
    MOUNT_POINT.startsWith(`${target.replace(/\/+$/, '')}/`);
  return (
    // "source:target[:options]"; the source may be a Windows path with a colon of its own.
    binds.some(
      (bind) =>
        typeof bind === 'string' &&
        bind
          .split(':')
          .slice(1)
          .some((part) => part.startsWith('/') && under(part)),
    ) || mounts.some((mount) => isObject(mount) && typeof mount.Target === 'string' && under(mount.Target))
  );
}

/**
 * The body of a create-container request, changed so the container sends its HTTP and HTTPS
 * traffic through Wirescry. The input is left untouched. A body Wirescry can't or shouldn't
 * change comes back as it was, labelled "skipped", with the reason.
 */
export function setUpContainer(input: unknown, options: SetUpOptions): SetUpResult {
  if (!isObject(input)) return { setUp: false, body: {}, reason: 'not a container definition' };
  const body: Json = structuredClone(input);
  const labels: Json = isObject(body.Labels) ? body.Labels : {};
  body.Labels = labels;
  const hostConfig: Json = isObject(body.HostConfig) ? body.HostConfig : {};
  const networkMode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : '';

  const skip = (reason: string): SetUpResult => {
    labels[LABELS.setup] = 'skipped';
    return { setUp: false, body, reason };
  };
  if (body.Env !== undefined && body.Env !== null && !Array.isArray(body.Env)) {
    return { setUp: false, body: skippedDefinition(input) as Json, reason: 'its environment is not a list' };
  }
  if (networkMode === 'none') return skip('it has no network');
  if (mountPointTaken(hostConfig)) return skip(`${MOUNT_POINT} is already in use`);

  // Environment: "KEY=value" entries. An entry without "=" is kept as it is.
  const entries = (Array.isArray(body.Env) ? body.Env : []).filter((e): e is string => typeof e === 'string');
  const imageEntries = (options.imageEnv ?? []).filter((e): e is string => typeof e === 'string');
  /** The value the container would have: the create request's, else the image's. */
  const valueOf = (key: string): string | undefined => {
    for (const list of [entries, imageEntries]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i]!;
        if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1);
        if (entry === key) return undefined; // Left out on purpose.
      }
    }
    return undefined;
  };
  const ours: Record<string, string> = containerEnv(options.proxyPort);
  // Only ones set for this container: images set these to their own copy of the public roots
  // (curlimages/curl sets CURL_CA_BUNDLE), which Wirescry's bundle includes.
  const setHere = (key: string): boolean =>
    entries.some((e) => e.startsWith(`${key}=`) && e.length > key.length + 1);
  for (const key of CA_VARIABLES) if (setHere(key)) delete ours[key];
  const phpDirs = valueOf('PHP_INI_SCAN_DIR');
  if (phpDirs) ours.PHP_INI_SCAN_DIR = `${phpDirs}:${inMount(CONTAINER_FILES.phpDir)}`;
  const directList = unique([
    ...noProxyEntries(valueOf('NO_PROXY')),
    ...noProxyEntries(valueOf('no_proxy')),
    ...ALWAYS_DIRECT,
    ...options.direct,
  ]);
  const direct = directList.join(',');
  ours.NO_PROXY = direct;
  ours.no_proxy = direct;
  // Java ignores NO_PROXY: give it the same names, or calls between containers go to the proxy.
  // The JVM takes the last of a repeated option, so names the container gives Java itself are
  // kept by merging them into Wirescry's.
  const javaOptions = valueOf('JAVA_TOOL_OPTIONS');
  const theirHosts = /(?:^|\s)-Dhttp\.nonProxyHosts=(\S+)/
    .exec(javaOptions ?? '')?.[1]
    ?.replace(/^["']|["']$/g, '');
  const javaHosts = [javaNonProxyHosts(directList), ...(theirHosts ? [theirHosts] : [])].join('|');
  ours.JAVA_TOOL_OPTIONS = `${ours.JAVA_TOOL_OPTIONS} -Dhttp.nonProxyHosts=${javaHosts}`;
  if (javaOptions?.trim()) ours.JAVA_TOOL_OPTIONS = `${javaOptions} ${ours.JAVA_TOOL_OPTIONS}`;
  const replaced = new Set(Object.keys(ours));
  body.Env = [
    ...entries.filter((entry) => {
      const key = entry.includes('=') ? entry.slice(0, entry.indexOf('=')) : entry;
      return !replaced.has(key);
    }),
    ...Object.entries(ours).map(([key, value]) => `${key}=${value}`),
  ];

  // The folder with the certificates, read-only. With SELinux, only a Binds entry can ask
  // Docker to relabel it (":z") so the container can read it.
  if (options.selinux) {
    const binds = Array.isArray(hostConfig.Binds) ? [...hostConfig.Binds] : [];
    binds.push(`${options.configDir}:${MOUNT_POINT}:ro,z`);
    hostConfig.Binds = binds;
  } else {
    const mounts = Array.isArray(hostConfig.Mounts) ? [...hostConfig.Mounts] : [];
    mounts.push({ Type: 'bind', Source: options.configDir, Target: MOUNT_POINT, ReadOnly: true });
    hostConfig.Mounts = mounts;
  }

  // host.docker.internal: Docker Desktop has it; plain Docker on Linux needs it added. A
  // container sharing another's network can't take host entries, and gets that one's.
  if (!networkMode.startsWith('container:')) {
    const extraHosts = Array.isArray(hostConfig.ExtraHosts) ? [...hostConfig.ExtraHosts] : [];
    const hasHost = extraHosts.some(
      (entry) => typeof entry === 'string' && entry.toLowerCase().split(/[:=]/)[0] === HOST_NAME,
    );
    if (!hasHost) extraHosts.push(`${HOST_NAME}:host-gateway`);
    hostConfig.ExtraHosts = extraHosts;
  }
  body.HostConfig = hostConfig;

  labels[LABELS.setup] = 'proxy';
  labels[LABELS.port] = String(options.proxyPort);
  const hash = labels[COMPOSE_HASH_LABEL];
  if (typeof hash === 'string') {
    labels[LABELS.composeHash] = hash;
    labels[COMPOSE_HASH_LABEL] = `${hash}${HASH_SUFFIX}`;
  }
  return { setUp: true, body };
}

/**
 * The labels to report for a container listed or inspected through Wirescry, so Compose
 * recreates what needs it and nothing else:
 * - set up for the current proxy port: Compose's own hash, so it isn't recreated;
 * - not set up: a changed hash, so it's recreated with the proxy settings;
 * - skipped, or set up for another port: as stored (another port's hash is already changed).
 * Returns the same object when nothing changes.
 */
export function labelsAsListed(labels: unknown, proxyPort: number): unknown {
  if (!isObject(labels)) return labels;
  const hash = labels[COMPOSE_HASH_LABEL];
  if (typeof hash !== 'string') return labels;
  const setup = labels[LABELS.setup];
  if (setup === 'skipped') return labels;
  if (setup === 'proxy') {
    const original = labels[LABELS.composeHash];
    if (labels[LABELS.port] === String(proxyPort) && typeof original === 'string') {
      return { ...labels, [COMPOSE_HASH_LABEL]: original };
    }
    return labels;
  }
  return { ...labels, [COMPOSE_HASH_LABEL]: `${hash}${HASH_SUFFIX}` };
}

/** Changes the labels in a container list or inspect response, as labelsAsListed says. */
export function rewriteListed(response: unknown, proxyPort: number): unknown {
  if (Array.isArray(response)) {
    let changed = false;
    const items = response.map((item) => {
      if (!isObject(item) || !isObject(item.Labels)) return item;
      const labels = labelsAsListed(item.Labels, proxyPort);
      if (labels === item.Labels) return item;
      changed = true;
      return { ...item, Labels: labels };
    });
    return changed ? items : response;
  }
  if (isObject(response) && isObject(response.Config) && isObject(response.Config.Labels)) {
    if (labelsAsListed(response.Config.Labels, proxyPort) === response.Config.Labels) return response;
    return {
      ...response,
      Config: { ...response.Config, Labels: labelsAsListed(response.Config.Labels, proxyPort) },
    };
  }
  return response;
}

/** A name a container might use as a host name. */
export function isHostName(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,252})$/.test(name);
}

/** Names of other containers this one can reach by name: its network aliases and links. */
export function namesInDefinition(input: unknown): string[] {
  if (!isObject(input)) return [];
  const names: string[] = [];
  const networking = isObject(input.NetworkingConfig) ? input.NetworkingConfig : {};
  const endpoints = isObject(networking.EndpointsConfig) ? networking.EndpointsConfig : {};
  for (const endpoint of Object.values(endpoints)) {
    if (!isObject(endpoint)) continue;
    for (const alias of Array.isArray(endpoint.Aliases) ? endpoint.Aliases : []) {
      if (typeof alias === 'string') names.push(alias);
    }
    for (const link of Array.isArray(endpoint.Links) ? endpoint.Links : []) {
      if (typeof link === 'string') names.push(...link.split(':'));
    }
  }
  const hostConfig = isObject(input.HostConfig) ? input.HostConfig : {};
  for (const link of Array.isArray(hostConfig.Links) ? hostConfig.Links : []) {
    // "/other:/this/alias"
    if (typeof link === 'string') names.push(...link.split(':').map((part) => part.split('/').pop() ?? ''));
  }
  return names.filter(isHostName);
}

/** User-defined networks the container joins: where other containers can be reached by name. */
export function userNetworks(input: unknown): string[] {
  if (!isObject(input)) return [];
  const networks = new Set<string>();
  const hostConfig = isObject(input.HostConfig) ? input.HostConfig : {};
  const mode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : '';
  const builtIn = (name: string): boolean =>
    ['', 'default', 'bridge', 'host', 'none', 'nat'].includes(name) || name.startsWith('container:');
  if (!builtIn(mode)) networks.add(mode);
  const networking = isObject(input.NetworkingConfig) ? input.NetworkingConfig : {};
  const endpoints = isObject(networking.EndpointsConfig) ? networking.EndpointsConfig : {};
  for (const name of Object.keys(endpoints)) if (!builtIn(name)) networks.add(name);
  return [...networks];
}
