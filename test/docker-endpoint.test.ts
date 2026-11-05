import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSubnets, dockerBridgeChecker } from '../src/backend/docker/bridges';
import { composeNames } from '../src/backend/docker/compose';
import { findDockerEndpoint, parseDockerHost } from '../src/backend/docker/endpoint';
import { relayAddress } from '../src/backend/docker/setup';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'wirescry-docker-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const none = async () => false;

async function writeContext(name: string, host: string, current = true): Promise<void> {
  const dir = path.join(home, '.docker', 'contexts', 'meta', createHash('sha256').update(name).digest('hex'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
  );
  if (current)
    await writeFile(path.join(home, '.docker', 'config.json'), JSON.stringify({ currentContext: name }));
}

describe('parseDockerHost', () => {
  it('reads Unix sockets, named pipes and remote addresses', () => {
    expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({
      kind: 'local',
      socketPath: '/var/run/docker.sock',
      host: 'unix:///var/run/docker.sock',
    });
    expect(parseDockerHost('npipe:////./pipe/docker_engine', 'win32')).toEqual({
      kind: 'local',
      socketPath: '\\\\.\\pipe\\docker_engine',
      host: 'npipe:////./pipe/docker_engine',
    });
    expect(parseDockerHost('tcp://10.0.0.2:2376')).toEqual({ kind: 'remote', host: 'tcp://10.0.0.2:2376' });
    expect(parseDockerHost('ssh://me@box')).toEqual({ kind: 'remote', host: 'ssh://me@box' });
    expect(parseDockerHost('/run/user/1000/docker.sock', 'linux')).toMatchObject({
      socketPath: '/run/user/1000/docker.sock',
    });
  });
  it('rejects what is not an address', () => {
    expect(parseDockerHost('unix://')).toBeUndefined();
    expect(parseDockerHost('npipe://nonsense')).toBeUndefined();
    expect(parseDockerHost('docker.sock')).toBeUndefined();
  });
});

describe('findDockerEndpoint', () => {
  it('uses DOCKER_HOST first', async () => {
    await writeContext('desktop-linux', 'unix:///ctx.sock');
    const found = await findDockerEndpoint({
      env: { DOCKER_HOST: 'unix:///env.sock' },
      home,
      platform: 'darwin',
      exists: none,
    });
    expect(found).toMatchObject({ socketPath: '/env.sock' });
  });

  it('reports a remote DOCKER_HOST, and an unreadable one as no Docker', async () => {
    expect(await findDockerEndpoint({ env: { DOCKER_HOST: 'tcp://box:2375' }, home, exists: none })).toEqual({
      kind: 'remote',
      host: 'tcp://box:2375',
    });
    expect(await findDockerEndpoint({ env: { DOCKER_HOST: 'what' }, home, exists: none })).toEqual({
      kind: 'none',
    });
  });

  it('follows the current context, as the CLI does', async () => {
    await writeContext('desktop-linux', `unix://${home}/.docker/run/docker.sock`);
    expect(await findDockerEndpoint({ env: {}, home, platform: 'darwin', exists: none })).toMatchObject({
      kind: 'local',
      socketPath: `${home}/.docker/run/docker.sock`,
    });
  });

  it('prefers DOCKER_CONTEXT to the config file, and DOCKER_CONFIG for where the files are', async () => {
    await writeContext('colima', 'unix:///colima.sock', false);
    await writeContext('desktop-linux', 'unix:///desktop.sock');
    expect(await findDockerEndpoint({ env: { DOCKER_CONTEXT: 'colima' }, home, exists: none })).toMatchObject(
      {
        socketPath: '/colima.sock',
      },
    );
    const elsewhere = path.join(home, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'config.json'), '{}');
    expect(
      await findDockerEndpoint({ env: { DOCKER_CONFIG: elsewhere }, home, platform: 'linux', exists: none }),
    ).toEqual({
      kind: 'none',
    });
  });

  it('treats a context that points nowhere as no Docker', async () => {
    await writeFile(
      path.join(
        await mkdir(path.join(home, '.docker'), { recursive: true }).then(() => home),
        '.docker',
        'config.json',
      ),
      JSON.stringify({ currentContext: 'gone' }),
    );
    expect(await findDockerEndpoint({ env: {}, home, exists: none })).toEqual({ kind: 'none' });
  });

  it('falls back to the usual sockets', async () => {
    const at = (file: string) => async (f: string) => f === file;
    expect(
      await findDockerEndpoint({ env: {}, home, platform: 'linux', exists: at('/var/run/docker.sock') }),
    ).toMatchObject({
      socketPath: '/var/run/docker.sock',
    });
    const desktop = path.join(home, '.docker', 'run', 'docker.sock');
    expect(
      await findDockerEndpoint({ env: {}, home, platform: 'darwin', exists: at(desktop) }),
    ).toMatchObject({
      socketPath: desktop,
    });
    expect(await findDockerEndpoint({ env: {}, home, platform: 'linux', exists: none })).toEqual({
      kind: 'none',
    });
  });

  it("assumes Docker Desktop's pipe on Windows when Docker's folder is there", async () => {
    expect(await findDockerEndpoint({ env: {}, home, platform: 'win32', exists: none })).toEqual({
      kind: 'none',
    });
    expect(
      await findDockerEndpoint({ env: {}, home, platform: 'win32', exists: async () => true }),
    ).toMatchObject({
      socketPath: '\\\\.\\pipe\\docker_engine',
    });
  });

  it('ignores a damaged config file', async () => {
    await mkdir(path.join(home, '.docker'));
    await writeFile(path.join(home, '.docker', 'config.json'), '{not json');
    expect(await findDockerEndpoint({ env: {}, home, platform: 'linux', exists: none })).toEqual({
      kind: 'none',
    });
  });
});

describe('relayAddress', () => {
  it('is in the data folder, the same every time', () => {
    const a = relayAddress('/Users/me/Library/Application Support/Wirescry', 'darwin');
    expect(a.listenPath).toBe('/Users/me/Library/Application Support/Wirescry/docker/docker.sock');
    expect(a.dockerHost).toBe('unix:///Users/me/Library/Application Support/Wirescry/docker/docker.sock');
    expect(relayAddress('/Users/me/Library/Application Support/Wirescry', 'darwin')).toEqual(a);
  });
  it('moves to the temporary folder when the path is too long for a socket', () => {
    const long = `/Users/${'x'.repeat(90)}/Wirescry`;
    const a = relayAddress(long, 'darwin');
    expect(a.listenPath.startsWith(os.tmpdir())).toBe(true);
    expect(Buffer.byteLength(a.listenPath)).toBeLessThan(104);
  });
  it('is a named pipe on Windows, different per data folder', () => {
    const a = relayAddress('C:\\Users\\me\\AppData\\Roaming\\Wirescry', 'win32');
    expect(a.listenPath).toMatch(/^\\\\\.\\pipe\\wirescry-docker-[0-9a-f]{12}$/);
    expect(a.dockerHost).toMatch(/^npipe:\/\/\/\/\.\/pipe\/wirescry-docker-[0-9a-f]{12}$/);
    expect(relayAddress('C:\\other', 'win32').listenPath).not.toBe(a.listenPath);
  });
});

describe('composeNames', () => {
  it('reads service names, container names, host names and aliases', async () => {
    const file = path.join(home, 'compose.yaml');
    await writeFile(
      file,
      [
        'services:',
        '  web:',
        '    image: nginx',
        '    hostname: frontend',
        '  api:',
        '    container_name: my-api',
        '    networks:',
        '      backend:',
        '        aliases: [api.internal, "${NOT_A_NAME}"]',
        '  worker: {}',
      ].join('\n'),
    );
    const names = await composeNames({ 'com.docker.compose.project.config_files': file });
    expect(names.sort()).toEqual(['api', 'api.internal', 'frontend', 'my-api', 'web', 'worker']);
  });

  it('reads every file listed, relative ones from the working folder, and included ones', async () => {
    await mkdir(path.join(home, 'sub'));
    await writeFile(path.join(home, 'compose.yaml'), 'include:\n  - sub/extra.yaml\nservices:\n  a: {}\n');
    await writeFile(path.join(home, 'override.yaml'), 'services:\n  b: {}\n');
    await writeFile(
      path.join(home, 'sub', 'extra.yaml'),
      'include:\n  - path: [more.yaml]\nservices:\n  c: {}\n',
    );
    await writeFile(path.join(home, 'sub', 'more.yaml'), 'services:\n  d: {}\n');
    const names = await composeNames({
      'com.docker.compose.project.config_files': 'compose.yaml,override.yaml',
      'com.docker.compose.project.working_dir': home,
    });
    expect(names.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips files it cannot read, and stops on include loops', async () => {
    await writeFile(path.join(home, 'loop.yaml'), 'include: [loop.yaml]\nservices:\n  x: {}\n');
    await writeFile(path.join(home, 'bad.yaml'), 'services: [unclosed');
    const names = await composeNames({
      'com.docker.compose.project.config_files': [
        path.join(home, 'missing.yaml'),
        path.join(home, 'bad.yaml'),
        path.join(home, 'loop.yaml'),
      ].join(','),
    });
    expect(names).toEqual(['x']);
  });

  it('refuses YAML alias bombs', async () => {
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'services:',
      '  ok: {}',
    ].join('\n');
    await writeFile(path.join(home, 'bomb.yaml'), bomb);
    expect(
      await composeNames({ 'com.docker.compose.project.config_files': path.join(home, 'bomb.yaml') }),
    ).toEqual([]);
  });

  it('gives nothing for containers Compose did not make', async () => {
    expect(await composeNames({})).toEqual([]);
    expect(await composeNames(undefined)).toEqual([]);
  });
});

describe('Docker bridges', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', cidr: '127.0.0.1/8' }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', cidr: '192.168.1.20/24' }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', cidr: '172.17.0.1/16' }],
    'br-0123456789ab': [{ address: '172.18.0.1', family: 'IPv4', cidr: '172.18.0.1/16' }],
    'br-aaaaaaaaaaaa': [{ address: '10.0.0.1', family: 'IPv4', cidr: '10.0.0.1/8' }],
    'docker-huge': [{ address: '10.1.0.1', family: 'IPv4', cidr: '10.1.0.1/8' }],
  } as unknown as ReturnType<typeof os.networkInterfaces>;

  it("accepts addresses on Docker's bridges only", () => {
    const list = bridgeSubnets(interfaces);
    expect(list.check('172.17.0.5', 'ipv4')).toBe(true);
    expect(list.check('172.18.3.9', 'ipv4')).toBe(true);
    expect(list.check('192.168.1.30', 'ipv4')).toBe(false);
    expect(list.check('10.0.0.5', 'ipv4')).toBe(false);
  });

  it('takes IPv4-mapped addresses, refuses anything else, and re-reads the interfaces', () => {
    let reads = 0;
    const check = dockerBridgeChecker(() => {
      reads++;
      return interfaces;
    });
    expect(check('::ffff:172.17.0.2')).toBe(true);
    expect(check('172.19.0.2')).toBe(false);
    expect(check('fe80::1')).toBe(false);
    expect(check('garbage')).toBe(false);
    expect(reads).toBe(1);
  });

  it('refuses everything when the interfaces cannot be read', () => {
    const check = dockerBridgeChecker(() => {
      throw new Error('no');
    });
    expect(check('172.17.0.2')).toBe(false);
  });
});
