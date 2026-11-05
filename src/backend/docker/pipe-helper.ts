import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import path from 'node:path';

/**
 * How the relay takes connections from Docker clients and makes its own to Docker. On macOS and
 * Linux the relay does both itself over Unix sockets; on Windows a helper does the pipe ends
 * (see PipeHelper).
 */
export interface RelayTransport {
  /** Starts taking client connections, handing each to `server`. */
  listen(server: http.Server): Promise<void>;
  /** A new connection to the daemon at `socketPath`, which may still be connecting. */
  connect(socketPath: string): net.Socket;
  close(): Promise<void>;
  /** Why connections can't be passed on right now, if they can't. */
  problem(): string | undefined;
}

/**
 * Where the helper is: next to the app's other resources once packaged, or where
 * `scripts/build-docker-pipe.mjs` builds it during development. Undefined if it isn't anywhere.
 */
export function findPipeHelper(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  // Only one built for the computer this runs on.
  if (platform !== process.platform || arch !== process.arch) return undefined;
  const name = platform === 'win32' ? 'wirescry-docker-pipe.exe' : 'wirescry-docker-pipe';
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const built = path.join('native', 'docker-pipe', 'bin', `${platform}-${arch}`, name);
  const candidates = [
    ...(resources ? [path.join(resources, name)] : []),
    // The built backend (out/main), and the source (src/backend/docker) under tests.
    path.join(__dirname, '..', '..', built),
    path.join(__dirname, '..', '..', '..', built),
  ];
  return candidates.find((file) => existsSync(file));
}

/** Bytes of the secret each connection between the relay and the helper starts with. */
const TOKEN_SIZE = 32;
/** How long a connection to the relay's port has to send the token. */
const TOKEN_TIMEOUT_MS = 5_000;
/** How long the helper has to start. */
const START_TIMEOUT_MS = 15_000;
/** Restart delays after the helper stops unexpectedly. */
const RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** A helper that ran this long before stopping starts again at the shortest delay. */
const STEADY_MS = 60_000;
/** Header the helper answers with when it couldn't reach Docker's pipe, holding Node's name for the error. */
export const DIAL_ERROR_HEADER = 'x-wirescry-dial-error';

export interface PipeHelperOptions {
  /** The helper executable. */
  executable: string;
  /** The pipe Docker clients connect to (\\.\pipe\name, or a socket path off Windows, in tests). */
  listenPath: string;
  log?: (message: string) => void;
  /** Called when problem() changes. */
  onChange?: () => void;
}

/**
 * The Windows transport. Docker there ends each direction of an attached stream (stdin's end,
 * the end of a container's output) with a zero-length message on its message-mode named pipe,
 * which Node can neither see nor send, and Node can only serve byte-mode pipes, which clients
 * can't half-close. So `wirescry-docker-pipe.exe` (native/docker-pipe, Go with go-winio, as
 * Docker itself uses) does the pipe ends, and talks to the relay over TCP on 127.0.0.1, where
 * Node passes half-closes on:
 *
 *   Docker client ─pipe─▶ helper ─TCP─▶ relay (this side's listen())
 *   relay (connect()) ─TCP─▶ helper ─pipe─▶ Docker
 *
 * Both TCP hops start with a random token, made for each run and held in memory: other
 * programs on this computer can reach 127.0.0.1 too, and must not reach Docker through it.
 */
export class PipeHelper implements RelayTransport {
  private readonly token = randomBytes(TOKEN_SIZE);
  private gate?: net.Server;
  private child?: ChildProcess;
  private back?: { host: string; port: number };
  private stopped = false;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private error?: string;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: PipeHelperOptions) {}

  async listen(server: http.Server): Promise<void> {
    const gate = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) =>
      this.admit(socket, server),
    );
    await new Promise<void>((resolve, reject) => {
      gate.once('error', reject);
      gate.listen(0, '127.0.0.1', () => {
        gate.off('error', reject);
        resolve();
      });
    });
    gate.on('error', (error) => this.log(`relay port: ${error.message}`));
    this.gate = gate;
    try {
      await this.spawn();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Hands a connection from the helper to the relay's server once it has sent the token. */
  private admit(socket: net.Socket, server: http.Server): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), TOKEN_TIMEOUT_MS);
    let admitted = false;
    const onReadable = (): void => {
      // Exactly the token; the request after it stays buffered for the server.
      const got = socket.read(TOKEN_SIZE) as Buffer | null;
      if (!got) return;
      socket.off('readable', onReadable);
      clearTimeout(timer);
      if (got.length !== TOKEN_SIZE || !timingSafeEqual(got, this.token)) {
        socket.destroy();
        return;
      }
      admitted = true;
      socket.pause();
      server.emit('connection', socket);
    };
    socket.on('readable', onReadable);
    socket.once('end', () => {
      // Ended before the whole token: nothing to hand on.
      if (!admitted) socket.destroy();
    });
  }

  connect(socketPath: string): net.Socket {
    const back = this.back;
    if (!back) {
      const socket = new net.Socket();
      const error = Object.assign(new Error(this.error ?? "Wirescry's Docker helper isn't running."), {
        code: 'EHELPER',
      });
      process.nextTick(() => socket.destroy(error));
      return socket;
    }
    const socket = net.connect({ ...back, allowHalfOpen: false });
    // Queued until connected, ahead of whatever the caller writes.
    socket.write(Buffer.concat([this.token, Buffer.from(`${socketPath}\n`)]));
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }

  problem(): string | undefined {
    return this.error;
  }

  private setError(error: string | undefined): void {
    if (error === this.error) return;
    this.error = error;
    this.options.onChange?.();
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => console.log(`[wirescry] docker helper: ${m}`)))(message);
  }

  private spawn(): Promise<void> {
    const gate = this.gate?.address();
    if (!gate || typeof gate === 'string') return Promise.reject(new Error('The relay port is closed.'));
    const startedAt = Date.now();
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.options.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        reject(error as Error);
        return;
      }
      this.child = child;
      let answered = false;
      let started = false;
      const settle = (error?: Error): void => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error("Wirescry's Docker helper didn't start."));
        child.kill();
      }, START_TIMEOUT_MS);
      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (answered) return;
        out += chunk;
        const end = out.indexOf('\n');
        if (end < 0) return;
        let reply: { back?: unknown; error?: unknown } = {};
        try {
          reply = JSON.parse(out.slice(0, end)) as typeof reply;
        } catch {
          // Reported below.
        }
        const match = typeof reply.back === 'string' ? /^127\.0\.0\.1:(\d+)$/.exec(reply.back) : null;
        if (match) {
          this.back = { host: '127.0.0.1', port: Number(match[1]) };
          started = true;
          this.setError(undefined);
          settle();
        } else {
          settle(
            new Error(
              typeof reply.error === 'string'
                ? `Wirescry's Docker helper couldn't start: ${reply.error}`
                : `Wirescry's Docker helper said: ${out.slice(0, end)}`,
            ),
          );
          child.kill();
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) if (line) this.log(line);
      });
      child.once('error', (error) => settle(error));
      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
          this.back = undefined;
        }
        settle(new Error(`Wirescry's Docker helper stopped (${signal ?? `exit code ${code}`}).`));
        // One that didn't start is the caller's to deal with (see restart()).
        if (this.stopped || !started) return;
        if (Date.now() - startedAt > STEADY_MS) this.restarts = 0;
        this.log(`stopped (${signal ?? `exit code ${code}`}).`);
        this.restart(`Wirescry's Docker helper stopped. Starting it again…`);
      });
      // The helper stops when its stdin closes, which is also what happens if Wirescry dies.
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(
        `${JSON.stringify({
          listen: this.options.listenPath,
          relay: `127.0.0.1:${gate.port}`,
          token: this.token.toString('hex'),
        })}\n`,
      );
    });
  }

  /**
   * Starts the helper again after a while, as it stopped by itself or couldn't start again:
   * Docker commands fail until it's back. Says why meanwhile.
   */
  private restart(why: string): void {
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)]!;
    this.restarts += 1;
    this.setError(why);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopped) return;
      this.spawn().catch((error: Error) => {
        if (this.stopped) return;
        this.log(error.message);
        this.restart(error.message);
      });
    }, delay);
    this.restartTimer.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    this.back = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.stdin?.end();
      const kill = setTimeout(() => child.kill(), 2_000);
      await exited;
      clearTimeout(kill);
    }
    const gate = this.gate;
    this.gate = undefined;
    if (gate) await new Promise<void>((resolve) => gate.close(() => resolve()));
  }
}
