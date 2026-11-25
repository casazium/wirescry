/**
 * Shared by the Java agent's tests (test/java-agent*.test.ts): finding Java, building the agent
 * once per test file, a fresh agent folder per test, and running JVMs that are always cleaned up.
 *
 * Needs a JDK 17 or later (JAVA_HOME, else PATH) to build the jars, which also attaches. The
 * programs run on that JDK, or on each Java in WIRESCRY_JAVA_TARGETS (a list of java executables,
 * separated by the path delimiter), which the Java agent workflow sets to Java 8 through 25. It
 * attaches with WIRESCRY_JAVA_ATTACHER if set (a JDK 11+ java).
 * WIRESCRY_REQUIRE_JAVA=1 makes a missing JDK fail the run instead of skipping it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, onTestFinished } from 'vitest';
import { buildJavaAgent, jdkTool } from '../scripts/build-java-agent.mjs';
import {
  installAgentJars,
  readStatuses,
  writeControl,
  type AgentControl,
  type AgentStatus,
} from '../src/backend/java/agent-files';

export const javac = jdkTool('javac');
const exe = process.platform === 'win32' ? 'java.exe' : 'java';
export const buildJava = javac && path.join(path.dirname(javac), exe);
if (!buildJava && process.env.WIRESCRY_REQUIRE_JAVA === '1') {
  throw new Error('WIRESCRY_REQUIRE_JAVA=1, but no JDK 17 or later was found (set JAVA_HOME).');
}
const targets = (process.env.WIRESCRY_JAVA_TARGETS ?? '').split(path.delimiter).filter(Boolean);
/** The java that attaches: WIRESCRY_JAVA_ATTACHER (JDK 11+), else the building JDK's. */
export const attachJava = process.env.WIRESCRY_JAVA_ATTACHER || buildJava;
/** The javas the programs run on. */
export const javas = targets.length > 0 ? targets : buildJava ? [buildJava] : [];
export const posix = process.platform !== 'win32';

/** The major version a java executable reports ("1.8.0_412" is 8). */
export function majorOf(java: string): number {
  const text = spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr ?? '';
  const match = /version "(?:1\.)?(\d+)/.exec(text);
  return match ? Number(match[1]) : 0;
}

/** This test file's working folder and built jars, set by `setUpJavaAgentTests`. */
export const shared = {
  work: '',
  built: undefined as unknown as Awaited<ReturnType<typeof buildJavaAgent>>,
};
const children: ChildProcess[] = [];

/** Kills `child` after the test, like the programs `run` starts. */
export function track<T extends ChildProcess>(child: T): T {
  children.push(child);
  return child;
}

/** Builds the agent before the file's tests, and cleans up after each and after all. */
export function setUpJavaAgentTests(more?: () => Promise<void>) {
  beforeAll(async () => {
    if (!buildJava) return;
    // A space in the path, like macOS's "Application Support".
    shared.work = await mkdtemp(path.join(os.tmpdir(), 'wirescry java agent-'));
    // Each test file builds its own: files run in parallel, and a build replaces its folder.
    shared.built = await buildJavaAgent(path.join(shared.work, 'build'));
    await more?.();
  }, 180_000);

  afterEach(async () => {
    // Wait for each to exit: on Windows a JVM holds its agent's jars open, and the folder can't be
    // removed until it's gone.
    await Promise.all(
      children.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(resolve, 5000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill('SIGKILL');
          }),
      ),
    );
  });

  // The folder holds the agent's build, Byte Buddy unpacked among it: thousands of files, which take
  // Windows well over 10 s to delete. A folder left behind in the temp folder isn't a test failure.
  afterAll(async () => {
    if (shared.work)
      await rm(shared.work, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }, 120_000);
}

/** Compiles Java sources for `release` into `out`; throws with javac's message if it fails. */
export function compileJava(release: number, out: string, sources: string[], classpath?: string) {
  const result = spawnSync(
    javac!,
    [
      '--release',
      String(release),
      '-Xlint:-options',
      '-d',
      out,
      ...(classpath ? ['-cp', classpath] : []),
      ...sources,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

/** Agent folders whose heartbeat is moving ({@link agentFolder}'s `beat`), by their stub's path. */
const beating = new Map<string, { dir: string; control: () => AgentControl }>();

/**
 * A fresh `<data folder>/java-agent` with the jars installed, and the control file written.
 * With `beat`, the heartbeat moves every 2 s until the test ends, as while Wirescry runs: else a
 * test that a slow machine stretches past about 15 s finds the agent off (Wirescry taken as gone),
 * and one whose JVM took over 20 s to start finds it off from the start. Called inside a test.
 */
export async function agentFolder(change: Partial<AgentControl> = {}, options: { beat?: boolean } = {}) {
  const dir = path.join(await mkdtemp(path.join(shared.work, 'data ')), 'java-agent');
  const impl = await installAgentJars(dir, {
    stub: shared.built.stub.file,
    impl: shared.built.impl.file,
    weaver: shared.built.weaver.file,
    version: '0.0.0-test',
  });
  let control: AgentControl = {
    impl,
    enabled: true,
    startup: true,
    proxyPort: 8000,
    config: 1,
    seq: 1,
    wirescryPid: process.pid,
    statusDelayMs: 0,
    detached: [],
    ...change,
  };
  // One write at a time, each with the settings of the moment it's made: a heartbeat never puts
  // back settings a test has since changed.
  let writing = Promise.resolve();
  const write = (next: () => AgentControl) =>
    (writing = writing.then(() => {
      control = next();
      return writeControl(dir, control);
    }));
  await write(() => control);
  const folder = {
    dir,
    stub: path.join(dir, 'wirescry-agent.jar'),
    impl,
    control: () => control,
    async update(next: Partial<AgentControl>) {
      await write(() => ({ ...control, ...next, config: next.config ?? control.config + 1 }));
    },
    /**
     * Moves the heartbeat, as Wirescry does while it runs: without it the agent takes Wirescry as
     * gone after about 15 s and turns off. For tests that run longer than that, called at least that
     * often (or the folder made with `beat`).
     */
    async heartbeat() {
      await write(() => ({ ...control, seq: control.seq + 1 }));
    },
  };
  if (options.beat) {
    const timer = setInterval(() => void folder.heartbeat().catch(() => undefined), 2000);
    timer.unref();
    beating.set(folder.stub, folder);
    onTestFinished(() => {
      clearInterval(timer);
      beating.delete(folder.stub);
    });
  }
  return folder;
}

/**
 * For a JVM started with `jvm`, whose agent comes from a folder made with `beat` and should be on
 * (enabled, startup agents on, not detached): waits until its status file says it's on. A JVM a
 * slow machine took over 20 s to start finds the control file stale, and stays off until the next
 * heartbeat; tests then don't start before it's on.
 */
export async function waitForAgent(jvm: string[], pid: number | undefined): Promise<void> {
  for (const arg of jvm) {
    const stub = /^-javaagent:([^=]+)/.exec(arg)?.[1];
    const folder = stub ? beating.get(stub) : undefined;
    if (!folder) continue;
    const c = folder.control();
    if (!c.enabled || !c.startup || c.detached.length > 0) return;
    await expect.poll(async () => (await statusOf(folder.dir, pid))?.enabled, { timeout: 30_000 }).toBe(true);
  }
}

export interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
  /** When the program has exited and its output has all been read. */
  closed: Promise<void>;
  /** Writes a line to the program's stdin (for programs started with `stdin: true`). */
  send(line: string): void;
}

/** At most this much of a program's output goes into a failure's message. */
const MAX_REPORTED = 8000;
/** At most this much of a thread dump: a small program's is well under it. */
const MAX_DUMP = 60_000;

const tail = (text: string): string => (text.length > MAX_REPORTED ? `…${text.slice(-MAX_REPORTED)}` : text);

/**
 * The threads of a running JVM, from `jstack` beside its java (every JDK the tests use has one), for
 * a failure's message: it tells a hang, and where, from a slow start. Says why if there's none.
 * Asynchronous and capped at 10 s, so a JVM too stuck to answer doesn't hold up the test's own
 * timeout. Kept from the start: the order of threads differs between JDKs.
 */
export function threadDump(java: string, pid: number): Promise<string> {
  const jstack = path.join(path.dirname(java), process.platform === 'win32' ? 'jstack.exe' : 'jstack');
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(jstack, [String(pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(`(no thread dump from ${jstack}: ${error.message})`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && out.trim() !== '')
        resolve(out.length > MAX_DUMP ? `${out.slice(0, MAX_DUMP)}…` : out);
      else
        resolve(
          `(no thread dump from ${jstack}: exit ${code}, signal ${signal}${err ? `: ${tail(err)}` : ''})`,
        );
    });
  });
}

/**
 * Waits until `done()` holds for a program. If it doesn't within `timeoutMs`, or the program closes
 * its output first, fails with what happened: how long it waited, whether the program exited (and
 * how), what it printed, and for a JVM still running, its threads. Without these, a hang, a crash and
 * a slow start all read as "expected ''" or "expected 3 to be greater than 3".
 */
/**
 * How long to wait for a program to start: longer on Windows, where a fresh CI runner has been
 * seen to take over 17 s just loading Java's own libraries (its instrument library, before any of
 * the agent's code), with almost no CPU used: the file system or a scanner holding it up.
 */
export function startupMs(ms: number): number {
  return process.platform === 'win32' ? Math.max(ms, 60_000) : ms;
}

export async function waitFor(r: Run, done: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let closed = false;
  void r.closed.then(() => (closed = true));
  while (!done() && !closed && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Checked again: the output may have come in with the close, or just at the deadline.
  if (done()) return;
  const { exitCode, signalCode, pid, spawnfile } = r.child;
  const running = exitCode === null && signalCode === null;
  const state = running ? 'is still running' : `exited (code ${exitCode}, signal ${signalCode})`;
  const isJava = /^java(\.exe)?$/i.test(path.basename(spawnfile));
  const message =
    `no ${what} after ${Date.now() - started} ms; the program ${state}.\n` +
    `stdout:\n${tail(r.stdout())}\nstderr:\n${tail(r.stderr())}`;
  if (!(running && isJava && pid !== undefined)) throw new Error(message);
  // Printed before the thread dump is taken: if that takes the test past its own time limit, the
  // failure says only "Test timed out", and this would be lost.
  console.error(message);
  throw new Error(`${message}\nthreads:\n${await threadDump(spawnfile, pid)}`);
}

/** Waits until a program prints `text`, failing as {@link waitFor} does. */
export const waitForOutput = (r: Run, text: string, timeoutMs: number): Promise<void> =>
  waitFor(r, () => r.stdout().includes(text), `"${text}"`, timeoutMs);

/** A program's lines of output so far, blank ones left out. */
export const linesOf = (r: Run): string[] => r.stdout().split('\n').filter(Boolean);

/** Waits until a program has printed more than `before` lines, failing as {@link waitFor} does. */
export const waitForLines = (r: Run, before: number, timeoutMs: number): Promise<void> =>
  waitFor(r, () => linesOf(r).length > before, `line ${before + 1} of output`, timeoutMs);

export function run(
  java: string,
  args: string[],
  options: { stdin?: boolean; env?: NodeJS.ProcessEnv } = {},
): Run {
  const child = spawn(java, args, {
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    ...(options.env ? { env: options.env } : {}),
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
    closed,
    send: (line) => child.stdin!.write(`${line}\n`),
  };
}

/** Runs the attacher with `args`: its exit code, what it printed, and its JSON lines. */
export function attacher(args: string[]) {
  const result = spawnSync(attachJava!, ['-jar', shared.built.attach.file, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    code: result.status,
    /** Everything it printed, for an assertion's message. */
    why: `${result.stdout}${result.stderr}`,
    lines: result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  };
}

/** Runs the attacher, and fails with what it printed unless it exits 0. */
export function expectAttached(args: string[]) {
  const { code, why } = attacher(args);
  expect(code, why).toBe(0);
}

export async function statusOf(dir: string, pid: number | undefined): Promise<AgentStatus | undefined> {
  return (await readStatuses(dir)).find((s) => s.pid === pid);
}

export const newId = () => `t${randomBytes(6).toString('hex')}`;
