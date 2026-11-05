import { describe, expect, it } from 'vitest';
import { parseInfo, unsupportedReason, type DaemonInfo } from '../src/backend/docker/runtime';

const info = (over: Partial<DaemonInfo>): DaemonInfo => ({
  osType: 'linux',
  operatingSystem: 'Docker Desktop',
  rootless: false,
  selinux: false,
  podman: false,
  name: '',
  ...over,
});

describe('parseInfo', () => {
  it('reads the OS, the product and the security options', () => {
    expect(
      parseInfo({
        OSType: 'linux',
        OperatingSystem: 'Fedora Linux 42',
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=selinux', 'name=cgroupns'],
        Name: 'workstation',
      }),
    ).toEqual({
      osType: 'linux',
      operatingSystem: 'Fedora Linux 42',
      rootless: false,
      selinux: true,
      podman: false,
      name: 'workstation',
    });
    expect(parseInfo({ OSType: 'linux', SecurityOptions: ['name=rootless'] })?.rootless).toBe(true);
  });
  it("doesn't mistake similar names", () => {
    expect(parseInfo({ SecurityOptions: ['name=notrootless', 'name=selinuxish'] })).toMatchObject({
      rootless: false,
      selinux: false,
    });
  });
  it('copes with odd replies', () => {
    expect(parseInfo(null)).toBeUndefined();
    expect(parseInfo('x')).toBeUndefined();
    expect(parseInfo({ SecurityOptions: 'nope', OSType: 3, Name: 7 })).toEqual({
      osType: '',
      operatingSystem: '',
      rootless: false,
      selinux: false,
      podman: false,
      name: '',
    });
  });
  it("recognizes Podman's Docker-compatible API by its version reply", () => {
    const podman = { Components: [{ Name: 'Podman Engine', Version: '5.6.0' }] };
    expect(parseInfo({ OSType: 'linux' }, podman)?.podman).toBe(true);
    expect(parseInfo({ OSType: 'linux' }, { Components: [{ Name: 'Engine' }] })?.podman).toBe(false);
    expect(parseInfo({ OSType: 'linux' }, 'nonsense')?.podman).toBe(false);
  });
});

describe('unsupportedReason', () => {
  it('sets up Docker Desktop everywhere, and rootful Docker on Linux', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(unsupportedReason(info({}), platform)).toBeUndefined();
    }
    expect(unsupportedReason(info({ operatingSystem: 'Ubuntu 24.04.3 LTS' }), 'linux')).toBeUndefined();
  });
  it('leaves alone what is known not to reach Wirescry, saying what it is', () => {
    // colima, Lima, Rancher Desktop and OrbStack run Linux in a VM on macOS.
    expect(unsupportedReason(info({ operatingSystem: 'Ubuntu 24.04 LTS' }), 'darwin')).toMatch(
      /not Ubuntu 24\.04 LTS/,
    );
    expect(unsupportedReason(info({ operatingSystem: 'OrbStack' }), 'darwin')).toMatch(/not OrbStack/);
    expect(unsupportedReason(info({ rootless: true, operatingSystem: 'Ubuntu' }), 'linux')).toMatch(
      /rootless/,
    );
    expect(unsupportedReason(info({ osType: 'windows' }), 'win32')).toMatch(/Windows containers/);
    expect(unsupportedReason(info({ podman: true, operatingSystem: 'fedora' }), 'linux')).toMatch(/Podman/);
    expect(unsupportedReason(info({ operatingSystem: '' }), 'darwin')).toMatch(/not this Docker/);
  });
  it('on Linux, sets up Docker on this computer: the same host name, in any case', () => {
    const engine = info({ operatingSystem: 'Ubuntu 24.04.3 LTS', name: 'workstation' });
    expect(unsupportedReason(engine, 'linux', 'workstation')).toBeUndefined();
    expect(unsupportedReason(engine, 'linux', 'WorkStation')).toBeUndefined();
    // Docker always names its machine; one that doesn't, or a host with no name, isn't second-guessed.
    expect(unsupportedReason(info({ operatingSystem: 'Ubuntu' }), 'linux', 'workstation')).toBeUndefined();
    expect(unsupportedReason(engine, 'linux', '')).toBeUndefined();
    // Docker Desktop runs in a VM on Linux too, and is set up.
    expect(unsupportedReason(info({ name: 'docker-desktop' }), 'linux', 'workstation')).toBeUndefined();
  });
  it('on Linux, leaves alone Docker in a virtual machine (colima, Lima, Rancher Desktop), naming it', () => {
    for (const name of ['colima', 'lima-default', 'lima-rancher-desktop']) {
      expect(
        unsupportedReason(info({ operatingSystem: 'Ubuntu 24.04 LTS', name }), 'linux', 'workstation'),
      ).toBe(
        `Wirescry sets up Docker running on this computer, but not Docker in a virtual machine (${name}) yet.`,
      );
    }
    // A longer or shorter name is still another machine.
    const fqdn = info({ operatingSystem: 'Ubuntu', name: 'workstation.example.com' });
    expect(unsupportedReason(fqdn, 'linux', 'workstation')).toMatch(/virtual machine/);
    // Rootless and Podman keep their own reasons.
    expect(unsupportedReason(info({ rootless: true, name: 'colima' }), 'linux', 'workstation')).toMatch(
      /rootless/,
    );
    // Off Linux the host name isn't what decides.
    expect(unsupportedReason(info({ name: 'docker-desktop' }), 'darwin', 'mac')).toBeUndefined();
  });
  it("leaves the container alone when Docker didn't say what it is", () => {
    expect(unsupportedReason(undefined, 'darwin')).toMatch(/didn.t say what kind of Docker/);
    expect(unsupportedReason(undefined, 'linux')).toMatch(/didn.t say/);
  });
});
