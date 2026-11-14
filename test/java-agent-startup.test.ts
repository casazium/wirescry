/**
 * The startup route in real JVMs: a program started with a Wirescry terminal's JAVA_TOOL_OPTIONS
 * loads the agent from it, and "off means direct": while the agent is off (Wirescry quit or
 * crashed, or its setting is off) the proxy properties the terminal set are cleared, so requests
 * go straight out instead of to a closed port, and they're put back, on Wirescry's port of the
 * moment, when it turns on. The program's own proxy properties are never touched.
 *
 * What it needs to run: see test/java-agent-helpers.ts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmod, rm, utimes, writeFile } from 'node:fs/promises';
import { jdkTool } from '../scripts/build-java-agent.mjs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { terminalEnv, withUserJavaOptions } from '../src/shared/terminal-env';
import {
  agentFolder,
  buildJava,
  compileJava,
  expectAttached,
  javas,
  majorOf,
  posix,
  run,
  setUpJavaAgentTests,
  shared,
  statusOf,
  track,
  type Run,
} from './java-agent-helpers';

let probes: string;
let earlyAgent: string;
setUpJavaAgentTests(async () => {
  probes = path.join(shared.work, 'startup-probes');
  compileJava(8, probes, [path.join(import.meta.dirname, 'java', 'ProxyProbe.java')]);
  // Another agent, the user's own, loaded before Wirescry's.
  const early = path.join(shared.work, 'startup-early');
  compileJava(8, early, [path.join(import.meta.dirname, 'java', 'EarlyAgent.java')]);
  await writeFile(path.join(shared.work, 'startup-early.mf'), 'Premain-Class: EarlyAgent\n');
  earlyAgent = path.join(shared.work, 'startup-early.jar');
  const jar = spawnSync(
    jdkTool('jar')!,
    ['cfm', earlyAgent, path.join(shared.work, 'startup-early.mf'), '-C', early, '.'],
    {
      encoding: 'utf8',
    },
  );
  if (jar.status !== 0) throw new Error(jar.stderr);
});

async function probe(java: string, jvm: string[], env?: NodeJS.ProcessEnv): Promise<Run> {
  const r = env
    ? wrap(java, ['-cp', probes, 'ProxyProbe'], env)
    : run(java, [...jvm, '-cp', probes, 'ProxyProbe'], { stdin: true });
  await expect.poll(r.stdout, { timeout: 15_000 }).toContain('ready');
  return r;
}

/** Like run, with an environment of its own. */
function wrap(java: string, args: string[], env: NodeJS.ProcessEnv): Run {
  const child = track(spawn(java, args, { stdio: ['pipe', 'pipe', 'pipe'], env }));
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    send: (line) => child.stdin!.write(`${line}\n`),
  };
}

async function ask(r: Run, command: string): Promise<string> {
  const before = r.stdout().split('\n').filter(Boolean).length;
  r.send(command);
  await expect
    .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  return r.stdout().split('\n').filter(Boolean)[before]!.trim();
}

/** The proxy the JDK chooses for each scheme, by the program's properties alone (nonProxyHosts cleared). */
async function chosen(r: Run): Promise<string> {
  return `${await ask(r, 'select http://example.test/')} | ${await ask(r, 'select https://example.test/')}`;
}

const props = (port: number, host = '127.0.0.1') => [
  `-Dhttp.proxyHost=${host}`,
  `-Dhttp.proxyPort=${port}`,
  `-Dhttps.proxyHost=${host}`,
  `-Dhttps.proxyPort=${port}`,
];
const at = (port: number) => `HTTP 127.0.0.1:${port} | HTTP 127.0.0.1:${port}`;
const DIRECT = 'DIRECT | DIRECT';

describe.skipIf(!buildJava)('the startup route', { timeout: 90_000 }, () => {
  for (const java of javas) {
    describe(java, () => {
      it('loads the agent from a Wirescry terminal’s JAVA_TOOL_OPTIONS, the path’s spaces and all', async () => {
        const folder = await agentFolder({ proxyPort: 7101 });
        const env = terminalEnv(
          7101,
          {
            caPath: '/x',
            bundlePath: '/x',
            phpIniDir: '/x',
            curlHome: '/x',
            javaTrustStore: '/no such/trust.jks',
          },
          'linux',
          folder.stub,
        );
        expect(folder.stub).toContain(' ');
        const r = await probe(java, [], { ...process.env, JAVA_TOOL_OPTIONS: env.JAVA_TOOL_OPTIONS });
        expect(r.stderr()).toContain('Picked up JAVA_TOOL_OPTIONS');
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.route, { timeout: 15_000 })
          .toBe('startup');
        expect(await chosen(r)).toBe(at(7101));
        // Off: straight out, not to a closed port.
        await folder.update({ enabled: false });
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(DIRECT);
      });

      it('clears Wirescry’s proxy properties while off, and puts them back on Wirescry’s new port', async () => {
        const folder = await agentFolder({ proxyPort: 7102 });
        const r = await probe(java, [...props(7102), `-javaagent:${folder.stub}=terminalPort=7102`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(at(7102));
        await folder.update({ enabled: false });
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(DIRECT);
        expect(await ask(r, 'prop http.proxyHost')).toBe('null');
        // Wirescry back, on another port: the properties themselves are back, not only the hook.
        await folder.update({ enabled: true, proxyPort: 7103, seq: folder.control().seq + 1 });
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(at(7103));
        await expect.poll(() => ask(r, 'prop https.proxyPort'), { timeout: 15_000 }).toBe('7103');
        expect(await ask(r, 'prop http.proxyHost')).toBe('127.0.0.1');
        expect(await ask(r, 'prop http.proxyPort')).toBe('7103');
        expect(await ask(r, 'prop https.proxyHost')).toBe('127.0.0.1');
      });

      it('goes direct when Wirescry isn’t running at the start', async () => {
        const folder = await agentFolder({ proxyPort: 7104, enabled: false });
        const r = await probe(java, [...props(7104), `-javaagent:${folder.stub}=terminalPort=7104`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        // Cleared before main: the first request already goes direct.
        expect(await chosen(r)).toBe(DIRECT);
      });

      it('puts the properties back when Wirescry returns with the setting off', async () => {
        const folder = await agentFolder({ proxyPort: 7121, enabled: false });
        const r = await probe(java, [...props(7121), `-javaagent:${folder.stub}=terminalPort=7121`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(DIRECT);
        await folder.update({ enabled: true, startup: false, seq: folder.control().seq + 1 });
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
          .toBe('startup-off');
        // The hook is off: only the properties send it to Wirescry.
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(at(7121));
      });

      it('keeps the properties when only the setting is off: Wirescry still runs', async () => {
        const folder = await agentFolder({ proxyPort: 7114 });
        const r = await probe(java, [...props(7114), `-javaagent:${folder.stub}=terminalPort=7114`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        await folder.update({ startup: false });
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
          .toBe('startup-off');
        expect(await chosen(r)).toBe(at(7114));
      });

      it('goes direct from the first request when the control file stopped being written', async () => {
        const folder = await agentFolder({ proxyPort: 7115 });
        // Wirescry crashed a minute ago: its file is still there, saying on.
        const when = new Date(Date.now() - 60_000);
        await utimes(path.join(folder.dir, 'control.properties'), when, when);
        const r = await probe(java, [...props(7115), `-javaagent:${folder.stub}=terminalPort=7115`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(DIRECT);
        // Wirescry back: its heartbeat moves, and the agent stays on after.
        await folder.update({ seq: folder.control().seq + 1 });
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(at(7115));
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect((await statusOf(folder.dir, r.child.pid))?.reason).toBe('on');
        expect(await chosen(r)).toBe(at(7115));
      });

      it.runIf(posix)(
        'keeps the properties when it refuses the control file: it can’t tell Wirescry is gone',
        async () => {
          const folder = await agentFolder({ proxyPort: 7116 });
          const r = await probe(java, [...props(7116), `-javaagent:${folder.stub}=terminalPort=7116`]);
          expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
          await chmod(path.join(folder.dir, 'control.properties'), 0o660);
          await expect
            .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
            .toBe('unsafe-files');
          expect(await chosen(r)).toBe(at(7116));
        },
      );

      it('keeps the properties through a damaged control file', async () => {
        const folder = await agentFolder({ proxyPort: 7117 });
        const r = await probe(java, [...props(7117), `-javaagent:${folder.stub}=terminalPort=7117`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        await writeFile(path.join(folder.dir, 'control.properties'), 'enabled=true\n', { mode: 0o600 });
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
          .toBe('bad-control');
        expect(await chosen(r)).toBe(at(7117));
      });

      it('goes direct when the control file is deleted while it runs', async () => {
        const folder = await agentFolder({ proxyPort: 7118 });
        const r = await probe(java, [...props(7118), `-javaagent:${folder.stub}=terminalPort=7118`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(at(7118));
        await rm(path.join(folder.dir, 'control.properties'));
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(DIRECT);
      });

      it('loads after the user’s own agent, from a Wirescry terminal’s value with theirs in front', async () => {
        const folder = await agentFolder({ proxyPort: 7119 });
        const env = terminalEnv(
          7119,
          {
            caPath: '/x',
            bundlePath: '/x',
            phpIniDir: '/x',
            curlHome: '/x',
            javaTrustStore: '/no such/trust.jks',
          },
          'linux',
          folder.stub,
        );
        const value = withUserJavaOptions(`-javaagent:"${earlyAgent}" -Dmine=1`, env.JAVA_TOOL_OPTIONS!);
        expect(value.startsWith(`-javaagent:"${earlyAgent}" -Dmine=1 -Dhttp.proxyHost=`)).toBe(true);
        const r = await probe(java, [], { ...process.env, JAVA_TOOL_OPTIONS: value });
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
          .toBe('on');
        expect(await chosen(r)).toBe(at(7119));
      });

      it('fits what JDK 8 reads of JAVA_TOOL_OPTIONS: 1,023 bytes, not 1,024', async () => {
        const padded = (total: number) => {
          const base = '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7120 -Dpad=';
          return base + 'p'.repeat(total - base.length);
        };
        for (const [total, read] of [
          [1023, true],
          [1024, majorOf(java) > 8],
        ] as const) {
          const r = await probe(java, [], { ...process.env, JAVA_TOOL_OPTIONS: padded(total) });
          expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
          expect(await ask(r, 'select http://example.test/'), `${total} bytes`).toBe(
            read ? 'HTTP 127.0.0.1:7120' : 'DIRECT',
          );
        }
      });

      it('changes nothing without a control file, which names the agent to load', async () => {
        // Only if the file is deleted: Wirescry leaves it, saying off, when it quits.
        const folder = await agentFolder({ proxyPort: 7105 });
        await import('node:fs/promises').then((fs) => fs.rm(path.join(folder.dir, 'control.properties')));
        const r = await probe(java, [...props(7105), `-javaagent:${folder.stub}=terminalPort=7105`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(at(7105));
      });

      it('follows Wirescry to a new port while on', async () => {
        const folder = await agentFolder({ proxyPort: 7107 });
        // The terminal was opened when Wirescry was on 7106.
        const r = await probe(java, [...props(7106), `-javaagent:${folder.stub}=terminalPort=7106`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(at(7107));
      });

      it('leaves the program’s own proxy alone, on this computer or not', async () => {
        for (const own of [props(3128), props(7108, 'proxy.company.test')]) {
          const folder = await agentFolder({ proxyPort: 7108, enabled: false });
          const r = await probe(java, [...own, `-javaagent:${folder.stub}=terminalPort=7108`]);
          expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
          const expected = own[0]!.endsWith('127.0.0.1')
            ? at(3128)
            : 'HTTP proxy.company.test:7108 | HTTP proxy.company.test:7108';
          const reason = () => statusOf(folder.dir, r.child.pid).then((s) => s?.reason);
          await expect.poll(reason, { timeout: 15_000 }).toBe('off');
          expect(await chosen(r)).toBe(expected);
          await folder.update({ enabled: true });
          await expect.poll(reason, { timeout: 15_000 }).toBe('on');
          expect(await chosen(r)).toBe(expected);
          await folder.update({ enabled: false });
          await expect.poll(reason, { timeout: 15_000 }).toBe('off');
          expect(await chosen(r)).toBe(expected);
        }
      });

      it('never puts back what the program replaced meanwhile', async () => {
        const folder = await agentFolder({ proxyPort: 7109, enabled: false });
        const r = await probe(java, [...props(7109), `-javaagent:${folder.stub}=terminalPort=7109`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(DIRECT);
        // The program sets its own https proxy.
        expect(await ask(r, 'set https.proxyHost proxy.company.test')).toBe('set');
        expect(await ask(r, 'set https.proxyPort 3128')).toBe('set');
        await folder.update({ enabled: true });
        await expect
          .poll(() => chosen(r), { timeout: 15_000 })
          .toBe('HTTP 127.0.0.1:7109 | HTTP proxy.company.test:3128');
      });

      it('ignores a bad terminal port, and still knows the control file’s', async () => {
        const folder = await agentFolder({ proxyPort: 7110, enabled: false });
        const r = await probe(java, [
          ...props(7110),
          `-javaagent:${folder.stub}=terminalPort=99999,terminalPort=x`,
        ]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(DIRECT);
      });

      it('leaves an attached program’s properties alone', async () => {
        const folder = await agentFolder({ proxyPort: 7111 });
        const r = await probe(java, props(7111));
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expectAttached(['load', String(r.child.pid), folder.stub, 'id=a1']);
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
          .toBe('on');
        await folder.update({ enabled: false });
        await expect
          .poll(async () => (await statusOf(folder.dir, r.child.pid))?.reason, { timeout: 15_000 })
          .toBe('off');
        expect(await chosen(r)).toBe(at(7111));
      });

      it.runIf(majorOf(java) >= 9)('goes direct within seconds of a Wirescry crash', async () => {
        // A process that's gone: the agent checks Wirescry's pid on Java 9+.
        const gone = spawn(process.execPath, ['-e', '0']);
        await new Promise((resolve) => gone.on('exit', resolve));
        const folder = await agentFolder({ proxyPort: 7112 });
        const r = await probe(java, [...props(7112), `-javaagent:${folder.stub}=terminalPort=7112`]);
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        expect(await chosen(r)).toBe(at(7112));
        await folder.update({ wirescryPid: gone.pid!, seq: folder.control().seq + 1 });
        await expect.poll(() => chosen(r), { timeout: 15_000 }).toBe(DIRECT);
      });
    });
  }
});
