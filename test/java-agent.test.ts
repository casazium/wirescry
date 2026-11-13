/**
 * Wirescry's Java agent (native/java-agent) in real JVMs: loaded at startup and attached, with the
 * control and status files (src/backend/java/agent-files.ts) as Wirescry writes and reads them.
 *
 * Needs a JDK 17 or later (JAVA_HOME, else PATH) to build the jars, which also attaches. The
 * programs run on that JDK, or on each Java in WIRESCRY_JAVA_TARGETS (a list of java executables,
 * separated by the path delimiter), which the Java agent workflow sets to Java 8 through 25. It
 * attaches with WIRESCRY_JAVA_ATTACHER if set (a JDK 11+ java).
 * WIRESCRY_REQUIRE_JAVA=1 makes a missing JDK fail the run instead of skipping it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildJavaAgent, jdkTool } from '../scripts/build-java-agent.mjs';
import {
  installAgentJars,
  readStatuses,
  writeControl,
  writeWhole,
  type AgentControl,
  type AgentStatus,
} from '../src/backend/java/agent-files';

const javac = jdkTool('javac');
const exe = process.platform === 'win32' ? 'java.exe' : 'java';
const buildJava = javac && path.join(path.dirname(javac), exe);
if (!buildJava && process.env.WIRESCRY_REQUIRE_JAVA === '1') {
  throw new Error('WIRESCRY_REQUIRE_JAVA=1, but no JDK 17 or later was found (set JAVA_HOME).');
}
const targets = (process.env.WIRESCRY_JAVA_TARGETS ?? '').split(path.delimiter).filter(Boolean);
/** The java that attaches: WIRESCRY_JAVA_ATTACHER (JDK 11+), else the building JDK's. */
const attachJava = process.env.WIRESCRY_JAVA_ATTACHER || buildJava;
const javas = targets.length > 0 ? targets : buildJava ? [buildJava] : [];
const posix = process.platform !== 'win32';
/** The agent reports the version it was built as: package.json's. */
const { version } = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

/** The major version a java executable reports ("1.8.0_412" is 8). */
function majorOf(java: string): number {
  const text = spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr ?? '';
  const match = /version "(?:1\.)?(\d+)/.exec(text);
  return match ? Number(match[1]) : 0;
}

const PROBE = `
import java.io.*;
import java.util.*;
public class Probe {
  public static void main(String[] args) throws Exception {
    System.out.println("started");
    // Programs dump their system properties; the agent must leave nothing there that breaks it.
    System.getProperties().list(new PrintStream(new ByteArrayOutputStream()));
    System.getProperties().store(new ByteArrayOutputStream(), null);
    Thread.sleep(Long.parseLong(args[0]));
    System.out.println("done");
  }
}
`;

let work: string;
let progDir: string;
let built: Awaited<ReturnType<typeof buildJavaAgent>>;
const children: ChildProcess[] = [];

beforeAll(async () => {
  if (!buildJava) return;
  // A space in the path, like macOS's "Application Support".
  work = await mkdtemp(path.join(os.tmpdir(), 'wirescry java agent-'));
  built = buildJavaAgent();
  progDir = path.join(work, 'prog');
  await writeFile(path.join(work, 'Probe.java'), PROBE);
  // Compiled for Java 8, so every target runs it.
  const run = spawnSync(
    javac!,
    ['--release', '8', '-Xlint:-options', '-d', progDir, path.join(work, 'Probe.java')],
    {
      encoding: 'utf8',
    },
  );
  if (run.status !== 0) throw new Error(run.stderr);
}, 120_000);

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

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true, maxRetries: 5 });
});

/** A fresh `<data folder>/java-agent` with the jars installed, and the control file written. */
async function agentFolder(change: Partial<AgentControl> = {}) {
  const dir = path.join(await mkdtemp(path.join(work, 'data ')), 'java-agent');
  const impl = await installAgentJars(dir, {
    stub: built.stub.file,
    impl: built.impl.file,
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
      control = { ...control, ...next };
      await writeControl(dir, control);
    },
  };
}

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

function run(java: string, args: string[]): Run {
  const child = spawn(java, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
}

const probe = (java: string, ms: number, extra: string[] = [], programArgs: string[] = []) =>
  run(java, [...extra, '-cp', progDir, 'Probe', String(ms), ...programArgs]);

/** Waits until the program has printed "started", so it's running main. */
async function started(r: Run) {
  await expect.poll(r.stdout, { timeout: 10_000 }).toContain('started');
}

function attacher(args: string[]) {
  const result = spawnSync(attachJava!, ['-jar', built.attach.file, ...args], {
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
function expectAttached(args: string[]) {
  const { code, why } = attacher(args);
  expect(code, why).toBe(0);
}

async function statusOf(dir: string, pid: number | undefined): Promise<AgentStatus | undefined> {
  return (await readStatuses(dir)).find((s) => s.pid === pid);
}

const newId = () => `t${randomBytes(6).toString('hex')}`;

describe.skipIf(!buildJava)('the Java agent', () => {
  it('builds the same jars from the same sources, on one machine', () => {
    expect(buildJavaAgent().impl.sha256).toBe(built.impl.sha256);
  }, 120_000);

  it('decides whether Wirescry is alive by the rules, with a fake process table', () => {
    const out = path.join(work, 'liveness-check');
    const compiled = spawnSync(
      javac!,
      [
        '--release',
        '8',
        '-Xlint:-options',
        '-cp',
        built.impl.file,
        '-d',
        out,
        path.join(import.meta.dirname, 'java', 'LivenessCheck.java'),
      ],
      { encoding: 'utf8' },
    );
    expect(compiled.stderr).toBe('');
    const result = spawnSync(
      buildJava!,
      ['-cp', [built.impl.file, out].join(path.delimiter), 'com.wirescry.agent.impl.LivenessCheck'],
      { encoding: 'utf8' },
    );
    expect(result.stdout).not.toContain('FAIL');
    expect(result.stdout.match(/^ok /gm)).toHaveLength(12);
    expect(result.status).toBe(0);
  });

  for (const java of javas) {
    const major = majorOf(java);
    describe(`on Java ${major}`, () => {
      it('starts with the program, reads its settings before main, and reports', async () => {
        const agent = await agentFolder();
        const r = probe(java, 1500, [`-javaagent:${agent.stub}`]);
        await started(r);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({
            route: 'startup',
            enabled: true,
            reason: 'on',
            appliedConfig: 1,
            port: 8000,
            agentVersion: version,
          });
        expect(await r.exit).toBe(0);
        expect(r.stdout()).toBe(`started${os.EOL}done${os.EOL}`);
        expect(r.stderr()).toBe('');
      });

      it('adds little to a program’s start', async () => {
        const agent = await agentFolder({ statusDelayMs: undefined });
        const time = async (extra: string[]) => {
          const begin = performance.now();
          expect(await probe(java, 0, extra).exit).toBe(0);
          return performance.now() - begin;
        };
        const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
        await time([]); // warm the file cache
        const plain: number[] = [];
        const withAgent: number[] = [];
        for (let i = 0; i < 5; i++) {
          plain.push(await time([]));
          withAgent.push(await time([`-javaagent:${agent.stub}`]));
        }
        const cost = median(withAgent) - median(plain);
        console.log(
          `Java ${major}: start ${median(plain).toFixed(0)} ms, with the agent ${cost.toFixed(0)} ms more`,
        );
        // Generous, for slow CI machines: it's tens of milliseconds on a laptop.
        expect(cost).toBeLessThan(1000);
      }, 60_000);

      it.skipIf(major < 11)('leaves class-data sharing on: no warning in the program’s output', async () => {
        // A shared archive of our own, like the one most JDKs ship (this test's may not), made for
        // runs with an agent (java.instrument). Appending to the bootstrap class path would make
        // HotSpot warn on every start.
        const archive = path.join(work, `classes-${major}.jsa`);
        const dump = spawnSync(
          java,
          [
            '-Xshare:dump',
            '--add-modules',
            'java.instrument',
            `-XX:SharedArchiveFile=${archive}`,
            '-cp',
            progDir,
          ],
          { encoding: 'utf8' },
        );
        expect(dump.status, dump.stderr).toBe(0);
        const agent = await agentFolder();
        const r = probe(java, 1500, [
          `-XX:SharedArchiveFile=${archive}`,
          '-Xshare:auto',
          `-javaagent:${agent.stub}`,
        ]);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: true });
        expect(await r.exit).toBe(0);
        expect(r.stderr()).toBe('');
        expect(r.stdout()).toBe(`started${os.EOL}done${os.EOL}`);
      });

      it('follows a change of port, and turns off for a program started with startup agents off', async () => {
        const agent = await agentFolder();
        const r = probe(java, 8000, [`-javaagent:${agent.stub}`]);
        await started(r);
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ appliedConfig: 1 });
        await agent.update({ config: 2, proxyPort: 9001, seq: 2 });
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid))
          .toMatchObject({ appliedConfig: 2, port: 9001 });
        await agent.update({ config: 3, startup: false, seq: 3 });
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid))
          .toMatchObject({
            enabled: false,
            reason: 'startup-off',
          });
      });

      it('doesn’t write a status file for a short program, nor before main', async () => {
        const agent = await agentFolder({ statusDelayMs: undefined }); // 5 s, like javac
        const r = probe(java, 300, [`-javaagent:${agent.stub}`]);
        expect(await r.exit).toBe(0);
        expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
        // Asked to write at once, it still waits for the control thread's first read, after main.
        await agent.update({ statusDelayMs: 0 });
        const quick = probe(java, 300, [`-javaagent:${agent.stub}`]);
        expect(await quick.exit).toBe(0);
        expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
      });

      it('never stops a program: a missing agent jar, or names Wirescry would never write', async () => {
        const agent = await agentFolder();
        const file = path.join(agent.dir, 'control.properties');
        const good = await readFile(file, 'utf8');
        // Written by hand: formatControl refuses all but the first.
        // A folder whose name passes the prefix check, for a name that climbs back out of it.
        await mkdir(path.join(agent.dir, 'jars', 'wirescry-agent-impl-0'), { mode: 0o700 });
        for (const impl of [
          'jars/wirescry-agent-impl-0.0.0-missing.jar',
          'jars/evil.jar',
          `jars/../${agent.impl}`,
          `jars/wirescry-agent-impl-0/../${path.basename(agent.impl)}`,
        ]) {
          await writeWhole(file, good.replace(/impl=.*/, `impl=${impl}`));
          // Long enough for a loaded agent's first status file (a second in), had it loaded.
          const r = probe(java, 2000, [`-javaagent:${agent.stub}`]);
          expect(await r.exit).toBe(0);
          expect(r.stdout()).toBe(`started${os.EOL}done${os.EOL}`);
          expect(r.stderr()).toBe('');
          expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
        }
      });

      it('never loads the agent from a control file naming it twice', async () => {
        const agent = await agentFolder();
        const file = path.join(agent.dir, 'control.properties');
        const good = await readFile(file, 'utf8');
        // Had the stub taken the second name, the agent would load, find the key twice, and write
        // a status file after its default 5 s.
        const names = `jars/wirescry-agent-impl-0.0.0-missing.jar\nimpl=${agent.impl}`;
        await writeWhole(file, good.replace(/impl=.*/, `impl=${names}`));
        const r = probe(java, 6500, [`-javaagent:${agent.stub}`]);
        expect(await r.exit).toBe(0);
        expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
      });

      it('ignores keys it doesn’t know, and turns off for a protocol it doesn’t or a key given twice', async () => {
        const agent = await agentFolder();
        const file = path.join(agent.dir, 'control.properties');
        const good = await readFile(file, 'utf8');
        // From a newer Wirescry that only added a key.
        await writeWhole(file, good.replace('end=1', 'newerSetting=yes\nend=1'));
        const r = probe(java, 1500, [`-javaagent:${agent.stub}`]);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid))
          .toMatchObject({ enabled: true, reason: 'on' });
        expect(await r.exit).toBe(0);
        await writeWhole(file, good.replace('end=1', 'enabled=false\nend=1'));
        const twice = probe(java, 7000, [`-javaagent:${agent.stub}`]);
        await started(twice);
        await expect
          .poll(() => statusOf(agent.dir, twice.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: false, reason: 'bad-control' });
        expect(await twice.exit).toBe(0);
        await writeWhole(file, good.replace('protocol=1', 'protocol=2'));
        // Without good settings, the status file waits the default 5 s.
        const r2 = probe(java, 7000, [`-javaagent:${agent.stub}`]);
        await started(r2);
        await expect
          .poll(() => statusOf(agent.dir, r2.child.pid), { timeout: 10_000 })
          .toMatchObject({
            enabled: false,
            reason: 'bad-control',
          });
        expect(await r2.exit).toBe(0);
      });

      it.skipIf(!posix)('refuses files other users can change, and the program still runs', async () => {
        const agent = await agentFolder();
        await chmod(agent.dir, 0o770);
        // Each runs long enough for a loaded agent's first status file (a second in).
        const r = probe(java, 2000, [`-javaagent:${agent.stub}`]);
        expect(await r.exit).toBe(0);
        expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
        await chmod(agent.dir, 0o700);
        await chmod(path.join(agent.dir, agent.impl), 0o666);
        const r2 = probe(java, 2000, [`-javaagent:${agent.stub}`]);
        expect(await r2.exit).toBe(0);
        expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
        // A link in place of the jar, even to a private copy: a link could be pointed elsewhere.
        const copy = path.join(path.dirname(agent.dir), 'copy.jar');
        await rename(path.join(agent.dir, agent.impl), copy);
        await chmod(copy, 0o600);
        await symlink(copy, path.join(agent.dir, agent.impl));
        const r3 = probe(java, 2000, [`-javaagent:${agent.stub}`]);
        expect(await r3.exit).toBe(0);
        expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
      });

      it.skipIf(!posix)('turns off when the control file becomes writable by others', async () => {
        const agent = await agentFolder();
        const r = probe(java, 8000, [`-javaagent:${agent.stub}`]);
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        // Writable by others only (not the group), so each check is tested on its own.
        await chmod(path.join(agent.dir, 'control.properties'), 0o602);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid))
          .toMatchObject({
            enabled: false,
            reason: 'unsafe-files',
          });
      });

      it('rides out one bad read, and turns off after three or a missing file', async () => {
        const agent = await agentFolder();
        const file = path.join(agent.dir, 'control.properties');
        const r = probe(java, 15000, [`-javaagent:${agent.stub}`]);
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        const good = await readFile(file, 'utf8');
        // Half-written: no end=1. One poll sees it, then a good file returns.
        await writeWhole(file, good.replace('end=1\n', ''));
        await new Promise((resolve) => setTimeout(resolve, 1200));
        // At least one poll has seen it, and the agent is still on.
        expect(await statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true, reason: 'on' });
        await writeWhole(file, good);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(await statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true, reason: 'on' });
        await writeWhole(file, good.replace('end=1\n', ''));
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 8000 })
          .toMatchObject({
            enabled: false,
            reason: 'bad-control',
          });
        await writeWhole(file, good);
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        await rm(file);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid))
          .toMatchObject({
            enabled: false,
            reason: 'no-control',
          });
      }, 40_000);

      it.skipIf(major < 9)('turns off within seconds when Wirescry’s process is gone (Java 9+)', async () => {
        // Stands in for Wirescry's backend.
        const wirescry = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
        children.push(wirescry);
        const agent = await agentFolder({ wirescryPid: wirescry.pid });
        const r = probe(java, 15000, [`-javaagent:${agent.stub}`]);
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        wirescry.kill('SIGKILL');
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 5000 })
          .toMatchObject({
            enabled: false,
            reason: 'wirescry-gone',
          });
      });

      it('turns off when Wirescry’s heartbeat stops for 15 reads, and on when it starts again', async () => {
        // No pid: the heartbeat alone, as on Java 8.
        const agent = await agentFolder({ wirescryPid: undefined });
        const r = probe(java, 30000, [`-javaagent:${agent.stub}`]);
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        // Well inside the 15 reads, however slow the first was.
        await new Promise((resolve) => setTimeout(resolve, 8000));
        expect(await statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({
            enabled: false,
            reason: 'wirescry-gone',
          });
        await agent.update({ seq: 2 });
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
      }, 40_000);

      describe('attached', () => {
        it('lists the program by its main class only, never its arguments', async () => {
          const r = probe(java, 15000, [], ['--password=hunter2']);
          await started(r);
          const { code, lines, why } = attacher(['list']);
          expect(code, why).toBe(0);
          expect(lines).toContainEqual({ pid: String(r.child.pid), name: 'Probe' });
          expect(JSON.stringify(lines)).not.toContain('hunter2');
          // The attacher leaves itself out.
          expect(lines.every((l: { name: string }) => !l.name.includes('wirescry-attach'))).toBe(true);
        });

        it('attaches, reports, follows Detach, and a second attach changes nothing', async () => {
          const agent = await agentFolder({ startup: false });
          const r = probe(java, 20000);
          await started(r);
          const id = newId();
          const { code, lines, why } = attacher(['load', String(r.child.pid), agent.stub, `id=${id}`]);
          expect(code, why).toBe(0);
          expect(lines[0]).toMatchObject({ ok: true });
          expect(lines[0].java).toMatch(major === 8 ? /^1\.8/ : new RegExp(`^${major}`));
          // startup=false doesn't apply to an attached agent.
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid))
            .toMatchObject({
              route: 'attach',
              id,
              enabled: true,
            });
          await agent.update({ detached: [id], config: 2, seq: 2 });
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid))
            .toMatchObject({ enabled: false, reason: 'detached' });
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          await agent.update({ detached: [], config: 3, seq: 3 });
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid))
            .toMatchObject({ enabled: true, appliedConfig: 3 });
          // Still the first agent, and only one status file.
          expect((await readStatuses(agent.dir)).map((s) => s.id)).toEqual([id]);
          expect(r.stdout()).toBe(`started${os.EOL}`);
        });

        it.skipIf(major < 9)('names a program that refuses agents loaded while it runs', async () => {
          const agent = await agentFolder();
          const r = probe(java, 15000, ['-XX:-EnableDynamicAgentLoading']);
          await started(r);
          const { code, lines, why } = attacher(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          expect(code).toBe(1);
          expect(lines[0]).toMatchObject({ ok: false, reason: 'dynamic-loading-disabled' });
        });

        it('refuses bad arguments, and a pid with no JVM', async () => {
          const agent = await agentFolder();
          expect(attacher(['load', '12x', agent.stub, 'id=a']).lines[0]).toMatchObject({ reason: 'bad-pid' });
          expect(attacher(['load', '1', 'relative.jar', 'id=a']).lines[0]).toMatchObject({
            reason: 'bad-jar',
          });
          expect(attacher(['nonsense']).lines[0]).toMatchObject({ reason: 'usage' });
          // A process that exists but isn't a JVM: this test's own Node.
          const notJava = attacher(['load', String(process.pid), agent.stub, 'id=a']);
          expect(notJava.code).toBe(1);
          expect(notJava.lines[0]).toMatchObject({ ok: false });
          expect(['attach-not-supported', 'attach-failed']).toContain(notJava.lines[0].reason);
        });

        it('starts nothing for attach arguments without a good id', async () => {
          const agent = await agentFolder();
          const r = probe(java, 8000);
          await started(r);
          // A dot would make a writable file name; the others can't name a file at all.
          for (const args of ['id=bad.id', 'id=../x', 'id=', 'nonsense', 'id=a,id=b']) {
            expectAttached(['load', String(r.child.pid), agent.stub, args]);
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
          expect(await readStatuses(agent.dir)).toEqual([]);
          // Nothing written anywhere: the id would have named the status file.
          expect(await readdir(path.join(agent.dir, 'status'))).toEqual([]);
          expect((await readdir(agent.dir)).sort()).toEqual([
            'control.properties',
            'jars',
            'status',
            'wirescry-agent.jar',
          ]);
          expect((await readdir(path.dirname(agent.dir))).sort()).toEqual(['java-agent']);
          // None of them started an agent, so a good id still can.
          const id = newId();
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${id}`]);
          await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ id, enabled: true });
        });
      });
    });
  }
});
