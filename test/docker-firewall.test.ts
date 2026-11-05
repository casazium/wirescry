import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  firewallHint,
  networkAddress,
  rangesToAllow,
  ufwAllowCommands,
  ufwEnabled,
} from '../src/backend/docker/firewall';
import { DockerSetup } from '../src/backend/docker/setup';

type Interfaces = ReturnType<typeof os.networkInterfaces>;
const v4 = (address: string, prefix: number) =>
  ({ address, cidr: `${address}/${prefix}`, family: 'IPv4', netmask: '', mac: '', internal: false }) as const;

const ubuntuConf = `# /etc/ufw/ufw.conf
#

# Set to yes to start on boot. If setting this remotely, be sure to add a rule
# to allow your remote connection before starting ufw. Eg: 'ufw allow 22/tcp'
ENABLED=yes

# Please use the 'ufw' command to set the loglevel. Eg: 'ufw logging medium'.
LOGLEVEL=low
`;

describe('ufw', () => {
  it('is on when ufw.conf says ENABLED=yes, however it is written', () => {
    expect(ufwEnabled(ubuntuConf)).toBe(true);
    expect(ufwEnabled('ENABLED="yes"')).toBe(true);
    expect(ufwEnabled("  enabled = 'YES'  # on")).toBe(true);
  });
  it('is off when ufw.conf says no, only mentions it in a comment, or is missing', () => {
    expect(ufwEnabled(ubuntuConf.replace('ENABLED=yes', 'ENABLED=no'))).toBe(false);
    expect(ufwEnabled('# ENABLED=yes\nENABLED=no')).toBe(false);
    expect(ufwEnabled('ENABLED=yesterday')).toBe(false);
    expect(ufwEnabled('')).toBe(false);
    expect(ufwEnabled(undefined)).toBe(false);
  });
});

describe('Which networks the rule lets in', () => {
  it('clears host bits', () => {
    expect(networkAddress('172.18.0.1', 16)).toBe('172.18.0.0');
    expect(networkAddress('192.168.144.1', 20)).toBe('192.168.144.0');
    expect(networkAddress('10.1.2.3', 24)).toBe('10.1.2.0');
  });
  it("covers Docker's usual pool with one range", () => {
    const interfaces: Interfaces = {
      lo: [v4('127.0.0.1', 8)],
      docker0: [v4('172.17.0.1', 16)],
      'br-0123456789ab': [v4('172.18.0.1', 16)],
    };
    expect(rangesToAllow(interfaces)).toEqual(['172.16.0.0/12']);
    expect(rangesToAllow({})).toEqual(['172.16.0.0/12']);
  });
  it("adds Docker networks outside the pool, once each, and nothing that isn't Docker's", () => {
    const interfaces: Interfaces = {
      eth0: [v4('192.168.1.50', 24)],
      wlan0: [v4('10.0.0.8', 24)],
      'br-0123456789ab': [v4('192.168.144.1', 20)],
      'br-ba9876543210': [v4('192.168.144.1', 20)],
      docker0: [{ ...v4('172.17.0.1', 16) }, { ...v4('fe80::1', 64), family: 'IPv6' }] as Interfaces[string],
    };
    expect(rangesToAllow(interfaces)).toEqual(['172.16.0.0/12', '192.168.144.0/20']);
  });
  it('makes one ufw command per range, for the port', () => {
    expect(ufwAllowCommands(8001, ['172.16.0.0/12', '192.168.144.0/20'])).toEqual([
      'sudo ufw allow from 172.16.0.0/12 to any port 8001 proto tcp',
      'sudo ufw allow from 192.168.144.0/20 to any port 8001 proto tcp',
    ]);
  });
  it('says nothing when ufw is off or not installed', () => {
    expect(firewallHint(8000, () => undefined)).toBeUndefined();
    expect(firewallHint(8000, () => 'ENABLED=no')).toBeUndefined();
  });
  it("gives the commands when ufw is on, even if the interfaces can't be read", () => {
    expect(
      firewallHint(
        8000,
        () => ubuntuConf,
        () => ({}),
      ),
    ).toEqual({
      name: 'ufw',
      commands: ['sudo ufw allow from 172.16.0.0/12 to any port 8000 proto tcp'],
    });
    const broken = () => {
      throw new Error('no');
    };
    expect(firewallHint(8000, () => ubuntuConf, broken)?.commands).toHaveLength(1);
  });
});

/** Docker setup that found Docker at `socketPath`, with a relay running. */
function readySetup(
  platform: NodeJS.Platform,
  socketPath: string,
  conf: string | undefined,
  port = { value: 8000 },
) {
  const setup = new DockerSetup({
    dataDir: os.tmpdir(),
    enabled: true,
    proxyPort: () => port.value,
    containerDir: () => os.tmpdir(),
    platform,
    readUfwConf: () => conf,
    networkInterfaces: () => ({ docker0: [v4('172.17.0.1', 16)] }),
  });
  Object.assign(setup as unknown as Record<string, unknown>, {
    endpoint: { kind: 'local', socketPath, host: `unix://${socketPath}` },
    relay: {},
  });
  return setup;
}

describe('The Setup page’s firewall note', () => {
  it('appears for Docker Engine on Linux with ufw on, with the current port', () => {
    const port = { value: 8000 };
    const setup = readySetup('linux', '/var/run/docker.sock', ubuntuConf, port);
    expect(setup.status()).toMatchObject({
      state: 'ready',
      firewall: { name: 'ufw', commands: ['sudo ufw allow from 172.16.0.0/12 to any port 8000 proto tcp'] },
    });
    port.value = 8123;
    expect(setup.status().firewall?.commands[0]).toContain('port 8123');
  });
  it("doesn't appear with ufw off, for Docker Desktop, off Linux, or when setup is off", () => {
    expect(readySetup('linux', '/var/run/docker.sock', 'ENABLED=no').status().firewall).toBeUndefined();
    expect(readySetup('linux', '/var/run/docker.sock', undefined).status().firewall).toBeUndefined();
    expect(
      readySetup('linux', '/home/me/.docker/desktop/docker.sock', ubuntuConf).status().firewall,
    ).toBeUndefined();
    expect(readySetup('darwin', '/var/run/docker.sock', ubuntuConf).status().firewall).toBeUndefined();
    const off = readySetup('linux', '/var/run/docker.sock', ubuntuConf);
    off.setActive(false);
    expect(off.status()).toEqual({ state: 'off', daemon: 'unix:///var/run/docker.sock' });
  });
});
