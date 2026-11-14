import { execFile } from 'node:child_process';

/**
 * Running Wirescry's attacher (native/java-agent/attach/com/wirescry/attach/Main.java) with a JDK
 * findJdk found. It prints one JSON object per line; anything else is taken as a failure, never
 * guessed at.
 */

/** A running JVM, as the attacher lists it: its main class or jar name, never its arguments. */
export interface ListedJvm {
  pid: number;
  name: string;
}

export type LoadResult =
  | { ok: true; java: string; javaHome: string }
  | { ok: false; reason: string; message?: string; java?: string };

export interface RunResult {
  code: number | null;
  stdout: string;
  /** Set when it ran out of time, or couldn't start. */
  error?: string;
}

/** Runs `java -jar <attacher> ...args`. For tests, replaced with a fake. */
export type RunAttacher = (
  java: string,
  jar: string,
  args: string[],
  timeoutMs: number,
) => Promise<RunResult>;

export const LIST_TIMEOUT_MS = 10_000;
export const LOAD_TIMEOUT_MS = 60_000;

export const runAttacher: RunAttacher = (java, jar, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      java,
      ['-jar', jar, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        const failed = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        if (failed && typeof failed.code !== 'number') {
          resolve({
            code: null,
            stdout: stdout ?? '',
            error: failed.killed ? `it didn't finish within ${timeoutMs / 1000} s` : failed.message,
          });
          return;
        }
        resolve({ code: failed ? (failed.code as unknown as number) : 0, stdout: stdout ?? '' });
      },
    );
  });

/** The attacher's JSON lines, or undefined if any line isn't a JSON object. */
export function jsonLines(stdout: string): Array<Record<string, unknown>> | undefined {
  const lines: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    lines.push(value as Record<string, unknown>);
  }
  return lines;
}

const PID = /^[0-9]{1,18}$/;
/** What the attacher may print as a name: one line, no control characters, at most 200. */
const goodName = (name: string): boolean =>
  name.length <= 200 && ![...name].some((c) => c < ' ' || c === '\u007f');

/** The list the attacher printed, or why it's refused. */
export function parseList(result: RunResult): ListedJvm[] | string {
  if (result.error) return `Listing Java programs failed: ${result.error}`;
  const lines = jsonLines(result.stdout);
  if (result.code !== 0 || !lines)
    return "Listing Java programs failed: the attacher's answer wasn't readable";
  const jvms: ListedJvm[] = [];
  for (const line of lines) {
    const { pid, name } = line;
    if (typeof pid !== 'string' || !PID.test(pid) || typeof name !== 'string' || !goodName(name)) {
      return "Listing Java programs failed: the attacher's answer wasn't readable";
    }
    const n = Number(pid);
    if (!Number.isSafeInteger(n) || n < 1)
      return "Listing Java programs failed: the attacher's answer wasn't readable";
    jvms.push({ pid: n, name });
  }
  return jvms;
}

const REASON = /^[a-z0-9-]{1,40}$/;
const short = (value: unknown, max = 500) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** What a load came to. A run that ended without one well-formed answer is a failure. */
export function parseLoad(result: RunResult): LoadResult {
  if (result.error) return { ok: false, reason: 'attacher-failed', message: result.error };
  const lines = jsonLines(result.stdout);
  const line = lines?.length === 1 ? lines[0] : undefined;
  if (!line) {
    return { ok: false, reason: 'attacher-failed', message: "The attacher's answer wasn't readable." };
  }
  if (line.ok === true && result.code === 0) {
    return { ok: true, java: short(line.java, 64) ?? '', javaHome: short(line.javaHome, 1024) ?? '' };
  }
  if (line.ok === false && result.code !== 0 && typeof line.reason === 'string' && REASON.test(line.reason)) {
    return {
      ok: false,
      reason: line.reason,
      ...(short(line.message) !== undefined ? { message: short(line.message) } : {}),
      ...(short(line.java, 64) !== undefined ? { java: short(line.java, 64) } : {}),
    };
  }
  return { ok: false, reason: 'attacher-failed', message: "The attacher's answer wasn't readable." };
}

export interface Attacher {
  list(): Promise<ListedJvm[] | string>;
  /**
   * Loads the agent (the stub at `stub`) into `pid` with id `agentId`. Unless `warnOk`, stops
   * short of loading into Java 21 or later, answering reason `needs-confirmation`.
   */
  load(pid: number, stub: string, agentId: string, warnOk: boolean): Promise<LoadResult>;
}

export function attacher(java: string, jar: string, run: RunAttacher = runAttacher): Attacher {
  return {
    async list() {
      return parseList(await run(java, jar, ['list'], LIST_TIMEOUT_MS));
    },
    async load(pid, stub, agentId, warnOk) {
      if (!Number.isSafeInteger(pid) || pid < 1) return { ok: false, reason: 'bad-pid' };
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return { ok: false, reason: 'bad-id' };
      return parseLoad(
        await run(
          java,
          jar,
          ['load', String(pid), stub, `id=${agentId}`, warnOk ? 'warn-ok' : 'ask'],
          LOAD_TIMEOUT_MS,
        ),
      );
    },
  };
}
