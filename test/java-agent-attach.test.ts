/**
 * Attaching Wirescry's Java agent to running programs, Wirescry's side (src/backend/java/jdk.ts,
 * attacher.ts, programs.ts, attach-manager.ts, and detach in agent-host.ts), without a JVM: fake
 * JDK folders, a fake attacher and hand-written status files. test/java-agent-attach-jvm.test.ts runs
 * the real thing.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../src/backend/java/agent-files';
import { JavaAgentHost, readDetached } from '../src/backend/java/agent-host';
import { attachNote, JavaAttach } from '../src/backend/java/attach-manager';
import {
  attacher,
  jsonLines,
  parseList,
  parseLoad,
  type Attacher,
  attacherEnv,
  type ListedJvm,
  type LoadResult,
  type RunAttacher,
} from '../src/backend/java/attacher';
import {
  checkJdk,
  findJdk,
  majorOf,
  minimumAttachJava,
  parseJavaHomeList,
  parseRelease,
} from '../src/backend/java/jdk';
import { processAlive, programsOf, StatusReader, STATUS_STALE_MS } from '../src/backend/java/programs';

let work: string;
let pem: string;
const posix = process.platform !== 'win32';
const javaExe = posix ? 'java' : 'java.exe';

beforeAll(async () => {
  // Real: a JDK found on PATH is named by its real path (macOS's temp folder is a link).
  work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wirescry attach-')));
  pem = (await generateCACertificate()).cert;
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A fake Java home: a release file and an empty bin/java. */
async function javaHome(name: string, release: string | null, withJava = true): Promise<string> {
  const home = path.join(work, name);
  await mkdir(path.join(home, 'bin'), { recursive: true });
  if (release !== null) await writeFile(path.join(home, 'release'), release);
  // Both names: some tests ask as another system.
  if (withJava) for (const name of ['java', 'java.exe']) await writeFile(path.join(home, 'bin', name), '');
  return home;
}

const JDK21 = 'JAVA_VERSION="21.0.2"\nMODULES="java.base java.instrument jdk.attach jdk.jdwp.agent"\n';
const JDK11 = 'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="11.0.22"\nMODULES="java.base jdk.attach"\n';
const JDK17 = 'JAVA_VERSION="17.0.10"\nMODULES="java.base java.instrument jdk.attach"\n';
const JRE17 = 'JAVA_VERSION="17.0.10"\nMODULES="java.base java.instrument java.logging"\n';
const JAVA8 = 'JAVA_VERSION="1.8.0_402"\nOS_NAME="Darwin"\n';

describe('finding a JDK that can attach', () => {
  it('reads versions and release files', () => {
    expect(majorOf('1.8.0_402')).toBe(8);
    expect(majorOf('11.0.22')).toBe(11);
    expect(majorOf('21')).toBe(21);
    expect(majorOf('25-ea')).toBe(25);
    expect(majorOf('')).toBe(0);
    expect(majorOf('banana')).toBe(0);
    const fields = parseRelease(`${JDK21}SOURCE=".:git:abc"\r\nBAD LINE\n`);
    expect(fields.get('JAVA_VERSION')).toBe('21.0.2');
    expect(fields.get('MODULES')).toContain('jdk.attach');
    expect(fields.get('SOURCE')).toBe('.:git:abc');
    expect(fields.has('BAD LINE')).toBe(false);
  });

  it('takes a JDK 17 or later with jdk.attach, or 11 on Windows', async () => {
    const home = await javaHome('jdk21', JDK21);
    expect(await checkJdk(home, 'JAVA_HOME')).toEqual({
      home,
      java: path.join(home, 'bin', javaExe),
      version: '21.0.2',
      major: 21,
      from: 'JAVA_HOME',
    });
    expect(await checkJdk(await javaHome('jdk17', JDK17), 'PATH')).toMatchObject({ major: 17 });
    // 11 sends SIGQUIT without checking the process catches it: not on Linux or macOS.
    const jdk11 = await javaHome('jdk11', JDK11);
    expect(await checkJdk(jdk11, 'PATH', 'linux')).toMatch(/attaching needs Java 17 or later/);
    expect(await checkJdk(jdk11, 'PATH', 'darwin')).toMatch(/attaching needs Java 17 or later/);
    expect(await checkJdk(jdk11, 'PATH', 'win32')).toMatchObject({ major: 11 });
    expect(minimumAttachJava('win32')).toBe(11);
    expect(minimumAttachJava('linux')).toBe(17);
  });

  it('passes over Java 8, a runtime without jdk.attach, a folder without a release file or java', async () => {
    expect(await checkJdk(await javaHome('java8', JAVA8), 'PATH', 'win32')).toMatch(
      /Java 1\.8\.0_402; attaching needs Java 11/,
    );
    expect(await checkJdk(await javaHome('jre17', JRE17), 'PATH')).toMatch(/without the jdk\.attach module/);
    expect(await checkJdk(await javaHome('norelease', null), 'PATH')).toMatch(/no release file/);
    expect(await checkJdk(await javaHome('nojava', JDK21, false), 'PATH')).toMatch(/has no bin/);
    // jdk.attachment isn't jdk.attach.
    expect(
      await checkJdk(await javaHome('lookalike', 'JAVA_VERSION="21"\nMODULES="jdk.attachment"\n'), 'PATH'),
    ).toMatch(/without the jdk\.attach module/);
  });

  it('looks in JAVA_HOME, then PATH, saying why it passed each over', async () => {
    const jre = await javaHome('path-jre', JRE17);
    const jdk = await javaHome('path-jdk', JDK17);
    const env = {
      JAVA_HOME: await javaHome('home-java8', JAVA8),
      PATH: [path.join(jre, 'bin'), 'relative/bin', path.join(jdk, 'bin')].join(posix ? ':' : ';'),
    };
    const found = await findJdk({ env, platform: process.platform, javaHomeList: async () => '' });
    expect(found.jdk).toMatchObject({ home: jdk, from: 'PATH', major: 17 });
    expect(found.passed).toHaveLength(2);
    expect(found.passed[0]).toContain('home-java8');
    expect(found.passed[1]).toContain('path-jre');

    const first = await findJdk({
      env: { JAVA_HOME: jdk, PATH: path.join(jre, 'bin') },
      platform: process.platform,
    });
    expect(first.jdk).toMatchObject({ home: jdk, from: 'JAVA_HOME' });
  });

  it.skipIf(!posix)('follows a java on PATH that links into a JDK', async () => {
    const jdk = await javaHome('linked-jdk', JDK21);
    const bin = path.join(work, 'links', 'bin');
    await mkdir(bin, { recursive: true });
    await symlink(path.join(jdk, 'bin', 'java'), path.join(bin, 'java'));
    const found = await findJdk({ env: { PATH: bin }, platform: 'linux' });
    expect(found.jdk).toMatchObject({ from: 'PATH', major: 21 });
    expect(found.jdk?.home).toBe(jdk);
  });

  it('finds nothing where there is nothing, and never asks java_home off macOS', async () => {
    const list = vi.fn(async () => '');
    const none = await findJdk({ env: {}, platform: 'linux', javaHomeList: list });
    expect(none).toEqual({ passed: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it.skipIf(!posix)('on macOS, skips the /usr/bin/java placeholder and asks java_home', async () => {
    const jdk = await javaHome('mac-jdk', JDK21);
    const java8 = await javaHome('mac-java8', JAVA8);
    const output = [
      'Matching Java Virtual Machines (2):',
      `    1.8.0_402 (x86_64) "Eclipse Adoptium" - "OpenJDK 8" ${java8}`,
      `    21.0.2 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.2" ${jdk}`,
      jdk,
    ].join('\n');
    expect(parseJavaHomeList(output)).toEqual([java8, jdk]);
    const found = await findJdk({
      env: { PATH: '/usr/bin' },
      platform: 'darwin',
      javaHomeList: async () => output,
    });
    expect(found.jdk).toMatchObject({ home: jdk, from: 'java_home' });
    // /usr/bin/java isn't looked at at all.
    expect(found.passed.join('\n')).not.toContain('/usr');
    expect(found.passed[0]).toContain('mac-java8');
  });
});

describe('reading the attacher', () => {
  const ran = (stdout: string, code: number | null = 0, error?: string) => ({ code, stdout, error });

  it('takes JSON object lines only', () => {
    expect(jsonLines('{"a":1}\n\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonLines('{"a":1}\nWarning: something\n')).toBeUndefined();
    expect(jsonLines('[1]')).toBeUndefined();
    expect(jsonLines('null')).toBeUndefined();
    expect(jsonLines('"text"')).toBeUndefined();
  });

  it('lists programs by pid and name', () => {
    expect(parseList(ran('{"pid":"42","name":"Main"}\n{"pid":"7","name":"app.jar"}\n'))).toEqual([
      { pid: 42, name: 'Main' },
      { pid: 7, name: 'app.jar' },
    ]);
    expect(parseList(ran(''))).toEqual([]);
  });

  it('refuses a list with junk, bad pids or names, a failed exit, or a timeout', () => {
    for (const bad of [
      ran('{"pid":"42","name":"Main"}\nPicked up JAVA_TOOL_OPTIONS: -Dx=1\n'),
      ran('{"pid":42,"name":"Main"}'),
      ran('{"pid":"0","name":"Main"}'),
      ran('{"pid":"-1","name":"Main"}'),
      ran('{"pid":"99999999999999999999","name":"Main"}'),
      ran('{"pid":"42","name":"Ma\\u0007in"}'),
      ran(`{"pid":"42","name":"${'x'.repeat(201)}"}`),
      ran('{"pid":"42"}'),
      ran('{"pid":"42","name":"Main"}', 1),
      ran('', null, "it didn't finish within 10 s"),
    ]) {
      expect(typeof parseList(bad), JSON.stringify(bad)).toBe('string');
    }
    expect(parseList(ran('', null, "it didn't finish within 10 s"))).toContain("didn't finish");
  });

  it('reads a load: success, a reason, or junk', () => {
    expect(parseLoad(ran('{"ok":true,"java":"17.0.2","javaHome":"/jdk"}'))).toEqual({
      ok: true,
      java: '17.0.2',
      javaHome: '/jdk',
    });
    expect(parseLoad(ran('{"ok":false,"reason":"needs-confirmation","java":"21.0.1"}', 3))).toEqual({
      ok: false,
      reason: 'needs-confirmation',
      java: '21.0.1',
    });
    expect(parseLoad(ran('{"ok":false,"reason":"attach-failed","message":"denied"}', 1))).toMatchObject({
      reason: 'attach-failed',
      message: 'denied',
    });
    // Junk, two answers, an answer that disagrees with the exit code, or a strange reason.
    for (const bad of [
      ran('loaded'),
      ran('{"ok":true}\n{"ok":true}'),
      ran('{"ok":true}', 1),
      ran('{"ok":false,"reason":"x"}', 0),
      ran('{"ok":false,"reason":"Not A Reason!"}', 1),
      ran('{"ok":"yes"}'),
      ran('', null, 'spawn ENOENT'),
    ]) {
      expect(parseLoad(bad), JSON.stringify(bad)).toMatchObject({ ok: false, reason: 'attacher-failed' });
    }
  });

  it('runs list and load with the right arguments, and refuses a bad pid or id without running', async () => {
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const run: RunAttacher = async (_java, _jar, args, timeout) => {
      calls.push({ args, timeout });
      return ran(args[0] === 'list' ? '' : '{"ok":true,"java":"17","javaHome":"/j"}');
    };
    const tool = attacher('/jdk/bin/java', '/res/wirescry-attach.jar', run);
    await tool.list();
    await tool.load(42, '/data/wirescry-agent.jar', 'abc', false);
    await tool.load(43, '/data/wirescry-agent.jar', 'abc', true);
    expect(calls).toEqual([
      { args: ['list'], timeout: 10_000 },
      { args: ['load', '42', '/data/wirescry-agent.jar', 'id=abc', 'ask'], timeout: 60_000 },
      { args: ['load', '43', '/data/wirescry-agent.jar', 'id=abc', 'warn-ok'], timeout: 60_000 },
    ]);
    expect(await tool.load(0, '/s.jar', 'abc', true)).toMatchObject({ reason: 'bad-pid' });
    expect(await tool.load(1.5, '/s.jar', 'abc', true)).toMatchObject({ reason: 'bad-pid' });
    expect(await tool.load(5, '/s.jar', 'a,b', true)).toMatchObject({ reason: 'bad-id' });
    expect(await tool.load(5, '/s.jar', '', true)).toMatchObject({ reason: 'bad-id' });
    expect(calls).toHaveLength(3);
  });
});

/** A status file's text, as the agent writes it (Status.java). */
function statusText(s: Partial<AgentStatus> & { pid: number; id: string; beat: number }): string {
  const lines = [
    'protocol=1',
    `agentVersion=${s.agentVersion ?? '1.0.0'}`,
    `route=${s.route ?? 'attach'}`,
    `id=${s.id}`,
    `pid=${s.pid}`,
    `java=${s.java ?? '17.0.2'}`,
    `enabled=${s.enabled ?? true}`,
    `reason=${s.reason ?? 'on'}`,
    `appliedConfig=${s.appliedConfig ?? 5}`,
    'port=8000',
    `hooks=${(s.hooks ?? ['trust:applied']).join(',')}`,
    `beat=${s.beat}`,
    'end=1',
  ];
  return `${lines.join('\n')}\n`;
}

describe('the status files', () => {
  let dir: string;
  let now: number;
  let alive: Set<number>;
  const write = async (s: Parameters<typeof statusText>[0], ageMs = 0) => {
    const file = path.join(dir, 'status', `${s.pid}-${s.id}.properties`);
    await writeFile(file, statusText(s));
    const t = new Date(now - ageMs);
    await utimes(file, t, t);
    return file;
  };
  const names = () => readdir(path.join(dir, 'status')).then((n) => n.sort());

  afterEach(() => vi.restoreAllMocks());

  const reader = () => new StatusReader(dir, { now: () => now, alive: (pid) => alive.has(pid) });

  const setUp = async () => {
    dir = await mkdtemp(path.join(work, 'agent '));
    await mkdir(path.join(dir, 'status'));
    now = Date.now();
    alive = new Set([100, 200, 300]);
  };

  it('shows agents whose beat moves, and stops showing one whose beat stands still', async () => {
    await setUp();
    const r = reader();
    await write({ pid: 100, id: 'a1', beat: 1 });
    expect((await r.read()).live.map((s) => s.id)).toEqual(['a1']);
    now += STATUS_STALE_MS - 1000;
    expect((await r.read()).live.map((s) => s.id)).toEqual(['a1']);
    now += 2000;
    const { live, present } = await r.read();
    expect(live).toEqual([]);
    // Its program still runs (paused at a breakpoint, say): still known, and its file stays.
    expect([...present!]).toEqual(['a1']);
    expect(await names()).toEqual(['100-a1.properties']);
    // It writes again: shown again.
    await write({ pid: 100, id: 'a1', beat: 2 });
    expect((await r.read()).live.map((s) => s.id)).toEqual(['a1']);
  });

  it('never shows an old file first seen, as for a pid a new program reuses', async () => {
    await setUp();
    await write({ pid: 200, id: 'old', beat: 9 }, STATUS_STALE_MS + 5000);
    await write({ pid: 300, id: 'new', beat: 1 }, 1000);
    const { live, present } = await reader().read();
    expect(live.map((s) => s.id)).toEqual(['new']);
    expect([...present!].sort()).toEqual(['new', 'old']);
  });

  it('deletes the files of programs that ended, and old temporary or damaged files', async () => {
    await setUp();
    await write({ pid: 100, id: 'live', beat: 1 });
    await write({ pid: 999, id: 'gone', beat: 1 });
    const tmpOld = path.join(dir, 'status', '100-x.tmp');
    const tmpNew = path.join(dir, 'status', '100-y.tmp');
    const damagedOld = path.join(dir, 'status', '100-bad.properties');
    const damagedNew = path.join(dir, 'status', '100-half.properties');
    const mismatched = path.join(dir, 'status', '200-other.properties');
    for (const file of [tmpOld, tmpNew, damagedOld, damagedNew]) await writeFile(file, 'protocol=1\n');
    await writeFile(mismatched, statusText({ pid: 300, id: 'other', beat: 1 }));
    const old = new Date(now - 200_000);
    await utimes(tmpOld, old, old);
    await utimes(damagedOld, old, old);
    const { live, present } = await reader().read();
    expect(live.map((s) => s.id)).toEqual(['live']);
    // Every id whose program runs, by the file's name, whether or not its file could be read.
    expect([...present!].sort()).toEqual(['bad', 'half', 'live', 'other', 'x', 'y']);
    expect(await names()).toEqual([
      '100-half.properties',
      '100-live.properties',
      '100-y.tmp',
      '200-other.properties',
    ]);
    // Other files in the folder are never touched.
    await writeFile(path.join(dir, 'status', 'notes.txt'), 'x');
    await utimes(path.join(dir, 'status', 'notes.txt'), old, old);
    await reader().read();
    expect(await names()).toContain('notes.txt');
  });

  it('knows nothing of a folder it can’t read, and no agents in one that isn’t there', async () => {
    await setUp();
    await rm(path.join(dir, 'status'), { recursive: true });
    expect(await reader().read()).toEqual({ live: [], running: [], present: new Set() });
    if (posix && process.getuid?.() !== 0) {
      await mkdir(path.join(dir, 'status'));
      await write({ pid: 100, id: 'a1', beat: 1 });
      await chmod(path.join(dir, 'status'), 0o000);
      try {
        expect(await reader().read()).toEqual({ live: [], running: [], present: undefined });
      } finally {
        await chmod(path.join(dir, 'status'), 0o700);
      }
    }
  });
});

describe('the list of programs', () => {
  const status = (s: Partial<AgentStatus> & { pid: number; id: string }): AgentStatus => ({
    agentVersion: '1.0.0',
    route: 'attach',
    java: '17.0.2',
    enabled: true,
    reason: 'on',
    appliedConfig: 5,
    hooks: [],
    beat: 1,
    ...s,
  });

  it('merges the attacher’s list with the agents, by pid', () => {
    const programs = programsOf({
      listed: [
        { pid: 30, name: 'Plain' },
        { pid: 10, name: 'app.jar' },
      ],
      statuses: [
        status({ pid: 10, id: 'a1' }),
        // Not listed (another user's, say): still shown, nameless.
        status({ pid: 20, id: 's1', route: 'startup', appliedConfig: 4, agentVersion: '0.9.0' }),
      ],
      config: 5,
      version: '1.0.0',
      detached: new Set(),
    });
    expect(programs).toEqual([
      {
        pid: 10,
        name: 'app.jar',
        agent: {
          id: 'a1',
          route: 'attach',
          on: true,
          reason: 'on',
          java: '17.0.2',
          current: true,
          hooks: [],
        },
      },
      {
        pid: 20,
        name: '',
        agent: {
          id: 's1',
          route: 'startup',
          on: true,
          reason: 'on',
          java: '17.0.2',
          current: false,
          hooks: [],
          outdated: true,
        },
      },
      { pid: 30, name: 'Plain' },
    ]);
  });

  it('shows the agent that runs when a program has two, and a detach on its way', () => {
    const programs = programsOf({
      listed: undefined,
      statuses: [
        status({ pid: 10, id: 'second', enabled: false, reason: 'off' }),
        status({ pid: 10, id: 'first' }),
        status({ pid: 11, id: 'x' }),
      ],
      config: 5,
      version: '1.0.0',
      detached: new Set(['x']),
    });
    expect(programs.map((p) => [p.pid, p.agent?.id, p.agent?.reason])).toEqual([
      [10, 'first', 'on'],
      [11, 'x', 'detaching'],
    ]);
  });
});

describe('detaching, in the control file', () => {
  const settings = { proxyPort: 8000, caPath: '/ca.pem', caPem: '', startup: false };
  let jars: { stub: string; impl: string; weaver: string; attach: string };
  const hosts: JavaAgentHost[] = [];

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(work, 'jars '));
    jars = {
      stub: path.join(dir, 'stub.jar'),
      impl: path.join(dir, 'impl.jar'),
      weaver: path.join(dir, 'weaver.jar'),
      attach: path.join(dir, 'attach.jar'),
    };
    for (const file of Object.values(jars)) await writeFile(file, file);
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop().catch(() => undefined);
  });

  const start = async (dir: string) => {
    const host = await JavaAgentHost.start(
      { dir, jars, version: '1.0.0', heartbeatMs: 60_000 },
      { ...settings, caPem: pem },
    );
    hosts.push(host);
    return host;
  };
  const detachedLine = async (dir: string) =>
    /^detached=(.*)$/m.exec(await readFile(path.join(dir, 'control.properties'), 'utf8'))?.[1];

  it('turns agents off and on, keeps them off across a restart, and forgets ended programs', async () => {
    const dir = path.join(await mkdtemp(path.join(work, 'data ')), 'java-agent');
    const host = await start(dir);
    const config = host.currentConfig;
    await host.setDetached({ off: ['b2', 'a1'] });
    expect(await detachedLine(dir)).toBe('a1,b2');
    // Detaching doesn't change what an applied agent sends where.
    expect(host.currentConfig).toBe(config);
    await host.setDetached({ on: ['b2'] });
    expect(await detachedLine(dir)).toBe('a1');
    await host.setDetached({ off: ['c3'] });
    await host.stop();
    hosts.length = 0;

    expect(await readDetached(dir)).toEqual(['a1', 'c3']);
    const again = await start(dir);
    expect([...again.detachedIds].sort()).toEqual(['a1', 'c3']);
    expect(await detachedLine(dir)).toBe('a1,c3');
    // a1's program ended; c3's runs.
    await again.setDetached({ keep: new Set(['c3', 'zz']) });
    expect(await detachedLine(dir)).toBe('c3');
    // A turn-off in the same change as a keep that doesn't know it yet stays.
    await again.setDetached({ off: ['d4'], keep: new Set(['c3']) });
    expect(await detachedLine(dir)).toBe('c3,d4');
  });

  it('keeps every detached id across a restart, however many', async () => {
    const dir = path.join(await mkdtemp(path.join(work, 'data ')), 'java-agent');
    const host = await start(dir);
    const ids = Array.from({ length: 1500 }, (_, i) => `id${String(i).padStart(4, '0')}`);
    await host.setDetached({ off: ids });
    await host.stop();
    hosts.length = 0;
    expect(await readDetached(dir)).toEqual(ids);
  });

  it('reads no ids from a missing file or bad ones, and does nothing once stopped', async () => {
    const dir = path.join(await mkdtemp(path.join(work, 'data ')), 'java-agent');
    expect(await readDetached(dir)).toEqual([]);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'control.properties'), 'detached=ok1,../bad,,also_ok\r\nend=1\n');
    expect(await readDetached(dir)).toEqual(['ok1', 'also_ok']);
    const host = await start(dir);
    await host.stop();
    await host.setDetached({ off: ['late'] });
    expect(await detachedLine(dir)).toBe('also_ok,ok1');
  });
});

describe('attaching, from Setup', () => {
  const realHosts: JavaAgentHost[] = [];
  let hostJars: { stub: string; impl: string; weaver: string; attach: string };

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(work, 'jars '));
    hostJars = {
      stub: path.join(dir, 'stub.jar'),
      impl: path.join(dir, 'impl.jar'),
      weaver: path.join(dir, 'weaver.jar'),
      attach: path.join(dir, 'attach.jar'),
    };
    for (const file of Object.values(hostJars)) await writeFile(file, file);
  });

  afterEach(async () => {
    for (const host of realHosts.splice(0)) await host.stop().catch(() => undefined);
  });

  /** A stand-in host: what JavaAttach uses of one. */
  function fakeHost() {
    const detached = new Set<string>();
    const calls: unknown[] = [];
    const host = {
      stubPath: '/data/java-agent/wirescry-agent.jar',
      currentConfig: 5,
      detachedIds: detached,
      async setDetached(change: { off?: string[]; on?: string[]; keep?: ReadonlySet<string> }) {
        calls.push(change);
        for (const id of change.on ?? []) detached.delete(id);
        for (const id of change.off ?? []) detached.add(id);
      },
    };
    return { host: host as unknown as JavaAgentHost, calls, detached };
  }

  interface SetUpOptions {
    /** A real host in this folder, instead of the stand-in. */
    realHost?: boolean;
    list?: () => Promise<ListedJvm[] | string>;
    alive?: Set<number>;
    now?: () => number;
  }

  async function setUp(
    load: (pid: number, warnOk: boolean) => LoadResult | Promise<LoadResult>,
    jdk = true,
    options: SetUpOptions = {},
  ) {
    const dir = path.join(await mkdtemp(path.join(work, 'agent ')), 'java-agent');
    await mkdir(path.join(dir, 'status'), { recursive: true });
    const fake = fakeHost();
    const host = options.realHost
      ? await JavaAgentHost.start(
          { dir, jars: hostJars, version: '1.0.0', heartbeatMs: 60_000 },
          { proxyPort: 8000, caPath: '/ca.pem', caPem: pem, startup: false },
        )
      : fake.host;
    if (options.realHost) realHosts.push(host);
    const { calls, detached } = fake;
    const finds = { count: 0 };
    let warningOk = false;
    const loads: Array<{ pid: number; stub: string; id: string; warnOk: boolean }> = [];
    const tool: Attacher = {
      list: options.list ?? (async () => [{ pid: 4242, name: 'Main' }]),
      load: async (pid, stub, id, warnOk) => {
        loads.push({ pid, stub, id, warnOk });
        return load(pid, warnOk);
      },
    };
    const changed = vi.fn();
    const manager = new JavaAttach({
      dir,
      attachJar: '/res/wirescry-attach.jar',
      version: '1.0.0',
      host: async () => host,
      warningOk: () => warningOk,
      saveWarningOk: async () => {
        warningOk = true;
      },
      changed,
      findJdk: async () => {
        finds.count++;
        return jdk
          ? {
              jdk: { home: '/jdk', java: '/jdk/bin/java', version: '21.0.2', major: 21, from: 'JAVA_HOME' },
              passed: [],
            }
          : { passed: ['/old is Java 8'] };
      },
      attacher: () => tool,
      statusReader: {
        alive: (pid) => options.alive?.has(pid) ?? true,
        ...(options.now ? { now: options.now } : {}),
      },
      pollMs: 60_000,
    });
    const writeStatus = (s: Parameters<typeof statusText>[0]) =>
      writeFile(path.join(dir, 'status', `${s.pid}-${s.id}.properties`), statusText(s));
    return {
      manager,
      loads,
      calls,
      detached,
      changed,
      writeStatus,
      warningOk: () => warningOk,
      host,
      dir,
      finds,
    };
  }

  it('lists programs once asked, and says which JDK attaches', async () => {
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }));
    expect(t.manager.status()).toBeUndefined();
    const status = await t.manager.refresh();
    expect(status).toEqual({
      state: 'ready',
      jdk: { home: '/jdk', version: '21.0.2' },
      programs: [{ pid: 4242, name: 'Main' }],
      warningOk: false,
    });
    expect(t.changed).toHaveBeenCalled();
    t.manager.stop();
  });

  it('says no JDK, with why each place was passed over', async () => {
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }), false);
    expect(await t.manager.refresh()).toEqual({
      state: 'no-jdk',
      passed: ['/old is Java 8'],
      programs: [],
      warningOk: false,
    });
    await expect(t.manager.attach(4242, false)).rejects.toThrow(/didn't find a JDK it can attach with/);
    expect(t.loads).toEqual([]);
    t.manager.stop();
  });

  it('asks before Java 21’s warning, once, then attaches with a fresh id', async () => {
    const t = await setUp((_pid, warnOk) =>
      warnOk
        ? { ok: true, java: '21.0.2', javaHome: '/j' }
        : { ok: false, reason: 'needs-confirmation', java: '21.0.2' },
    );
    expect(await t.manager.attach(4242, false)).toEqual({ needsConfirmation: 'java-warning' });
    expect(t.warningOk()).toBe(false);
    expect(await t.manager.attach(4242, true)).toEqual({ attached: true });
    expect(t.warningOk()).toBe(true);
    expect(await t.manager.attach(4242, false)).toEqual({ attached: true });
    expect(t.loads.map((l) => l.warnOk)).toEqual([false, true, true]);
    expect(t.loads[1]!.stub).toBe('/data/java-agent/wirescry-agent.jar');
    expect(t.loads[1]!.id).toMatch(/^a[0-9a-f]{18}$/);
    expect(t.loads[2]!.id).not.toBe(t.loads[1]!.id);
    t.manager.stop();
  });

  it('turns a detached agent back on instead of loading another', async () => {
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }));
    await t.writeStatus({ pid: 4242, id: 'a1', beat: 1, enabled: false, reason: 'detached' });
    t.detached.add('a1');
    expect(await t.manager.attach(4242, false)).toEqual({ attached: true });
    expect(t.loads).toEqual([]);
    expect(t.detached.has('a1')).toBe(false);
    t.manager.stop();
  });

  it('won’t turn on a startup agent the setting keeps off, and says why', async () => {
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }));
    await t.writeStatus({
      pid: 4242,
      id: 's1',
      beat: 1,
      route: 'startup',
      enabled: false,
      reason: 'startup-off',
    });
    await expect(t.manager.attach(4242, false)).rejects.toThrow(/follows the setting/);
    expect(t.loads).toEqual([]);
    expect(t.manager.status()?.programs[0]?.note).toMatch(/follows the setting/);
    t.manager.stop();
  });

  it('notes why an attach was refused, on the program', async () => {
    const t = await setUp(() => ({ ok: false, reason: 'dynamic-loading-disabled', message: 'x' }));
    await t.manager.refresh();
    await expect(t.manager.attach(4242, true)).rejects.toThrow(/EnableDynamicAgentLoading/);
    const program = t.manager.status()!.programs[0]!;
    expect(program.note).toMatch(/EnableDynamicAgentLoading/);
    expect(program.busy).toBeUndefined();
    await expect(t.manager.attach(-1, true)).rejects.toThrow(/Not a process id/);
    t.manager.stop();
  });

  it('detaches the agents in a program, and refuses a program without one', async () => {
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }));
    await expect(t.manager.detach(4242)).rejects.toThrow(/isn't running in this program/);
    await t.writeStatus({ pid: 4242, id: 'a1', beat: 1 });
    await t.manager.detach(4242);
    expect([...t.detached]).toEqual(['a1']);
    expect(t.calls).toContainEqual({ off: ['a1'] });
    await expect(t.manager.detach(Number.NaN)).rejects.toThrow(/Not a process id/);
    t.manager.stop();
  });

  const detachedIn = async (dir: string) =>
    /^detached=(.*)$/m.exec(await readFile(path.join(dir, 'control.properties'), 'utf8'))?.[1];

  it('keeps a program detached through files it can’t read, until the program ends', async () => {
    const alive = new Set([4242]);
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }), true, { realHost: true, alive });
    await t.writeStatus({ pid: 4242, id: 'a1', beat: 1 });
    await t.manager.detach(4242);
    expect(await detachedIn(t.dir)).toBe('a1');
    // A newer agent's format, then half a file, then a folder that can't be read: still detached.
    await writeFile(path.join(t.dir, 'status', '4242-a1.properties'), 'protocol=2\nend=1\n');
    await t.manager.refresh();
    expect(await detachedIn(t.dir)).toBe('a1');
    await writeFile(path.join(t.dir, 'status', '4242-a1.properties'), 'protocol=1\nid=a');
    await t.manager.refresh();
    expect(await detachedIn(t.dir)).toBe('a1');
    if (posix && process.getuid?.() !== 0) {
      await chmod(path.join(t.dir, 'status'), 0o000);
      try {
        await t.manager.refresh();
        expect(await detachedIn(t.dir)).toBe('a1');
      } finally {
        await chmod(path.join(t.dir, 'status'), 0o700);
      }
    }
    // The program ends: its id goes, and so does its file.
    alive.delete(4242);
    await t.manager.refresh();
    expect(await detachedIn(t.dir)).toBe('');
    expect(await readdir(path.join(t.dir, 'status'))).toEqual([]);
    t.manager.stop();
  });

  it('turns on, or off, a paused program’s agent that stopped writing', async () => {
    let now = Date.now();
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }), true, { now: () => now });
    await t.writeStatus({ pid: 4242, id: 'a1', beat: 1 });
    await t.manager.refresh();
    now += STATUS_STALE_MS + 5000;
    await t.manager.refresh();
    // Not shown: it isn't writing.
    expect(t.manager.status()!.programs[0]!.agent).toBeUndefined();
    await t.manager.detach(4242);
    expect([...t.detached]).toEqual(['a1']);
    expect(await t.manager.attach(4242, false)).toEqual({ attached: true });
    // The same agent turned back on; no second one loaded.
    expect(t.loads).toEqual([]);
    expect([...t.detached]).toEqual([]);
    t.manager.stop();
  });

  it('turns on the agent that runs, of a program with two', async () => {
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }));
    await t.writeStatus({ pid: 4242, id: 'second', beat: 1, enabled: false, reason: 'off' });
    await t.writeStatus({ pid: 4242, id: 'first', beat: 1 });
    await t.manager.attach(4242, false);
    expect(t.calls).toContainEqual({ on: ['first'] });
    t.manager.stop();
  });

  it('does one thing to a program at a time', async () => {
    let finish: (result: LoadResult) => void = () => undefined;
    const t = await setUp(
      () =>
        new Promise<LoadResult>((resolve) => {
          finish = resolve;
        }),
    );
    const attaching = t.manager.attach(4242, true);
    await expect.poll(() => t.loads.length).toBe(1);
    expect(t.manager.status()!.programs.find((p) => p.pid === 4242)?.busy).toBe('attaching');
    await expect(t.manager.attach(4242, true)).rejects.toThrow(/already doing something/);
    await expect(t.manager.detach(4242)).rejects.toThrow(/already doing something/);
    // Still attaching: the refused Detach didn't clear it.
    expect(t.manager.status()!.programs.find((p) => p.pid === 4242)?.busy).toBe('attaching');
    finish({ ok: true, java: '17', javaHome: '/j' });
    expect(await attaching).toEqual({ attached: true });
    expect(t.manager.status()!.programs.find((p) => p.pid === 4242)?.busy).toBeUndefined();
    t.manager.stop();
  });

  it('shows a refused program it doesn’t list, until a list without it', async () => {
    let listed: ListedJvm[] = [];
    const t = await setUp(() => ({ ok: false, reason: 'not-a-jvm' }), true, { list: async () => listed });
    await t.manager.refresh();
    await expect(t.manager.attach(777, true)).rejects.toThrow(/doesn't list this process/);
    expect(t.manager.status()!.programs).toEqual([
      { pid: 777, name: '', note: expect.stringMatching(/doesn't list this process/) },
    ]);
    listed = [{ pid: 1, name: 'Other' }];
    await t.manager.refresh();
    expect(t.manager.status()!.programs).toEqual([{ pid: 1, name: 'Other' }]);
    t.manager.stop();
  });

  it('looks for a JDK, and lists, once for refreshes asked together', async () => {
    let lists = 0;
    const t = await setUp(() => ({ ok: true, java: '17', javaHome: '/j' }), true, {
      list: async () => {
        lists++;
        return [{ pid: 4242, name: 'Main' }];
      },
    });
    const [a, b] = await Promise.all([t.manager.refresh(), t.manager.refresh()]);
    expect(a).toEqual(b);
    expect(t.finds.count).toBe(1);
    expect(lists).toBe(1);
    expect(a.state).toBe('ready');
    await t.manager.refresh();
    expect(t.finds.count).toBe(2);
    t.manager.stop();
  });

  it('counts a process as running when only another user may signal it', () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(processAlive(1, fail('EPERM'))).toBe(true);
    expect(processAlive(1, fail('ESRCH'))).toBe(false);
    expect(processAlive(1, () => undefined)).toBe(true);
  });

  it('runs the attacher without the JVM option variables, in any case', () => {
    expect(
      attacherEnv({
        PATH: '/bin',
        JAVA_TOOL_OPTIONS: '-javaagent:/x.jar',
        _JAVA_OPTIONS: '-Xlog:all',
        jdk_java_options: '-verbose:class',
        Classpath: '/evil',
        JAVA_HOME: '/jdk',
      }),
    ).toEqual({ PATH: '/bin', JAVA_HOME: '/jdk' });
  });

  it('words each refusal for the user', () => {
    const denied = { ok: false as const, reason: 'attach-failed', message: 'Permission denied' };
    expect(attachNote(denied, 'win32')).toMatch(
      /didn't let Wirescry attach \(Permission denied\).*as administrator, or by another user/,
    );
    // Elsewhere another user's programs aren't listed at all (not-a-jvm), so that isn't the cause.
    expect(attachNote(denied, 'linux')).not.toMatch(/administrator|another user/);
    expect(attachNote(denied, 'linux')).toMatch(/DisableAttachMechanism/);
    expect(
      attachNote({
        ok: false,
        reason: 'attach-not-supported',
        message: 'The VM does not respond within 10000ms',
      }),
    ).toMatch(/didn't answer in time: it may be paused in a debugger/);
    expect(attachNote({ ok: false, reason: 'not-a-jvm' })).toMatch(/-XX:-UsePerfData/);
    // No doubled full stop.
    expect(attachNote({ ok: false, reason: 'load-failed', message: 'it broke.' })).toMatch(/\(it broke\)\./);
    expect(attachNote({ ok: false, reason: 'agent-init-failed' })).toMatch(/didn't load Wirescry's agent\./);
    expect(attachNote({ ok: false, reason: 'attacher-failed', message: 'timeout' })).toBe(
      'Attaching failed (timeout).',
    );
  });
});
