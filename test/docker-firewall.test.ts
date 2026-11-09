import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  firewallHint,
  networkAddress,
  rangesToAllow,
  ufwAcceptsIncoming,
  ufwAllowCommands,
  ufwEnabled,
} from '../src/backend/docker/firewall';
import { DockerSetup, NO_PIPE_HELPER, WINDOWS_NOT_YET } from '../src/backend/docker/setup';

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
    expect(ufwEnabled('LOGLEVEL=low\r\nENABLED=yes\r\n')).toBe(true);
  });
  it('is off when ufw.conf says no, only mentions it in a comment, or is missing', () => {
    expect(ufwEnabled(ubuntuConf.replace('ENABLED=yes', 'ENABLED=no'))).toBe(false);
    expect(ufwEnabled('# ENABLED=yes\nENABLED=no')).toBe(false);
    expect(ufwEnabled('ENABLED=yesterday')).toBe(false);
    expect(ufwEnabled('')).toBe(false);
    expect(ufwEnabled(undefined)).toBe(false);
  });
  it('lets every incoming connection in only when its default input policy says ACCEPT', () => {
    expect(ufwAcceptsIncoming('DEFAULT_INPUT_POLICY="ACCEPT"')).toBe(true);
    expect(ufwAcceptsIncoming('DEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"')).toBe(false);
    expect(ufwAcceptsIncoming('#DEFAULT_INPUT_POLICY="ACCEPT"')).toBe(false);
    expect(ufwAcceptsIncoming(undefined)).toBe(false);
  });
});

describe('Which networks the rule lets in', () => {
  it('clears host bits', () => {
    expect(networkAddress('172.18.0.1', 16)).toBe('172.18.0.0');
    expect(networkAddress('192.168.144.1', 20)).toBe('192.168.144.0');
    expect(networkAddress('172.31.5.9', 12)).toBe('172.16.0.0');
    expect(networkAddress('10.255.255.255', 8)).toBe('10.0.0.0');
    expect(networkAddress('192.168.1.7', 32)).toBe('192.168.1.7');
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
      // A large custom pool.
      docker1: [v4('10.10.0.1', 8)],
      docker0: [v4('172.17.0.1', 16), { ...v4('fe80::1', 64), family: 'IPv6' }] as Interfaces[string],
    };
    expect(rangesToAllow(interfaces)).toEqual(['172.16.0.0/12', '192.168.144.0/20', '10.0.0.0/8']);
  });
  it('makes one ufw command per range, for the port', () => {
    expect(ufwAllowCommands(8001, ['172.16.0.0/12', '192.168.144.0/20'])).toEqual([
      'sudo ufw allow from 172.16.0.0/12 to any port 8001 proto tcp',
      'sudo ufw allow from 192.168.144.0/20 to any port 8001 proto tcp',
    ]);
  });
});

describe('The firewall hint', () => {
  it('says nothing when ufw is off, not installed, or lets everything in', () => {
    expect(firewallHint(8000, () => ({}))).toBeUndefined();
    expect(firewallHint(8000, () => ({ conf: 'ENABLED=no' }))).toBeUndefined();
    expect(
      firewallHint(8000, () => ({ conf: ubuntuConf, defaults: 'DEFAULT_INPUT_POLICY="ACCEPT"' })),
    ).toBeUndefined();
  });
  it("gives the commands when ufw is on, even if the interfaces can't be read", () => {
    const on = () => ({ conf: ubuntuConf, defaults: 'DEFAULT_INPUT_POLICY="DROP"' });
    expect(firewallHint(8000, on, () => ({}))).toEqual({
      name: 'ufw',
      commands: ['sudo ufw allow from 172.16.0.0/12 to any port 8000 proto tcp'],
    });
    const broken = () => {
      throw new Error('no');
    };
    expect(firewallHint(8000, on, broken)?.commands).toHaveLength(1);
  });
});

const engine = {
  osType: 'linux',
  operatingSystem: 'Ubuntu 26.04 LTS',
  rootless: false,
  selinux: false,
  podman: false,
  name: 'vm',
};

/** Docker setup that found Docker at `socketPath`, with a relay running and the daemon's info. */
function readySetup(
  platform: NodeJS.Platform,
  socketPath: string,
  conf: string | undefined,
  options: { port?: { value: number }; daemon?: object } = {},
) {
  const port = options.port ?? { value: 8000 };
  // `daemon: undefined` means Docker said nothing, so only a missing key gets the default.
  const daemon = 'daemon' in options ? options.daemon : engine;
  const setup = new DockerSetup({
    dataDir: os.tmpdir(),
    enabled: true,
    proxyPort: () => port.value,
    containerDir: () => os.tmpdir(),
    platform,
    readUfw: () => ({ conf }),
    networkInterfaces: () => ({ docker0: [v4('172.17.0.1', 16)] }),
  });
  Object.assign(setup as unknown as Record<string, unknown>, {
    endpoint: { kind: 'local', socketPath, host: `unix://${socketPath}` },
    relay: { problem: () => undefined },
    daemon,
  });
  return setup;
}

describe('The Setup page’s firewall note', () => {
  it('appears for Docker Engine on Linux with ufw on, with the current port', () => {
    const port = { value: 8000 };
    const setup = readySetup('linux', '/var/run/docker.sock', ubuntuConf, { port });
    expect(setup.status()).toMatchObject({
      state: 'ready',
      firewall: { name: 'ufw', commands: ['sudo ufw allow from 172.16.0.0/12 to any port 8000 proto tcp'] },
    });
    port.value = 8123;
    expect(setup.status().firewall?.commands[0]).toContain('port 8123');
  });
  it("doesn't announce a change when there was no note to remove", () => {
    const setup = readySetup('linux', '/var/run/docker.sock', 'ENABLED=no');
    let changes = 0;
    (setup as unknown as { options: { onStatusChange: () => void } }).options.onStatusChange = () =>
      changes++;
    Object.assign(setup as unknown as Record<string, unknown>, {
      fromBridge: () => true,
      isSetUpContainer: async () => false,
    });
    void setup.acceptsConnection('172.17.0.9');
    expect(changes).toBe(0);
  });
  it("doesn't appear with ufw off, for Docker Desktop, unknown Docker, off Linux, or with setup off", () => {
    const sock = '/var/run/docker.sock';
    expect(readySetup('linux', sock, 'ENABLED=no').status().firewall).toBeUndefined();
    expect(readySetup('linux', sock, undefined).status().firewall).toBeUndefined();
    expect(
      readySetup('linux', '/home/me/.docker/desktop/docker.sock', ubuntuConf).status().firewall,
    ).toBeUndefined();
    // Docker Desktop as it describes itself, whatever its socket's path.
    const desktop = { ...engine, operatingSystem: 'Docker Desktop' };
    expect(readySetup('linux', sock, ubuntuConf, { daemon: desktop }).status().firewall).toBeUndefined();
    // Docker wasn't running at the last look: unknown, so nothing said.
    expect(readySetup('linux', sock, ubuntuConf, { daemon: undefined }).status().firewall).toBeUndefined();
    expect(readySetup('darwin', sock, ubuntuConf).status().firewall).toBeUndefined();
    const off = readySetup('linux', sock, ubuntuConf);
    off.setActive(false);
    expect(off.status()).toEqual({ state: 'off', daemon: 'unix:///var/run/docker.sock' });
  });
  it("goes away once a container's connection gets through, saying so once", () => {
    const setup = readySetup('linux', '/var/run/docker.sock', ubuntuConf);
    let changes = 0;
    (setup as unknown as { options: { onStatusChange: () => void } }).options.onStatusChange = () =>
      changes++;
    Object.assign(setup as unknown as Record<string, unknown>, {
      fromBridge: (address: string) => address.startsWith('172.17.'),
      isSetUpContainer: async () => false,
    });
    // A connection from elsewhere proves nothing.
    void setup.acceptsConnection('192.168.1.50');
    expect(setup.status().firewall).toBeDefined();
    expect(changes).toBe(0);
    void setup.acceptsConnection('172.17.0.9');
    expect(setup.status().firewall).toBeUndefined();
    expect(changes).toBe(1);
    // Later containers change nothing.
    void setup.acceptsConnection('172.17.0.10');
    expect(changes).toBe(1);
  });
});

describe('Docker setup on Windows', () => {
  const desktop = async () =>
    ({
      kind: 'local',
      socketPath: '\\\\.\\pipe\\dockerDesktopLinuxEngine',
      host: 'npipe:////./pipe/dockerDesktopLinuxEngine',
    }) as const;

  it('is off by default, until tested with Docker Desktop: no relay, nothing for terminals', async () => {
    const setup = new DockerSetup({
      dataDir: os.tmpdir(),
      enabled: true,
      proxyPort: () => 8000,
      containerDir: () => os.tmpdir(),
      platform: 'win32',
      findEndpoint: desktop,
    });
    await setup.refresh();
    expect(setup.status()).toEqual({
      state: 'unsupported',
      daemon: 'npipe:////./pipe/dockerDesktopLinuxEngine',
      error: WINDOWS_NOT_YET,
      windowsNotYet: true,
    });
    expect(setup.terminalEnv()).toEqual({});
    expect((setup as unknown as { relay?: unknown }).relay).toBeUndefined();
    expect(setup.acceptsConnection('172.17.0.2')).toBe(false);
    await setup.stop();
  });

  it('while off, still says when there is no Docker, or it is remote', async () => {
    const make = (findEndpoint: ConstructorParameters<typeof DockerSetup>[0]['findEndpoint']) =>
      new DockerSetup({
        dataDir: os.tmpdir(),
        enabled: true,
        proxyPort: () => 8000,
        containerDir: () => os.tmpdir(),
        platform: 'win32',
        findEndpoint,
      });
    const none = make(async () => ({ kind: 'none' }));
    await none.refresh();
    expect(none.status()).toEqual({ state: 'none', windowsNotYet: true });
    const remote = make(async () => ({ kind: 'remote', host: 'tcp://build.example:2376' }) as never);
    await remote.refresh();
    expect(remote.status()).toEqual({ state: 'remote', daemon: 'tcp://build.example:2376' });
  });

  it('leaves other systems alone', async () => {
    const setup = new DockerSetup({
      dataDir: os.tmpdir(),
      enabled: true,
      proxyPort: () => 8000,
      containerDir: () => os.tmpdir(),
      platform: 'linux',
      findEndpoint: async () => ({ kind: 'none' }),
    });
    await setup.refresh();
    expect(setup.status()).toEqual({ state: 'none' });
  });

  // On Windows itself the helper is there to be found.
  it.skipIf(process.platform === 'win32')(
    'without its pipe helper, starts no relay, says why, and gives terminals nothing',
    async () => {
      // Off Windows there's no Windows helper to find, as when it's missing from an install.
      const setup = new DockerSetup({
        dataDir: os.tmpdir(),
        enabled: true,
        proxyPort: () => 8000,
        containerDir: () => os.tmpdir(),
        platform: 'win32',
        windows: true,
        findEndpoint: async () => ({
          kind: 'local',
          socketPath: '\\\\.\\pipe\\dockerDesktopLinuxEngine',
          host: 'npipe:////./pipe/dockerDesktopLinuxEngine',
        }),
      });
      await setup.refresh();
      expect(setup.status()).toEqual({
        state: 'failed',
        daemon: 'npipe:////./pipe/dockerDesktopLinuxEngine',
        error: NO_PIPE_HELPER,
      });
      expect(setup.terminalEnv()).toEqual({});
      expect((setup as unknown as { relay?: unknown }).relay).toBeUndefined();
      expect(setup.acceptsConnection('172.17.0.2')).toBe(false);
      await setup.stop();
    },
  );
  it('turned on for testing, still says when there is no Docker', async () => {
    const none = new DockerSetup({
      dataDir: os.tmpdir(),
      enabled: true,
      proxyPort: () => 8000,
      containerDir: () => os.tmpdir(),
      platform: 'win32',
      windows: true,
      findEndpoint: async () => ({ kind: 'none' }),
    });
    await none.refresh();
    expect(none.status()).toEqual({ state: 'none' });
  });
});
