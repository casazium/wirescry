/**
 * PipeHelper, the relay's transport on Windows: the helper process (native/docker-pipe) serves
 * the pipe Docker clients use and makes the relay's connections to Docker. Off Windows the helper
 * uses Unix sockets in place of pipes, so this runs everywhere.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipeHelper } from '../src/backend/docker/pipe-helper';
import { dialErrorIn, DockerRelay } from '../src/backend/docker/relay';
import { pipeHelperForTests } from './pipe-helper-binary';

const helper = pipeHelperForTests();
const windows = process.platform === 'win32';

/**
 * A daemon that ends attached streams as Docker does: when the container's output is done it
 * half-closes, and it never closes the connection itself, only once the other end has.
 */
function dockerLike(socketPath: string) {
  const closedByPeer: string[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const rest = head.slice(end + 4);
      const url = head.split(' ')[1] ?? '';
      if (url.startsWith('/_ping')) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
        return;
      }
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      if (url.includes('output-first')) {
        // `docker run` without -i: the output ends while stdin is still open.
        socket.end('output');
      } else {
        // `docker run -i`: echo stdin, and end once it has.
        let input = rest;
        socket.on('data', (d: Buffer) => (input += d.toString('latin1')));
        socket.once('end', () => socket.end(`got ${input}`));
      }
      socket.once('close', () => closedByPeer.push(url));
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
  });
  return {
    closedByPeer,
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!helper || windows)('PipeHelper', () => {
  let dir: string;
  let daemon: ReturnType<typeof dockerLike>;
  let transport: PipeHelper;
  let relay: DockerRelay;
  let changes: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wp-'));
    daemon = dockerLike(path.join(dir, 'docker.sock'));
    await daemon.listen();
    changes = 0;
    const listenPath = path.join(dir, 'relay.sock');
    transport = new PipeHelper({
      executable: helper!,
      listenPath,
      log: () => undefined,
      onChange: () => (changes += 1),
    });
    const socketPath = path.join(dir, 'docker.sock');
    relay = new DockerRelay({
      listenPath,
      upstream: () => ({ kind: 'local', socketPath, host: `unix://${socketPath}` }),
      proxyPort: () => 8000,
      configDir: dir,
      log: () => undefined,
      transport,
    });
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Sends an upgrade request through the relay; resolves with all that came back once it ended. */
  const attach = (url: string, input: string | undefined) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect({ path: relay.listenPath, allowHalfOpen: true });
      let out = '';
      socket.on('data', (d: Buffer) => (out += d.toString('latin1')));
      socket.once('end', () => {
        socket.end();
        resolve(out);
      });
      socket.once('error', reject);
      socket.write(`POST ${url} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
      if (input !== undefined) socket.end(input);
      setTimeout(() => reject(new Error(`no end; so far ${JSON.stringify(out)}`)), 5000).unref();
    });

  it('carries the input’s end to Docker and the output’s end back, as `docker run -i` needs', async () => {
    expect(await attach('/containers/c/attach?stdin=1', 'hello')).toMatch(/101 UPGRADED[\s\S]*got hello$/);
    // Docker never closes; the helper does once both ends are done, so nothing is left open.
    await expect.poll(() => daemon.closedByPeer).toContain('/containers/c/attach?stdin=1');
  });

  it('carries the output’s end back while the input is still open, as `docker run` needs', async () => {
    const socket = net.connect({ path: relay.listenPath, allowHalfOpen: true });
    let out = '';
    socket.on('data', (d: Buffer) => (out += d.toString('latin1')));
    const ended = new Promise<void>((resolve) => socket.once('end', resolve));
    socket.write(
      'POST /containers/c/attach?output-first HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
    await ended;
    expect(out).toMatch(/output$/);
    socket.end();
    await expect.poll(() => daemon.closedByPeer).toContain('/containers/c/attach?output-first');
  });

  it('takes only connections that start with its token', async () => {
    const gate = (transport as unknown as { gate: net.Server }).gate.address() as net.AddressInfo;
    const socket = net.connect(gate.port, '127.0.0.1');
    let out = '';
    socket.on('data', (d: Buffer) => (out += d.toString()));
    socket.write(`${'x'.repeat(32)}GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n`);
    await new Promise((resolve) => socket.once('close', resolve));
    expect(out).toBe('');
  });

  it('starts the helper again when it stops, saying so meanwhile', async () => {
    const ping = () =>
      new Promise<number>((resolve, reject) => {
        http
          .get({ socketPath: relay.listenPath, path: '/_ping', headers: { host: 'docker' } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
    expect(await ping()).toBe(200);
    const child = (transport as unknown as { child: ChildProcess }).child;
    child.kill();
    await expect.poll(() => relay.problem()).toMatch(/stopped/);
    await expect.poll(() => relay.problem(), { timeout: 10_000 }).toBeUndefined();
    expect(changes).toBeGreaterThanOrEqual(2);
    await expect.poll(() => ping().catch(() => 0), { timeout: 10_000 }).toBe(200);
  });

  it('stops the helper with the relay', async () => {
    const child = (transport as unknown as { child: ChildProcess }).child;
    await relay.stop();
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
    await expect(
      new Promise((resolve, reject) =>
        net.connect(relay.listenPath).once('connect', resolve).once('error', reject),
      ),
    ).rejects.toThrow();
  });
});

describe('PipeHelper without its executable', () => {
  it('fails to start, so terminals don’t get pointed at it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wp-'));
    try {
      const transport = new PipeHelper({
        executable: path.join(dir, 'missing-helper'),
        listenPath: path.join(dir, 'relay.sock'),
        log: () => undefined,
      });
      const relay = new DockerRelay({
        listenPath: path.join(dir, 'relay.sock'),
        upstream: () => ({ kind: 'none' }),
        proxyPort: () => 8000,
        configDir: dir,
        transport,
      });
      await expect(relay.start()).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Telling the helper's dial error from Docker's answer on a taken-over connection", () => {
  const body = JSON.stringify({ message: 'open \\\\.\\pipe\\docker_engine: Access is denied.' });
  const answer = Buffer.from(
    `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Wirescry-Dial-Error: EACCES\r\nConnection: close\r\n\r\n${body}`,
  );

  it('waits for the whole answer however it arrives, then reads the error', () => {
    for (let i = 1; i < answer.length; i++) {
      expect(dialErrorIn(answer.subarray(0, i), false)).toBe('wait');
    }
    expect(dialErrorIn(answer, false)).toMatchObject({
      code: 'EACCES',
      message: 'open \\\\.\\pipe\\docker_engine: Access is denied.',
    });
  });

  it("passes Docker's own answers on at once", () => {
    expect(dialErrorIn(Buffer.from('HTTP/1.1 101 UPGRADED\r\n'), false)).toBeUndefined();
    expect(dialErrorIn(Buffer.from('H'), false)).toBe('wait');
    expect(dialErrorIn(Buffer.from('HX'), false)).toBeUndefined();
    // A 502 from Docker itself, without the helper's header.
    const docker = Buffer.from('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 2\r\n\r\n{}');
    expect(dialErrorIn(docker, false)).toBeUndefined();
  });

  it('stops waiting at the end of the stream, or once 4 KB have come', () => {
    expect(dialErrorIn(Buffer.from('HTTP/1.1 50'), true)).toBeUndefined();
    expect(dialErrorIn(Buffer.from(`HTTP/1.1 502 ${'x'.repeat(5000)}`), false)).toBeUndefined();
    expect(dialErrorIn(answer.subarray(0, answer.length - 3), true)).toMatchObject({ code: 'EACCES' });
  });
});
