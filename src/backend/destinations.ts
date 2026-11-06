import net from 'node:net';
import os from 'node:os';

/**
 * Which addresses a device may reach through Wirescry. A device's apps can use its listener to
 * reach anything the computer can, so by default they're kept from what only the computer can
 * reach: its own services, its local networks and VPNs, and cloud metadata addresses.
 */

/** Why an address is refused. */
export type RefusedKind = 'this-computer' | 'local-network' | 'link-local' | 'special';

export interface Refusal {
  kind: RefusedKind;
  /** Plain words, e.g. "a private network address". */
  description: string;
}

const DESCRIPTIONS: Record<RefusedKind, string> = {
  'this-computer': 'this computer',
  'local-network': 'a private network address',
  'link-local': 'a link-local address',
  special: 'a special-purpose address',
};

const refuse = (kind: RefusedKind): Refusal => ({ kind, description: DESCRIPTIONS[kind] });

/** IPv4 ranges refused, as [first address, prefix length, kind]. */
const IPV4_RANGES: Array<[string, number, RefusedKind]> = [
  ['0.0.0.0', 8, 'this-computer'], // "this network": 0.0.0.0 reaches localhost on macOS and Linux
  ['127.0.0.0', 8, 'this-computer'],
  ['10.0.0.0', 8, 'local-network'],
  ['172.16.0.0', 12, 'local-network'],
  ['192.168.0.0', 16, 'local-network'],
  ['100.64.0.0', 10, 'local-network'], // carrier-grade NAT, and VPNs such as Tailscale
  ['169.254.0.0', 16, 'link-local'], // includes cloud metadata, 169.254.169.254
  ['198.18.0.0', 15, 'local-network'], // benchmarking; fake-IP VPN clients use it
  ['224.0.0.0', 4, 'special'], // multicast
  ['240.0.0.0', 4, 'special'], // reserved, and broadcast
  ['192.0.0.0', 24, 'special'], // IETF protocol assignments, e.g. NAT64 discovery
];

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  const start = ipv4ToNumber(base);
  return value >= start && value < start + size;
}

/** The 16 bytes of an IPv6 address (without a zone), or undefined if it isn't one. */
export function ipv6Bytes(address: string): Uint8Array | undefined {
  if (!net.isIPv6(address)) return undefined;
  let text = address.split('%')[0]!;
  const bytes = new Uint8Array(16);
  // A dotted IPv4 tail (::ffff:1.2.3.4) is the last four bytes.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tailBytes: number[] = [];
  if (tail) {
    tailBytes = tail[1]!.split('.').map(Number);
    text = text.slice(0, -tail[1]!.length) + '0:0';
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const groups = (s: string | undefined): number[] => (s ? s.split(':').map((g) => parseInt(g, 16)) : []);
  const front = groups(head);
  const back = groups(rest);
  const all =
    rest === undefined ? front : [...front, ...new Array(8 - front.length - back.length).fill(0), ...back];
  if (all.length !== 8) return undefined;
  all.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  if (tail) bytes.set(tailBytes, 12);
  return bytes;
}

const ipv4At = (bytes: Uint8Array, at: number): string => [...bytes.subarray(at, at + 4)].join('.');

const startsWith = (bytes: Uint8Array, prefix: number[]): boolean => prefix.every((b, i) => bytes[i] === b);

/** Whether two addresses are the same, ignoring how they're written (and IPv6 zones). */
function sameAddress(a: string, b: string): boolean {
  if (net.isIPv4(a) && net.isIPv4(b)) return a === b;
  const x = ipv6Bytes(a);
  const y = ipv6Bytes(b);
  return !!x && !!y && x.every((byte, i) => byte === y[i]);
}

/** This computer's own addresses, read fresh: they change as networks and VPNs come and go. */
export function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .flatMap((i) => (i ? [i.cidr ?? i.address] : []));
}

/** Whether `address` is in `cidr` ("10.1.2.3/24", "2001:db8::5/64"). */
function inSubnet(address: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const prefix = Number(bits);
  // A default route's "subnet" is everything: never treat that as a local network.
  if (!base || !Number.isInteger(prefix) || prefix <= 0) return false;
  if (net.isIPv4(base) && net.isIPv4(address)) {
    const size = 2 ** (32 - Math.min(prefix, 32));
    return Math.floor(ipv4ToNumber(address) / size) === Math.floor(ipv4ToNumber(base) / size);
  }
  const a = ipv6Bytes(address);
  const b = ipv6Bytes(base);
  if (!a || !b) return false;
  for (let bit = 0; bit < Math.min(prefix, 128); bit++) {
    const mask = 0x80 >> (bit % 8);
    if ((a[bit >> 3]! & mask) !== (b[bit >> 3]! & mask)) return false;
  }
  return true;
}

/** Refuses this computer's own addresses, and others on its networks (even public ones). */
function ownRefusal(address: string, own: readonly string[]): Refusal | undefined {
  if (own.some((o) => sameAddress(o.split('/')[0]!, address))) return refuse('this-computer');
  return own.some((o) => inSubnet(address, o)) ? refuse('local-network') : undefined;
}

/**
 * Why a device may not reach this address, or undefined if it may. Anything that isn't an IP
 * address is refused. `own` is this computer's own addresses, as CIDRs ("192.168.1.5/24") or
 * bare: an address in one of its subnets is on its local network.
 */
export function refusedAddress(
  address: string,
  own: readonly string[] = ownAddresses(),
): Refusal | undefined {
  if (net.isIPv4(address)) {
    const mine = ownRefusal(address, own);
    if (mine) return mine;
    const value = ipv4ToNumber(address);
    const range = IPV4_RANGES.find(([base, prefix]) => inIpv4Range(value, base, prefix));
    return range ? refuse(range[2]) : undefined;
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) return refuse('special');
  // IPv4-mapped (::ffff:a.b.c.d) and the old IPv4-compatible form (::a.b.c.d): checked as IPv4.
  if (
    startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]) ||
    startsWith(bytes, new Array(12).fill(0))
  ) {
    const v4 = ipv4At(bytes, 12);
    // :: and ::1 themselves.
    if (v4 === '0.0.0.0' || v4 === '0.0.0.1') return refuse('this-computer');
    return refusedAddress(v4, own);
  }
  const mine = ownRefusal(address, own);
  if (mine) return mine;
  if ((bytes[0]! & 0xfe) === 0xfc) return refuse('local-network'); // fc00::/7, unique local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return refuse('link-local'); // fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return refuse('local-network'); // fec0::/10, old site-local
  if (bytes[0] === 0xff) return refuse('special'); // multicast
  // Addresses with an IPv4 address inside: refused if that one is.
  const embedded: string[] = [];
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) embedded.push(ipv4At(bytes, 12)); // NAT64
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 1])) return refuse('local-network'); // local-use NAT64
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0])) embedded.push(ipv4At(bytes, 12)); // IPv4-translated
  if (startsWith(bytes, [1, 0, 0, 0, 0, 0, 0, 0])) return refuse('special'); // discard-only 100::/64
  if (startsWith(bytes, [0x20, 0x02])) embedded.push(ipv4At(bytes, 2)); // 6to4
  if (startsWith(bytes, [0x20, 0x01, 0, 0])) {
    // Teredo: the server's address, and the client's with every bit flipped.
    embedded.push(
      ipv4At(bytes, 4),
      ipv4At(
        bytes.map((b) => b ^ 0xff),
        12,
      ),
    );
  }
  for (const v4 of embedded) {
    const refusal = refusedAddress(v4, own);
    if (refusal) return refusal;
  }
  return undefined;
}
