/** Which addresses a device may reach through Wirescry: every range the design refuses, and its edges. */
import { describe, expect, it } from 'vitest';
import { ipv6Bytes, ownAddresses, refusedAddress } from '../src/backend/destinations';

// Own addresses for these tests: documentation addresses, which are otherwise allowed.
const OWN = ['192.0.2.10', '2001:db8::5', 'fe80::1234%en0'];
const kind = (address: string) => refusedAddress(address, OWN)?.kind;

describe('Destinations a device may not reach', () => {
  it.each([
    // This computer
    ['127.0.0.1', 'this-computer'],
    ['127.255.255.254', 'this-computer'],
    ['0.0.0.0', 'this-computer'],
    ['0.1.2.3', 'this-computer'],
    ['::1', 'this-computer'],
    ['::', 'this-computer'],
    ['0:0:0:0:0:0:0:1', 'this-computer'],
    ['192.0.2.10', 'this-computer'],
    ['2001:db8::5', 'this-computer'],
    ['2001:0db8:0000::0005', 'this-computer'],
    ['::ffff:192.0.2.10', 'this-computer'],
    // Local networks
    ['10.0.0.1', 'local-network'],
    ['10.255.255.255', 'local-network'],
    ['172.16.0.1', 'local-network'],
    ['172.31.255.255', 'local-network'],
    ['192.168.1.1', 'local-network'],
    ['100.64.0.1', 'local-network'],
    ['100.127.255.255', 'local-network'],
    ['198.18.0.1', 'local-network'],
    ['198.19.255.255', 'local-network'],
    ['fc00::1', 'local-network'],
    ['fd12:3456:789a::1', 'local-network'],
    ['fec0::1', 'local-network'],
    // Link-local, including cloud metadata
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['febf::1', 'link-local'],
    // Special
    ['224.0.0.1', 'special'],
    ['239.255.255.250', 'special'],
    ['240.0.0.1', 'special'],
    ['255.255.255.255', 'special'],
    ['ff02::1', 'special'],
  ])('refuses %s (%s)', (address, expected) => {
    expect(kind(address)).toBe(expected);
  });

  it.each([
    // IPv4-mapped, in both spellings
    ['::ffff:127.0.0.1', 'this-computer'],
    ['::ffff:7f00:1', 'this-computer'],
    ['::FFFF:10.0.0.1', 'local-network'],
    ['::ffff:169.254.169.254', 'link-local'],
    // The old IPv4-compatible form
    ['::127.0.0.1', 'this-computer'],
    ['::10.1.2.3', 'local-network'],
    // NAT64, with a refused address inside; and the local-use NAT64 prefix
    ['64:ff9b::7f00:1', 'this-computer'],
    ['64:ff9b::10.0.0.1', 'local-network'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['64:ff9b:1::808:808', 'local-network'],
    // 6to4
    ['2002:7f00:1::1', 'this-computer'],
    ['2002:c0a8:101::1', 'local-network'],
    // Teredo: a refused server address, or a refused client address (stored bit-flipped)
    ['2001:0:a00:1::1', 'local-network'],
    ['2001:0:4136:e378:8000:63bf:80ff:fffe', 'this-computer'],
  ])('refuses %s, which has a refused address inside (%s)', (address, expected) => {
    expect(kind(address)).toBe(expected);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '11.0.0.0',
    '9.255.255.255',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '169.253.255.255',
    '169.255.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '1.0.0.0',
    '2606:4700:4700::1111',
    '2a00:1450:4009:81f::200e',
    '::ffff:8.8.8.8',
    '::8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
    '2001:0:4136:e378:8000:63bf:f7f7:f7f7',
    'fbff::1',
    'fe7f::1',
    '2001:db8::6',
  ])('allows %s', (address) => {
    expect(refusedAddress(address, OWN)).toBeUndefined();
  });

  it.each([
    '',
    'example.com',
    '1.2.3',
    '1.2.3.256',
    '01.2.3.4',
    ':::',
    '1::2::3',
    '::ffff:1.2.3',
    'fe80::1%',
  ])('refuses %j, which is not an IP address', (address) => {
    expect(kind(address)).toBe('special');
  });

  it.each([
    ['192.0.0.170', 'special'],
    ['::ffff:0:7f00:1', 'this-computer'],
    ['::ffff:0:a00:1', 'local-network'],
    ['100::1', 'special'],
  ])('refuses %s, a range the first review missed (%s)', (address, expected) => {
    expect(kind(address)).toBe(expected);
  });

  it("refuses the rest of this computer's subnets, even public ones, and nothing past them", () => {
    const own = ['127.0.0.1/8', '198.51.100.10/24', '2001:db8:1::5/64', '203.0.113.9/0', '2001:db8:9::1/128'];
    expect(refusedAddress('198.51.100.10', own)?.kind).toBe('this-computer');
    expect(refusedAddress('198.51.100.200', own)?.kind).toBe('local-network');
    expect(refusedAddress('198.51.101.1', own)).toBeUndefined();
    expect(refusedAddress('2001:db8:1::5', own)?.kind).toBe('this-computer');
    expect(refusedAddress('2001:db8:1::abcd', own)?.kind).toBe('local-network');
    expect(refusedAddress('2001:db8:2::1', own)).toBeUndefined();
    expect(refusedAddress('::ffff:198.51.100.200', own)?.kind).toBe('local-network');
    // A default route isn't a local network; its own address still is this computer.
    expect(refusedAddress('8.8.8.8', own)).toBeUndefined();
    expect(refusedAddress('203.0.113.9', own)?.kind).toBe('this-computer');
    expect(refusedAddress('2001:db8:9::2', own)).toBeUndefined();
  });

  it("treats this computer's IPv6 addresses the same however they're written, zone or not", () => {
    expect(kind('fe80::1234')).toBe('this-computer');
    expect(kind('fe80:0:0:0:0:0:0:1234%lo0')).toBe('this-computer');
  });

  it('describes each refusal in plain words', () => {
    expect(refusedAddress('10.0.0.1', OWN)?.description).toBe('a private network address');
    expect(refusedAddress('127.0.0.1', OWN)?.description).toBe('this computer');
    expect(refusedAddress('169.254.169.254', OWN)?.description).toBe('a link-local address');
  });

  it("reads this computer's addresses fresh, and refuses them by default", () => {
    const own = ownAddresses();
    expect(own).toContain('127.0.0.1/8');
    for (const address of own) expect(refusedAddress(address)).toBeDefined();
  });

  it('parses IPv6 addresses into bytes', () => {
    expect([...ipv6Bytes('::1')!]).toEqual([...new Array(15).fill(0), 1]);
    expect([...ipv6Bytes('::ffff:1.2.3.4')!].slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect([...ipv6Bytes('2001:db8::')!].slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(ipv6Bytes('1.2.3.4')).toBeUndefined();
  });
});
