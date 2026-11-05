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
    return { setUp: false, body: input, reason: 'its environment is not a list' };
  }
  if (networkMode === 'none') return skip('it has no network');
  if (mountPointTaken(hostConfig)) return skip(`${MOUNT_POINT} is already in use`);

  // Environment: "KEY=value" entries. An entry without "=" is kept as it is.
  const entries = (Array.isArray(body.Env) ? body.Env : []).filter((e): e is string => typeof e === 'string');
  const valueOf = (key: string): string | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1);
    }
    return undefined;
  };
  const ours = containerEnv(options.proxyPort);
  const javaOptions = valueOf('JAVA_TOOL_OPTIONS');
  if (javaOptions?.trim()) ours.JAVA_TOOL_OPTIONS = `${javaOptions} ${ours.JAVA_TOOL_OPTIONS}`;
  const phpDirs = valueOf('PHP_INI_SCAN_DIR');
  if (phpDirs) ours.PHP_INI_SCAN_DIR = `${phpDirs}:${inMount(CONTAINER_FILES.phpDir)}`;
  const direct = unique([
    ...noProxyEntries(valueOf('NO_PROXY')),
    ...noProxyEntries(valueOf('no_proxy')),
    ...ALWAYS_DIRECT,
    ...options.direct,
  ]).join(',');
  ours.NO_PROXY = direct;
  ours.no_proxy = direct;
  const replaced = new Set(Object.keys(ours));
  body.Env = [
    ...entries.filter((entry) => {
      const key = entry.includes('=') ? entry.slice(0, entry.indexOf('=')) : entry;
      return !replaced.has(key);
    }),
    ...Object.entries(ours).map(([key, value]) => `${key}=${value}`),
  ];

  // The folder with the certificates, read-only.
  const mounts = Array.isArray(hostConfig.Mounts) ? [...hostConfig.Mounts] : [];
  mounts.push({ Type: 'bind', Source: options.configDir, Target: MOUNT_POINT, ReadOnly: true });
  hostConfig.Mounts = mounts;

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
    return response.map((item) =>
      isObject(item) && isObject(item.Labels)
        ? { ...item, Labels: labelsAsListed(item.Labels, proxyPort) }
        : item,
    );
  }
  if (isObject(response) && isObject(response.Config) && isObject(response.Config.Labels)) {
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
