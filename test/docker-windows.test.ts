/**
 * The Docker relay in front of a real Docker on Windows, over named pipes, through the pipe
 * helper (native/docker-pipe), started by Docker setup as the app starts it.
 *
 * GitHub's Windows runners have Docker with Windows containers only, which Wirescry leaves as
 * they are (so terminals wouldn't get DOCKER_HOST there), but still relays. What's tested is that
 * every kind of Docker request passes through unharmed, above all attached streams, whose ends
 * Docker marks with a zero-length message on its pipe: `docker run` must finish when the output
 * does, and `docker run -i` must tell the container its input ended. Without the helper both hung.
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
import { parseDockerHost } from '../src/backend/docker/endpoint';
import { DockerSetup, relayAddress, type ContainerCreated } from '../src/backend/docker/setup';
import { pipeHelperForTests } from './pipe-helper-binary';

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
  let setup: DockerSetup;
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
  const dockerWithInput = (args: string[], input: string, timeoutMs: number, direct = false) =>
    new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const env = { ...process.env };
      if (!direct) env.DOCKER_HOST = dockerHost;
      const child = spawn('docker', args, { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `docker ${args.join(' ')}${direct ? ' (straight to Docker)' : ' (through the relay)'} didn't finish in ${timeoutMs} ms. Output so far: ${JSON.stringify({ stdout, stderr })}`,
          ),
        );
      }, timeoutMs);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        // In the CI log, so what Windows did is on record either way.
        console.log(
          `docker ${args.join(' ')}${direct ? ' (straight to Docker)' : ' (through the relay)'}: ${JSON.stringify({ code, stdout, stderr })}`,
        );
        resolve({ stdout, stderr, code });
      });
      child.stdin.end(input);
    });

  beforeAll(async () => {
    // Docker's own pipe. Wirescry looks for Docker Desktop's config folder before assuming it,
    // which a runner with only Docker Engine may not have.
    const endpoint = parseDockerHost('npipe:////./pipe/docker_engine', 'win32') ?? { kind: 'none' };
    if (endpoint.kind !== 'local') throw new Error(`No local Docker found: ${JSON.stringify(endpoint)}`);
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}'], true)) as {
      Os: string;
      KernelVersion: string;
    };
    expect(version.Os).toBe('windows');
    image = nanoserverFor(version.KernelVersion);
    await docker(['pull', '-q', image], true);

    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-win-docker-'));
    setup = new DockerSetup({
      dataDir: dir,
      enabled: true,
      findEndpoint: async () => endpoint,
      proxyPort: () => 8000,
      containerDir: () => dir,
      onContainer: (event) => created.push(event),
      platform: 'win32',
      pipeHelper: pipeHelperForTests(),
    });
    await setup.refresh();
    // Windows containers: left alone, so terminals wouldn't get DOCKER_HOST; the relay runs anyway.
    expect(setup.status()).toMatchObject({
      state: 'unsupported',
      error: expect.stringMatching(/Windows containers/),
    });
    dockerHost = relayAddress(dir, 'win32').dockerHost;
  }, 900_000);

  afterAll(async () => {
    await docker(['compose', '-p', PROJECT, 'down', '-t', '0'], true).catch(() => undefined);
    await setup?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('passes ordinary requests through', async () => {
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}'])) as { Os: string };
    expect(version.Os).toBe('windows');
    expect(await docker(['ps', '-a', '--format', '{{.ID}}'])).toBeTypeOf('string');
    expect(await docker(['image', 'inspect', '--format', '{{.Os}}', image])).toContain('windows');
  });

  it('runs a detached container, and gets its exit code and logs', async () => {
    // No attached stream: create, start, wait and logs are ordinary requests.
    const name = `wirescry-detached-${process.pid}`;
    await docker(['run', '-d', '--name', name, image, 'cmd', '/c', 'echo detached-ok']);
    try {
      expect((await docker(['wait', name])).trim()).toBe('0');
      expect((await docker(['logs', name])).trim()).toBe('detached-ok');
    } finally {
      await docker(['rm', '-f', name], true);
    }
    // Windows containers are left as written, and labelled so.
    expect(created.at(-1)).toMatchObject({
      setUp: false,
      reason: expect.stringMatching(/Windows containers/),
    });
  }, 300_000);

  it('runs attached containers straight to Docker, with and without input', async () => {
    // The commands below are right: they finish without the relay.
    const run = await dockerWithInput(
      ['run', '--rm', image, 'cmd', '/c', 'echo relay-ok'],
      '',
      120_000,
      true,
    );
    expect({ code: run.code, out: run.stdout.trim() }).toEqual({ code: 0, out: 'relay-ok' });
    const input = await dockerWithInput(
      ['run', '-i', '--rm', image, 'cmd', '/q', '/k', 'echo started'],
      'echo relay-eof-ok\r\n',
      120_000,
      true,
    );
    expect({ code: input.code, out: input.stdout.includes('relay-eof-ok') }).toEqual({ code: 0, out: true });
  }, 300_000);

  it('runs attached containers through the relay, finishing when they do', async () => {
    const relayed = await dockerWithInput(['run', '--rm', image, 'cmd', '/c', 'echo relay-ok'], '', 60_000);
    expect({ code: relayed.code, out: relayed.stdout.trim() }).toEqual({ code: 0, out: 'relay-ok' });
  }, 120_000);

  it("passes stdin's end on, so `docker run -i` finishes when its input does", async () => {
    // cmd reads commands from stdin until it ends, then exits.
    const relayed = await dockerWithInput(
      ['run', '-i', '--rm', image, 'cmd', '/q', '/k', 'echo started'],
      'echo relay-eof-ok\r\n',
      60_000,
    );
    expect({ code: relayed.code, out: relayed.stdout.includes('relay-eof-ok') }).toEqual({
      code: 0,
      out: true,
    });
  }, 120_000);

  it('runs a container with a TTY through the relay', async () => {
    const relayed = await dockerWithInput(
      ['run', '-t', '--rm', image, 'cmd', '/c', 'echo tty-ok'],
      '',
      60_000,
    );
    expect({ code: relayed.code, out: relayed.stdout.includes('tty-ok') }).toEqual({ code: 0, out: true });
  }, 120_000);

  it('runs `docker exec -i` and `docker attach` through the relay', async () => {
    const name = `wirescry-exec-${process.pid}`;
    // Runs a while, then says something and exits, for attach to see.
    await docker([
      'run',
      '-d',
      '--name',
      name,
      image,
      'cmd',
      '/c',
      'ping -n 60 127.0.0.1 >nul & echo attach-ok',
    ]);
    try {
      const exec = await dockerWithInput(
        ['exec', '-i', name, 'cmd', '/q', '/k', 'echo exec-started'],
        'echo exec-eof-ok\r\n',
        60_000,
      );
      expect({ code: exec.code, out: exec.stdout.includes('exec-eof-ok') }).toEqual({ code: 0, out: true });
      // Attach ends when the container does.
      const attach = await dockerWithInput(['attach', '--no-stdin', name], '', 120_000);
      expect({ code: attach.code, out: attach.stdout.includes('attach-ok') }).toEqual({ code: 0, out: true });
    } finally {
      await docker(['rm', '-f', name], true);
    }
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
    // `compose run` attaches, with stdin that ends.
    const run = await dockerWithInput(
      [
        'compose',
        '-p',
        PROJECT,
        '-f',
        file,
        'run',
        '--rm',
        '-T',
        'hello',
        'cmd',
        '/q',
        '/k',
        'echo run-started',
      ],
      'echo compose-run-ok\r\n',
      120_000,
    );
    expect({ code: run.code, out: run.stdout.includes('compose-run-ok') }).toEqual({ code: 0, out: true });
    await docker(['compose', '-p', PROJECT, '-f', file, 'down', '-t', '0']);
  }, 600_000);
});

describe.runIf(process.platform === 'win32' && !wanted)('The Docker relay on Windows', () => {
  it.skip('runs only in CI (WIRESCRY_WINDOWS_DOCKER_E2E=1), against real Docker', () => undefined);
});
