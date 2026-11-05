import { readFileSync } from 'node:fs';
import { BlockList } from 'node:net';
import os from 'node:os';
import { BRIDGE_NAME } from './bridges';

/** Where ufw keeps whether it's on; readable by everyone, unlike its rules. */
export const UFW_CONF = '/etc/ufw/ufw.conf';

/** The range Docker's default address pools come from first; one ufw rule covers it. */
const DOCKER_POOL = { address: '172.16.0.0', prefix: 12 };

/** Whether ufw.conf turns ufw on (ENABLED=yes). */
export function ufwEnabled(conf: string | undefined): boolean {
  if (!conf) return false;
  return conf.split('\n').some((line) => /^\s*ENABLED\s*=\s*["']?yes["']?\s*(?:#.*)?$/i.test(line));
}

function readUfwConf(): string | undefined {
  try {
    return readFileSync(UFW_CONF, 'utf8');
  } catch {
    return undefined;
  }
}

/** An IPv4 address with its host bits cleared: 172.18.0.1 and 16 → 172.18.0.0. */
export function networkAddress(address: string, prefix: number): string {
  const value = address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const block = 2 ** (32 - prefix);
  const network = value - (value % block);
  return [24, 16, 8, 0].map((shift) => Math.floor(network / 2 ** shift) % 256).join('.');
}

/**
 * The address ranges a ufw rule must let reach the proxy: Docker's usual pool, and any
 * Docker bridge network on this machine outside it (Docker moves on to 192.168.0.0/16 once
 * it has many networks).
 */
export function rangesToAllow(interfaces: ReturnType<typeof os.networkInterfaces>): string[] {
  const pool = new BlockList();
  pool.addSubnet(DOCKER_POOL.address, DOCKER_POOL.prefix, 'ipv4');
  const ranges = [`${DOCKER_POOL.address}/${DOCKER_POOL.prefix}`];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!BRIDGE_NAME.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || !address.cidr) continue;
      const prefix = Number(address.cidr.split('/')[1]);
      if (!Number.isInteger(prefix) || prefix < 12 || prefix > 30) continue;
      if (pool.check(address.address, 'ipv4')) continue;
      const range = `${networkAddress(address.address, prefix)}/${prefix}`;
      if (!ranges.includes(range)) ranges.push(range);
    }
  }
  return ranges;
}

/** The commands that let Docker's networks reach the proxy through ufw. */
export function ufwAllowCommands(port: number, ranges: string[]): string[] {
  return ranges.map((range) => `sudo ufw allow from ${range} to any port ${port} proto tcp`);
}

export interface FirewallHint {
  /** The firewall that's on. */
  name: 'ufw';
  /** What lets containers reach the proxy through it. */
  commands: string[];
}

/**
 * A firewall on this computer that would block containers from reaching the proxy, with what
 * to run. Only ufw can be read without root; its rules can't, so this can't tell whether
 * they already allow Docker's networks, and the Setup page says so.
 */
export function firewallHint(
  port: number,
  read: () => string | undefined = readUfwConf,
  interfaces: () => ReturnType<typeof os.networkInterfaces> = os.networkInterfaces,
): FirewallHint | undefined {
  if (!ufwEnabled(read())) return undefined;
  let ranges: string[];
  try {
    ranges = rangesToAllow(interfaces());
  } catch {
    ranges = [`${DOCKER_POOL.address}/${DOCKER_POOL.prefix}`];
  }
  return { name: 'ufw', commands: ufwAllowCommands(port, ranges) };
}
