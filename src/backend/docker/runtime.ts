/** What Wirescry needs to know about a Docker daemon, from its /info reply. */
export interface DaemonInfo {
  /** "linux" or "windows": the kind of containers it runs. */
  osType: string;
  /** E.g. "Docker Desktop", "Ubuntu 24.04.3 LTS", "OrbStack". */
  operatingSystem: string;
  rootless: boolean;
  selinux: boolean;
  /** Podman's Docker-compatible API, which names itself in GET /version. */
  podman: boolean;
}

/** Reads the parts of GET /info (and GET /version, if given) that matter here. */
export function parseInfo(value: unknown, version?: unknown): DaemonInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const info = value as { OSType?: unknown; OperatingSystem?: unknown; SecurityOptions?: unknown };
  const options = Array.isArray(info.SecurityOptions)
    ? info.SecurityOptions.filter((o): o is string => typeof o === 'string')
    : [];
  return {
    osType: typeof info.OSType === 'string' ? info.OSType.toLowerCase() : '',
    operatingSystem: typeof info.OperatingSystem === 'string' ? info.OperatingSystem : '',
    rootless: options.some((o) => /(^|,)name=rootless(,|$)/.test(o)),
    selinux: options.some((o) => /(^|,)name=selinux(,|$)/.test(o)),
    podman: isPodman(version),
  };
}

function isPodman(version: unknown): boolean {
  if (typeof version !== 'object' || version === null) return false;
  const components = (version as { Components?: unknown }).Components;
  return (
    Array.isArray(components) &&
    components.some(
      (c) =>
        typeof (c as { Name?: unknown })?.Name === 'string' && /podman/i.test((c as { Name: string }).Name),
    )
  );
}

/**
 * Why Wirescry leaves this daemon's containers as they are, or undefined to set them up.
 * Only setups where a container reaching host.docker.internal is known to reach Wirescry's
 * proxy are set up: Docker Desktop, and rootful Docker on Linux. Elsewhere (colima, Lima,
 * Rancher Desktop, rootless Docker, Podman) the name leads somewhere else, and setting the
 * container up would cut off all its HTTP.
 */
export function unsupportedReason(
  info: DaemonInfo | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  // Unknown: Docker answered nothing useful. The create will most likely fail on its own.
  if (!info) return undefined;
  if (info.osType === 'windows') return 'Wirescry doesn’t set up Windows containers.';
  if (info.rootless) return 'Wirescry doesn’t set up rootless Docker yet.';
  if (info.podman) return 'Wirescry doesn’t set up Podman yet.';
  if (/docker desktop/i.test(info.operatingSystem)) return undefined;
  if (platform === 'linux' && info.osType === 'linux') return undefined;
  const name = info.operatingSystem || 'this Docker';
  return `Wirescry sets up Docker Desktop, and Docker on Linux, but not ${name} yet.`;
}
