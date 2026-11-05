import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { ProxyStatus } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const run = promisify(execFile);

/** Whether a Docker engine running Linux containers is reachable. Real containers are slow, so only then. */
function linuxDocker(): boolean {
  if (process.env.WIRESCRY_SKIP_DOCKER_E2E) return false;
  try {
    return (
      execFileSync('docker', ['version', '--format', '{{.Server.Os}}'], {
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() === 'linux'
    );
  } catch {
    return false;
  }
}

const CURL = 'curlimages/curl:8.11.1';
const BUSYBOX = 'busybox:1.36.1';
const NODE = 'node:24.11.0-alpine';
const PYTHON = 'python:3.13.9-alpine';
const PROJECT = `wirescry-e2e-${process.pid}`;

describe.skipIf(!linuxDocker())('Docker containers through Wirescry (real Docker)', () => {
  let dataDir: string;
  let projectDir: string;
  let backend: RunningBackend;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let upstream: Mockttp;
  let local: http.Server;
  let localPort: number;
  let dockerHost: string;

  /** Runs docker with the given DOCKER_HOST (Wirescry's, or the user's own when undefined). */
  const docker = async (args: string[], viaWirescry = true): Promise<string> => {
    const env = { ...process.env };
    if (viaWirescry) env.DOCKER_HOST = dockerHost;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[key];
    const { stdout } = await run('docker', args, { env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
  const containerEnv = async (name: string): Promise<string[]> =>
    JSON.parse(await docker(['inspect', '--format', '{{json .Config.Env}}', name], false)) as string[];
  const containerId = async (name: string): Promise<string> =>
    (await docker(['inspect', '--format', '{{.Id}}', name], false)).trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-e2e-'));
    projectDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-e2e-project-'));
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    for (const route of ['/secure', '/node', '/python'])
      await upstream.forGet(route).thenReply(200, 'secure-ok');
    local = http.createServer((req, res) => res.end(`local-ok ${req.url}`));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    localPort = (local.address() as net.AddressInfo).port;
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
    api = await apiClient(backend.apiPort);
    const status = (api.messages[0] as { status: ProxyStatus }).status;
    expect(status.docker.state).toBe('ready');
    dockerHost = status.terminalEnv.DOCKER_HOST!;
    await docker(['pull', '-q', CURL], false);
    for (const image of [BUSYBOX, NODE, PYTHON]) await docker(['pull', '-q', image], false);
  }, 600_000);

  afterAll(async () => {
    await docker(['compose', '-p', PROJECT, 'down', '--remove-orphans', '-t', '0'], false).catch(
      () => undefined,
    );
    api?.close();
    await backend?.stop();
    await upstream?.stop();
    await new Promise((resolve) => local?.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }, 120_000);

  it('sends a docker run container’s HTTP and HTTPS through Wirescry', async () => {
    const out = await docker([
      'run',
      '--rm',
      CURL,
      '-sS',
      '--fail',
      `http://host.docker.internal:${localPort}/plain`,
      '-o',
      '/dev/stdout',
      `https://host.docker.internal:${upstream.port}/secure`,
    ]);
    expect(out).toBe('local-ok /plainsecure-ok');
    await expect
      .poll(() => exchangesIn(api.messages).some((e) => e.path === '/plain' && e.status === 200))
      .toBe(true);
    await expect
      .poll(() => exchangesIn(api.messages).some((e) => e.path === '/secure' && e.status === 200))
      .toBe(true);
  }, 120_000);

  it('leaves docker run without Wirescry as it was', async () => {
    const out = await docker(
      ['run', '--rm', BUSYBOX, 'sh', '-c', 'echo "proxy=${HTTPS_PROXY:-none}"'],
      false,
    );
    expect(out.trim()).toBe('proxy=none');
  }, 120_000);

  it('runs a Compose project: containers reach each other directly and the host through Wirescry', async () => {
    await writeFile(
      path.join(projectDir, 'compose.yaml'),
      [
        'services:',
        '  api:',
        `    image: ${BUSYBOX}`,
        '    command: ["sh", "-c", "mkdir -p /www && echo api-ok > /www/index.html && httpd -f -p 8080 -h /www"]',
        '  client:',
        `    image: ${CURL}`,
        '    depends_on: [api]',
        '    command:',
        '      - sh',
        '      - -c',
        `      - curl -sS --fail --retry 20 --retry-connrefused --retry-delay 1 http://api:8080/ && curl -sS --fail http://host.docker.internal:${localPort}/via-compose`,
        '',
      ].join('\n'),
    );
    const compose = (args: string[], viaWirescry = true) =>
      docker(['compose', '-p', PROJECT, '--project-directory', projectDir, ...args], viaWirescry);
    const out = await compose([
      'up',
      '--abort-on-container-exit',
      '--exit-code-from',
      'client',
      '--no-color',
      '--no-log-prefix',
    ]);
    expect(out).toContain('api-ok');
    expect(out).toContain('local-ok /via-compose');
    await expect.poll(() => exchangesIn(api.messages).some((e) => e.path === '/via-compose')).toBe(true);
    // The request between the two containers skipped the proxy.
    expect(exchangesIn(api.messages).some((e) => e.host.startsWith('api'))).toBe(false);

    const client = `${PROJECT}-client-1`;
    expect(
      (await containerEnv(client)).some((e) => e.startsWith('NO_PROXY=') && e.split(',').includes('api')),
    ).toBe(true);

    // From a Wirescry terminal again: nothing changed, so nothing is recreated.
    const id = await containerId(client);
    await compose(['up', '--no-start']);
    expect(await containerId(client)).toBe(id);

    // Without Wirescry, Compose recreates it without the proxy settings...
    await compose(['up', '--no-start'], false);
    expect(await containerId(client)).not.toBe(id);
    expect((await containerEnv(client)).some((e) => e.startsWith('HTTP_PROXY='))).toBe(false);

    // ...and from a Wirescry terminal, with them again.
    await compose(['up', '--no-start']);
    expect(
      (await containerEnv(client)).some((e) => e.startsWith('HTTP_PROXY=http://host.docker.internal:')),
    ).toBe(true);
  }, 300_000);

  it('works for Node.js fetch and Python urllib, HTTPS included', async () => {
    const url = `https://host.docker.internal:${upstream.port}`;
    const node = await docker([
      'run',
      '--rm',
      NODE,
      'node',
      '-e',
      `fetch('${url}/node').then(r => r.text()).then(t => console.log(t))`,
    ]);
    expect(node.trim()).toBe('secure-ok');
    const python = await docker([
      'run',
      '--rm',
      PYTHON,
      'python',
      '-c',
      `import urllib.request; print(urllib.request.urlopen('${url}/python').read().decode())`,
    ]);
    expect(python.trim()).toBe('secure-ok');
    await expect
      .poll(() =>
        ['/node', '/python'].every((p) =>
          exchangesIn(api.messages).some((e) => e.path === p && e.status === 200),
        ),
      )
      .toBe(true);
  }, 180_000);

  it("creates containers with no network, or sharing another's, which Docker would refuse a host entry for", async () => {
    expect((await docker(['run', '--rm', '--network', 'none', BUSYBOX, 'echo', 'isolated'])).trim()).toBe(
      'isolated',
    );
    const name = `${PROJECT}-shared`;
    await docker(['run', '-d', '--name', name, BUSYBOX, 'sleep', '60']);
    try {
      const out = await docker([
        'run',
        '--rm',
        '--network',
        `container:${name}`,
        BUSYBOX,
        'sh',
        '-c',
        'echo "proxy=$HTTPS_PROXY"',
      ]);
      expect(out.trim()).toMatch(/^proxy=http:\/\/host\.docker\.internal:\d+$/);
    } finally {
      await docker(['rm', '-f', name], false);
    }
  }, 120_000);

  it('passes attach through: docker run -i gets its input and output', async () => {
    const env = { ...process.env, DOCKER_HOST: dockerHost };
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'docker',
        ['run', '--rm', '-i', BUSYBOX, 'tr', 'a-z', 'A-Z'],
        { env, timeout: 60_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.end('shout\n');
    });
    expect(out).toBe('SHOUT\n');
  }, 120_000);
});
