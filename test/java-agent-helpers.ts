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
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
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
const attachJava = process.env.WIRESCRY_JAVA_ATTACHER || buildJava;
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

/** A fresh `<data folder>/java-agent` with the jars installed, and the control file written. */
export async function agentFolder(change: Partial<AgentControl> = {}) {
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
  await writeControl(dir, control);
  return {
    dir,
    stub: path.join(dir, 'wirescry-agent.jar'),
    impl,
    control: () => control,
    async update(next: Partial<AgentControl>) {
      control = { ...control, ...next, config: next.config ?? control.config + 1 };
      await writeControl(dir, control);
    },
  };
}

export interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
  /** Writes a line to the program's stdin (for programs started with `stdin: true`). */
  send(line: string): void;
}

export function run(java: string, args: string[], options: { stdin?: boolean } = {}): Run {
  const child = spawn(java, args, { stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
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
