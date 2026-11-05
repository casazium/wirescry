import os from 'node:os';

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
  /** The host name of the machine the daemon runs on ("" if it didn't say). */
  name: string;
}

/** Reads the parts of GET /info (and GET /version, if given) that matter here. */
export function parseInfo(value: unknown, version?: unknown): DaemonInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const info = value as {
    OSType?: unknown;
    OperatingSystem?: unknown;
    SecurityOptions?: unknown;
    Name?: unknown;
  };
  const options = Array.isArray(info.SecurityOptions)
    ? info.SecurityOptions.filter((o): o is string => typeof o === 'string')
    : [];
  return {
    osType: typeof info.OSType === 'string' ? info.OSType.toLowerCase() : '',
    operatingSystem: typeof info.OperatingSystem === 'string' ? info.OperatingSystem : '',
    rootless: options.some((o) => /(^|,)name=rootless(,|$)/.test(o)),
    selinux: options.some((o) => /(^|,)name=selinux(,|$)/.test(o)),
    podman: isPodman(version),
    name: typeof info.Name === 'string' ? info.Name : '',
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
 *
 * On Linux, Docker Engine on this computer reports this computer's host name; colima, Lima
 * and Rancher Desktop run it in a VM, which reports its own ("colima", "lima-default",
 * "lima-rancher-desktop"). `hostname` is this computer's.
 */
export function unsupportedReason(
  info: DaemonInfo | undefined,
  platform: NodeJS.Platform,
  hostname: string = os.hostname(),
): string | undefined {
  // Unknown: Docker didn't say what it is in time. Guessing wrong would cut off the
  // container's HTTP, so it's left alone.
  if (!info) return 'Docker didn’t say what kind of Docker it is, so this container was left as it is.';
  if (info.osType === 'windows') return 'Wirescry doesn’t set up Windows containers.';
  if (info.rootless) return 'Wirescry doesn’t set up rootless Docker yet.';
  if (info.podman) return 'Wirescry doesn’t set up Podman yet.';
  if (/docker desktop/i.test(info.operatingSystem)) return undefined;
  if (platform === 'linux' && info.osType === 'linux') {
    // A daemon that doesn't name its machine (Docker always does) is taken at its word.
    if (!info.name || !hostname || info.name.toLowerCase() === hostname.toLowerCase()) return undefined;
    return `Wirescry sets up Docker running on this computer, but not Docker in a virtual machine (${info.name}) yet.`;
  }
  const name = info.operatingSystem || 'this Docker';
  return `Wirescry sets up Docker Desktop, and Docker on Linux, but not ${name} yet.`;
}
