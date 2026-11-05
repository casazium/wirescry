import { BlockList, isIPv4 } from 'node:net';
import os from 'node:os';

/** Docker's default bridge and the bridges it makes for user-defined networks. */
export const BRIDGE_NAME = /^(?:docker\d+|br-[0-9a-f]{12})$/;
/**
 * How soon an address that isn't on a known bridge makes the interfaces be read again. Compose
 * creates a network moments before its containers connect, so a miss usually means a new
 * bridge; the limit keeps a flood of other connections from re-reading constantly.
 */
const MISS_REREAD_MS = 200;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** The IPv4 subnets of Docker's bridge networks on this machine. */
export function bridgeSubnets(interfaces: Interfaces): BlockList {
  const list = new BlockList();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!BRIDGE_NAME.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || !address.cidr) continue;
      const prefix = Number(address.cidr.split('/')[1]);
      // A bridge's subnet; anything as wide as a /8 isn't one Docker made.
      if (!Number.isInteger(prefix) || prefix < 12 || prefix > 30) continue;
      list.addSubnet(address.address, prefix, 'ipv4');
    }
  }
  return list;
}

/**
 * Whether a connection from this address comes from a container on one of Docker's bridge
 * networks. That's where containers' connections to the proxy come from with Docker on Linux;
 * Docker Desktop delivers them from 127.0.0.1.
 */
export function dockerBridgeChecker(
  read: () => Interfaces = os.networkInterfaces,
  now: () => number = Date.now,
): (address: string) => boolean {
  let list = new BlockList();
  let readAt = -Infinity;
  const reread = (): void => {
    try {
      list = bridgeSubnets(read());
    } catch {
      list = new BlockList();
    }
    readAt = now();
  };
  return (address: string): boolean => {
    const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (!isIPv4(v4)) return false;
    if (list.check(v4, 'ipv4')) return true;
    // Not on a bridge seen so far: a network may have been made since, so look again.
    if (now() - readAt < MISS_REREAD_MS) return false;
    reread();
    return list.check(v4, 'ipv4');
  };
}
