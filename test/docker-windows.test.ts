/**
 * The Docker relay in front of a real Docker on Windows, over named pipes.
 *
 * GitHub's Windows runners have Docker with Windows containers only, which Wirescry leaves as
 * they are, so the app wouldn't point terminals at its relay there. This starts the relay
 * directly instead: what's tested is that every kind of Docker request passes through it over
 * a named pipe unharmed, above all `docker run -i`, whose stdin must end when the input does
 * (named pipes have no half-close in Node; a hang here would hang users' `docker run -i` with
 * Docker Desktop on Windows).
 *
 * Runs only on Windows with WIRESCRY_WINDOWS_DOCKER_E2E=1 (set by CI), which also makes a
 * missing Docker a failure rather than a skip.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABELS } from '../src/backend/docker/container';
import { findDockerEndpoint } from '../src/backend/docker/endpoint';
import { DockerRelay, type ContainerCreated } from '../src/backend/docker/relay';

const run = promisify(execFile);
const wanted = process.platform === 'win32' && process.env.WIRESCRY_WINDOWS_DOCKER_E2E === '1';
const PROJECT = `wirescry-win-${process.pid}`;

/** The nanoserver image matching the host's Windows build: process isolation needs the same one. */
function nanoserverFor(kernelVersion: string): string {
  const build = Number(/\b(\d{5})\b/.exec(kernelVersion)?.[1] ?? 0);
  const tag = build >= 26100 ? 'ltsc2025' : build >= 20348 ? 'ltsc2022' : '1809';
  return `mcr.microsoft.com/windows/nanoserver:${tag}`;
}

describe.runIf(wanted)('The Docker relay with a real Docker on Windows', () => {
  let dir: string;
  let relay: DockerRelay;
  let dockerHost: string;
  let image: string;
  const created: ContainerCreated[] = [];

  /** Runs docker through the relay (or straight to Docker when `direct`). */
  const docker = async (args: string[], direct = false): Promise<string> => {
    const env = { ...process.env };
    if (!direct) env.DOCKER_HOST = dockerHost;
    const { stdout } = await run('docker', args, { env, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };

  /** Runs docker through the relay with `input` on stdin, then ends it; resolves with stdout and the exit code. */
  const dockerWithInput = (args: string[], input: string, timeoutMs: number) =>
    new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn('docker', args, { env: { ...process.env, DOCKER_HOST: dockerHost } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `docker ${args.join(' ')} didn't finish in ${timeoutMs} ms: stdin's end never reached the container? stdout: ${stdout} stderr: ${stderr}`,
          ),
        );
      }, timeoutMs);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
      child.stdin.end(input);
    });

  beforeAll(async () => {
    const endpoint = await findDockerEndpoint();
    if (endpoint.kind !== 'local') throw new Error(`No local Docker found: ${JSON.stringify(endpoint)}`);
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}'], true)) as {
      Os: string;
      KernelVersion: string;
    };
    expect(version.Os).toBe('windows');
    image = nanoserverFor(version.KernelVersion);
    await docker(['pull', '-q', image], true);

    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-win-docker-'));
    const name = `wirescry-test-${process.pid}`;
    relay = new DockerRelay({
      listenPath: `\\\\.\\pipe\\${name}`,
      upstream: () => endpoint,
      proxyPort: () => 8000,
      configDir: dir,
      onContainer: (event) => created.push(event),
      platform: 'win32',
    });
    await relay.start();
    dockerHost = `npipe:////./pipe/${name}`;
  }, 900_000);

  afterAll(async () => {
    await docker(['compose', '-p', PROJECT, 'down', '-t', '0'], true).catch(() => undefined);
    await relay?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('passes ordinary requests through', async () => {
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}'])) as { Os: string };
    expect(version.Os).toBe('windows');
    expect(await docker(['ps', '-a', '--format', '{{.ID}}'])).toBeTypeOf('string');
    expect(await docker(['image', 'inspect', '--format', '{{.Os}}', image])).toContain('windows');
  });

  it('runs a container and returns its output', async () => {
    const out = await docker(['run', '--rm', image, 'cmd', '/c', 'echo relay-ok']);
    expect(out.trim()).toBe('relay-ok');
    // Windows containers are left as written, and labelled so.
    expect(created.at(-1)).toMatchObject({
      setUp: false,
      reason: expect.stringMatching(/Windows containers/),
    });
  }, 300_000);

  it('ends a docker run -i container’s input when the input ends', async () => {
    // `sort` reads stdin to its end before writing anything: it finishes only if the end gets through.
    const result = await dockerWithInput(
      ['run', '-i', '--rm', image, 'cmd', '/c', 'sort'],
      'b\r\na\r\n',
      180_000,
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['a', 'b']);
  }, 300_000);

  it('labels what it leaves alone, as Docker sees it', async () => {
    const name = `wirescry-label-${process.pid}`;
    await docker(['create', '--name', name, image, 'cmd', '/c', 'exit 0']);
    try {
      expect(
        (
          await docker(['inspect', '--format', `{{index .Config.Labels "${LABELS.setup}"}}`, name], true)
        ).trim(),
      ).toBe('skipped');
    } finally {
      await docker(['rm', '-f', name], true);
    }
  }, 300_000);

  it('brings a Compose project up and down', async () => {
    const file = path.join(dir, 'compose.yaml');
    await writeFile(
      file,
      `services:\n  hello:\n    image: ${image}\n    command: ["cmd", "/c", "echo compose-ok"]\n`,
    );
    await docker(['compose', '-p', PROJECT, '-f', file, 'up', '--abort-on-container-exit']);
    expect(await docker(['compose', '-p', PROJECT, '-f', file, 'logs', '--no-log-prefix'])).toContain(
      'compose-ok',
    );
    // A second up doesn't recreate what's unchanged: the relay reports Compose's own hash.
    const before = (await docker(['compose', '-p', PROJECT, '-f', file, 'ps', '-a', '-q'])).trim();
    await docker(['compose', '-p', PROJECT, '-f', file, 'up', '--abort-on-container-exit']);
    expect((await docker(['compose', '-p', PROJECT, '-f', file, 'ps', '-a', '-q'])).trim()).toBe(before);
    await docker(['compose', '-p', PROJECT, '-f', file, 'down', '-t', '0']);
  }, 600_000);
});

describe.runIf(process.platform === 'win32' && !wanted)('The Docker relay on Windows', () => {
  it.skip('runs only in CI (WIRESCRY_WINDOWS_DOCKER_E2E=1), against real Docker', () => undefined);
});
