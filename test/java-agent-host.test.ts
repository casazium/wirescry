/**
 * Wirescry's side of its Java agents while it runs (src/backend/java/agent-host.ts): the jars put
 * in the data folder, and the control file kept current — heartbeat, port, CA, the startup
 * setting, and off when Wirescry stops. Then the same with the backend, and with real JVMs.
 *
 * What the JVM tests need to run: see test/java-agent-helpers.ts.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { caSha256, pruneAgentJars, type FileOps } from '../src/backend/java/agent-files';
import { findAgentJars, JAR_NAMES, JavaAgentHost, type AgentSettings } from '../src/backend/java/agent-host';
import { createRequire } from 'node:module';
import net from 'node:net';
import { jarsIn } from '../scripts/build-java-agent.mjs';
import { rename } from 'node:fs/promises';
import { apiClient, startBackendOnPickedPort, systemPickedPort, TOKEN, UI_ORIGIN } from './helpers';
import {
  buildJava,
  compileJava,
  javas,
  run,
  setUpJavaAgentTests,
  shared,
  statusOf,
  type Run,
} from './java-agent-helpers';

let work: string;
let jars: { stub: string; impl: string; weaver: string };
let pems: string[];
const hosts: JavaAgentHost[] = [];

beforeAll(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'wirescry agent host-'));
  jars = {
    stub: path.join(work, 'stub.jar'),
    impl: path.join(work, 'impl.jar'),
    weaver: path.join(work, 'weaver.jar'),
  };
  for (const [name, file] of Object.entries(jars)) await writeFile(file, `not really a ${name} jar`);
  pems = [(await generateCACertificate()).cert, (await generateCACertificate()).cert];
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => undefined);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
});

const settings = (change: Partial<AgentSettings> = {}): AgentSettings => ({
  proxyPort: 8000,
  caPath: path.join(work, 'ca.pem'),
  caPem: pems[0]!,
  startup: false,
  ...change,
});

async function start(change: { heartbeatMs?: number; ops?: FileOps; pid?: number } = {}) {
  const dir = path.join(await mkdtemp(path.join(work, 'data ')), 'java-agent');
  const host = await JavaAgentHost.start(
    {
      dir,
      jars,
      version: '1.2.3',
      heartbeatMs: change.heartbeatMs ?? 60_000,
      ops: change.ops,
      pid: change.pid,
    },
    settings(),
  );
  hosts.push(host);
  return { dir, host };
}

/** The control file's fields. */
async function control(dir: string): Promise<Record<string, string>> {
  const text = await readFile(path.join(dir, 'control.properties'), 'utf8');
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

describe('the Java agent host', () => {
  it('installs the jars and writes the control file', async () => {
    const { dir, host } = await start({ pid: 4242 });
    expect(host.stubPath).toBe(path.join(dir, 'wirescry-agent.jar'));
    expect(await readFile(host.stubPath, 'utf8')).toBe('not really a stub jar');
    const c = await control(dir);
    expect(c).toMatchObject({
      protocol: '1',
      enabled: 'true',
      startup: 'false',
      proxyPort: '8000',
      wirescryPid: '4242',
      caSha256: caSha256(pems[0]!),
      caPath: settings().caPath,
      detached: '',
      end: '1',
    });
    expect(c.impl).toMatch(/^jars\/wirescry-agent-impl-1\.2\.3-[0-9a-f]{8}\.jar$/);
    expect(await readFile(path.join(dir, c.impl!), 'utf8')).toBe('not really a impl jar');
    expect(await readFile(path.join(dir, c.impl!.replace(/\.jar$/, '-weaver.jar')), 'utf8')).toBe(
      'not really a weaver jar',
    );
  });

  it('names this process by default', async () => {
    const { dir } = await start();
    expect((await control(dir)).wirescryPid).toBe(String(process.pid));
  });

  it('moves the heartbeat, and nothing else', async () => {
    const { dir } = await start({ heartbeatMs: 20 });
    const first = await control(dir);
    await expect.poll(async () => Number((await control(dir)).seq)).toBeGreaterThan(Number(first.seq) + 2);
    const later = await control(dir);
    expect({ ...later, seq: first.seq }).toEqual(first);
  });

  it('starts its numbers past an earlier Wirescry’s', async () => {
    const before = Date.now();
    const { dir } = await start();
    const c = await control(dir);
    // Agents in long-lived JVMs keep comparing them across Wirescry restarts.
    expect(Number(c.config)).toBeGreaterThanOrEqual(before);
    expect(Number(c.seq)).toBeGreaterThanOrEqual(before);
  });

  it('follows the port and the CA, with a new config each time', async () => {
    const { dir, host } = await start();
    const c0 = await control(dir);
    await host.update(settings({ proxyPort: 9000 }));
    const c1 = await control(dir);
    expect(c1.proxyPort).toBe('9000');
    expect(Number(c1.config)).toBe(Number(c0.config) + 1);
    await host.update(settings({ proxyPort: 9000, caPem: pems[1]! }));
    const c2 = await control(dir);
    expect(c2.caSha256).toBe(caSha256(pems[1]!));
    expect(Number(c2.config)).toBe(Number(c1.config) + 1);
    await host.update(settings({ proxyPort: 9000, caPem: pems[1]!, caPath: path.join(work, 'other.pem') }));
    const c3 = await control(dir);
    expect(c3.caPath).toBe(path.join(work, 'other.pem'));
    expect(Number(c3.config)).toBe(Number(c2.config) + 1);
  });

  it('follows the startup setting without a new config', async () => {
    const { dir, host } = await start();
    const c0 = await control(dir);
    await host.update(settings({ startup: true }));
    const c1 = await control(dir);
    expect(c1.startup).toBe('true');
    expect(c1.config).toBe(c0.config);
  });

  it('writes nothing when nothing changed', async () => {
    const renames = vi.fn(rename);
    const { dir, host } = await start({ ops: { rename: renames, sleep: async () => {} } });
    const c0 = await control(dir);
    const before = renames.mock.calls.length;
    await host.update(settings());
    expect(renames.mock.calls.length).toBe(before);
    expect(await control(dir)).toEqual(c0);
  });

  it('says off when it stops, once, and stops the heartbeat', async () => {
    const renames = vi.fn(rename);
    const { dir, host } = await start({ heartbeatMs: 20, ops: { rename: renames, sleep: async () => {} } });
    const c0 = await control(dir);
    await host.stop();
    const c1 = await control(dir);
    expect(c1.enabled).toBe('false');
    expect(Number(c1.config)).toBeGreaterThan(Number(c0.config));
    const writes = renames.mock.calls.length;
    await host.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renames.mock.calls.length).toBe(writes);
    expect(await control(dir)).toEqual(c1);
  });

  it('lands the latest settings last, however slow a write is', async () => {
    let slow = false;
    const ops: FileOps = {
      rename: async (from, to) => {
        // The first update's write is held back until the second has been asked for.
        if (slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await rename(from, to);
      },
      sleep: async () => {},
    };
    const { dir, host } = await start({ ops });
    slow = true;
    await Promise.all([
      host.update(settings({ proxyPort: 9001 })),
      host.update(settings({ proxyPort: 9002 })),
    ]);
    expect((await control(dir)).proxyPort).toBe('9002');
  });

  it('logs a heartbeat it can’t write once, and keeps trying', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    let fail = false;
    let tries = 0;
    const ops: FileOps = {
      rename: async (from, to) => {
        if (fail) {
          tries++;
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        }
        await rename(from, to);
      },
      sleep: async () => {},
    };
    const { dir } = await start({ heartbeatMs: 10, ops });
    const before = await control(dir);
    fail = true;
    await expect.poll(() => tries).toBeGreaterThan(3);
    expect(errors).toHaveBeenCalledTimes(1);
    fail = false;
    await expect.poll(async () => Number((await control(dir)).seq)).toBeGreaterThan(Number(before.seq) + 3);
    // Said once it works again, and a later failure is logged too.
    expect(logs.mock.calls.filter(([m]) => String(m).includes('heartbeat written again'))).toHaveLength(1);
    fail = true;
    await expect.poll(() => errors.mock.calls.length).toBe(2);
  });

  it('stays off after it stops, whatever comes later', async () => {
    const { dir, host } = await start();
    await host.stop();
    await host.update(settings({ proxyPort: 9100, startup: true }));
    const c = await control(dir);
    expect(c.enabled).toBe('false');
    expect(c.proxyPort).toBe('8000');
  });

  it('marks its jars in use, and deletes pairs no Wirescry has used for a week', async () => {
    const { dir } = await start();
    const current = (await control(dir)).impl!;
    const jarsDir = path.join(dir, 'jars');
    const old = 'wirescry-agent-impl-1.0.0-0000aaaa';
    const recent = 'wirescry-agent-impl-1.1.0-0000bbbb';
    const orphan = 'wirescry-agent-impl-0.9.0-0000cccc-weaver.jar';
    const week = 7 * 24 * 60 * 60 * 1000;
    const age = async (file: string, ms: number) => {
      const when = new Date(Date.now() - ms);
      await utimes(path.join(jarsDir, file), when, when);
    };
    for (const name of [
      `${old}.jar`,
      `${old}-weaver.jar`,
      `${recent}.jar`,
      `${recent}-weaver.jar`,
      orphan,
      'notes.txt',
    ]) {
      await writeFile(path.join(jarsDir, name), name);
    }
    await age(`${old}.jar`, week + 60_000);
    // A weaver goes by its agent's time, not its own.
    await age(`${old}-weaver.jar`, 0);
    await age(`${recent}.jar`, week - 60_000);
    await age(`${recent}-weaver.jar`, week + 60_000);
    await age(orphan, week + 60_000);
    await age(path.basename(current), week + 60_000);
    await age(path.basename(current).replace(/\.jar$/, '-weaver.jar'), week + 60_000);

    const deleted = await pruneAgentJars(dir, current);
    expect(deleted.sort()).toEqual([`${old}-weaver.jar`, `${old}.jar`, orphan].sort());
    expect((await readdir(jarsDir)).sort()).toEqual(
      [
        `${recent}.jar`,
        `${recent}-weaver.jar`,
        'notes.txt',
        path.basename(current),
        path.basename(current).replace(/\.jar$/, '-weaver.jar'),
      ].sort(),
    );
  });

  it('marks the pair it installs as used now, so a later start keeps it', async () => {
    const { dir } = await start();
    const current = (await control(dir)).impl!;
    const week = 8 * 24 * 60 * 60 * 1000;
    for (const file of [current, current.replace(/\.jar$/, '-weaver.jar')]) {
      const when = new Date(Date.now() - week);
      await utimes(path.join(dir, file), when, when);
    }
    // A start of the same build, with an older one's pair to delete.
    await writeFile(path.join(dir, 'jars', 'wirescry-agent-impl-0.1.0-00000000.jar'), '');
    const when = new Date(Date.now() - week);
    await utimes(path.join(dir, 'jars', 'wirescry-agent-impl-0.1.0-00000000.jar'), when, when);
    const again = await JavaAgentHost.start({ dir, jars, version: '1.2.3', heartbeatMs: 60_000 }, settings());
    hosts.push(again);
    expect(await readdir(path.join(dir, 'jars'))).not.toContain('wirescry-agent-impl-0.1.0-00000000.jar');
    // A newer build's start, later, keeps it: it was used just now.
    await pruneAgentJars(dir, 'jars/wirescry-agent-impl-9.9.9-99999999.jar');
    const names = await readdir(path.join(dir, 'jars'));
    expect(names).toContain(path.basename(current));
    expect(names).toContain(path.basename(current).replace(/\.jar$/, '-weaver.jar'));
    expect(names).not.toContain('wirescry-agent-impl-0.1.0-00000000.jar');
  });

  it('refuses a missing jar', async () => {
    const dir = path.join(await mkdtemp(path.join(work, 'data ')), 'java-agent');
    await expect(
      JavaAgentHost.start(
        { dir, jars: { ...jars, weaver: path.join(work, 'gone.jar') }, version: '1.2.3' },
        settings(),
      ),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('finding the agent’s jars', () => {
  it('looks for the jars the build makes and the app ships', () => {
    const require = createRequire(import.meta.url);
    const { JAVA_AGENT_JARS } = require('../scripts/check-java-agent.cjs') as { JAVA_AGENT_JARS: string[] };
    const built = jarsIn('/b');
    expect(Object.values(JAR_NAMES)).toEqual(JAVA_AGENT_JARS);
    for (const part of ['stub', 'impl', 'weaver'] as const)
      expect(built[part]).toBe(path.join('/b', JAR_NAMES[part]));
  });

  it('takes the app’s resources when all three are there', async () => {
    const resources = await mkdtemp(path.join(work, 'resources '));
    await mkdir(path.join(resources, 'java-agent'));
    for (const name of ['wirescry-agent.jar', 'wirescry-agent-impl.jar', 'wirescry-agent-weaver.jar']) {
      await writeFile(path.join(resources, 'java-agent', name), '');
    }
    expect(findAgentJars(resources)).toEqual({
      stub: path.join(resources, 'java-agent', 'wirescry-agent.jar'),
      impl: path.join(resources, 'java-agent', 'wirescry-agent-impl.jar'),
      weaver: path.join(resources, 'java-agent', 'wirescry-agent-weaver.jar'),
    });
  });

  it('never takes resources with a jar missing', async () => {
    const resources = await mkdtemp(path.join(work, 'resources '));
    await mkdir(path.join(resources, 'java-agent'));
    for (const name of ['wirescry-agent.jar', 'wirescry-agent-impl.jar']) {
      await writeFile(path.join(resources, 'java-agent', name), '');
    }
    // A development build of the agent, if there is one, is the fallback.
    const found = findAgentJars(resources);
    expect(found?.stub.startsWith(resources)).not.toBe(true);
    if (found) expect(found.stub).toBe(path.resolve('native/java-agent/build/wirescry-agent.jar'));
  });
});

describe('the backend and the Java agent', () => {
  let dataDir: string;
  let backend: Awaited<ReturnType<typeof startBackendOnPickedPort>> | undefined;

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
  });

  const startWith = async (javaAgent: Parameters<typeof startBackendOnPickedPort>[0]['javaAgent']) => {
    dataDir = await mkdtemp(path.join(work, 'backend '));
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      javaAgent,
    });
    return path.join(dataDir, 'java-agent');
  };

  it('keeps the control file on its port and CA, and says off when it stops', async () => {
    const dir = await startWith({ jars, heartbeatMs: 20 });
    // Written in the background.
    await expect
      .poll(() =>
        control(dir).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const c0 = await control(dir);
    expect(c0).toMatchObject({ enabled: 'true', startup: 'true', proxyPort: String(backend!.proxyPort) });
    expect(c0.caSha256).toBe(caSha256(await readFile(backend!.caCertPath, 'utf8')));
    await expect.poll(async () => (await control(dir)).seq).not.toBe(c0.seq);

    const api = await apiClient(backend!.apiPort);
    const port = await systemPickedPort();
    await api.send({ command: 'setProxyPort', port });
    expect((await control(dir)).proxyPort).toBe(String(port));
    await api.send({ command: 'resetCertificate' });
    const c1 = await control(dir);
    expect(c1.caSha256).toBe(caSha256(await readFile(backend!.caCertPath, 'utf8')));
    expect(c1.caSha256).not.toBe(c0.caSha256);
    api.close();

    await backend!.stop();
    backend = undefined;
    expect((await control(dir)).enabled).toBe('false');
  });

  it('writes nothing without the option', async () => {
    const dir = await startWith(undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(readFile(path.join(dir, 'control.properties'))).rejects.toThrow(/ENOENT/);
  });

  it('writes nothing while the startup setting is off, as it is by default', async () => {
    const dir = await startWith(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(readdir(dir)).rejects.toThrow(/ENOENT/);
  });

  it('starts without the agent when its jars can’t be installed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await startWith({ jars: { ...jars, impl: path.join(work, 'gone.jar') } });
    expect(backend!.proxyPort).toBeGreaterThan(0);
    await expect
      .poll(() => errors.mock.calls.some(([m]) => String(m).includes('java agent not set up')))
      .toBe(true);
    await expect(readFile(path.join(dir, 'control.properties'))).rejects.toThrow(/ENOENT/);
  });

  it('says off while the proxy still takes connections', async () => {
    let proxyOpen: boolean | undefined;
    const ops: FileOps = {
      rename: async (from, to) => {
        if (
          String(to).endsWith('control.properties') &&
          (await readFile(from, 'utf8')).includes('enabled=false')
        ) {
          proxyOpen = await new Promise<boolean>((resolve) => {
            const socket = net.connect(backend!.proxyPort, '127.0.0.1');
            socket.once('connect', () => resolve(true));
            socket.once('error', () => resolve(false));
          }).finally(() => undefined);
        }
        await rename(from, to);
      },
      sleep: async () => {},
    };
    const dir = await startWith({ jars, ops });
    await expect
      .poll(() =>
        control(dir).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await backend!.stop();
    backend = undefined;
    expect((await control(dir)).enabled).toBe('false');
    expect(proxyOpen).toBe(true);
  });

  it('doesn’t hold up quitting when the control file can’t be written', async () => {
    let hang = false;
    const ops: FileOps = {
      rename: async (from, to) => {
        // A reader holding the file, for ever.
        if (hang) await new Promise(() => {});
        await rename(from, to);
      },
      sleep: async () => {},
    };
    const dir = await startWith({ jars, ops });
    await expect
      .poll(() =>
        control(dir).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    hang = true;
    const started = Date.now();
    await backend!.stop();
    backend = undefined;
    expect(Date.now() - started).toBeLessThan(3000);
  });

  /** Ops whose first write (the stub's, in the install) waits for `release`. */
  const heldInstall = () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const ops: FileOps = {
      rename: async (from, to) => {
        if (first) {
          first = false;
          await held;
        }
        await rename(from, to);
      },
      sleep: async () => {},
    };
    return { ops, release: () => release() };
  };

  it('says off when it quits while the agent is still starting, however long that takes', async () => {
    const { ops, release } = heldInstall();
    const dir = await startWith({ jars, ops });
    // Quitting doesn't wait for it,
    await backend!.stop();
    backend = undefined;
    // and once it has started, it says off.
    release();
    await expect
      .poll(async () => (await control(dir).catch(() => ({}) as Record<string, string>)).enabled)
      .toBe('false');
  });

  it('follows a port change made while it was starting', async () => {
    const { ops, release } = heldInstall();
    const dir = await startWith({ jars, ops });
    const api = await apiClient(backend!.apiPort);
    const port = await systemPickedPort();
    await api.send({ command: 'setProxyPort', port });
    api.close();
    release();
    await expect
      .poll(async () => (await control(dir).catch(() => ({}) as Record<string, string>)).proxyPort)
      .toBe(String(port));
  });
});

describe.skipIf(!buildJava)('JVMs following the host', { timeout: 90_000 }, () => {
  let probes: string;
  setUpJavaAgentTests(async () => {
    probes = path.join(shared.work, 'host-probes');
    compileJava(8, probes, [path.join(import.meta.dirname, 'java', 'ProxyProbe.java')]);
  });

  async function probe(java: string, stub: string): Promise<Run> {
    const r = run(java, [`-javaagent:${stub}`, '-cp', probes, 'ProxyProbe'], { stdin: true });
    await expect.poll(r.stdout, { timeout: 15_000 }).toContain('ready');
    return r;
  }

  async function ask(r: Run, command: string): Promise<string> {
    const before = r.stdout().split('\n').filter(Boolean).length;
    r.send(command);
    await expect
      .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 15_000 })
      .toBeGreaterThan(before);
    return r.stdout().split('\n').filter(Boolean)[before]!.trim();
  }

  for (const java of javas) {
    describe(java, () => {
      it('starts off at startup, then follows the setting, the port and the stop', async () => {
        const dir = path.join(await mkdtemp(path.join(shared.work, 'data ')), 'java-agent');
        const host = await JavaAgentHost.start(
          {
            dir,
            jars: {
              stub: shared.built.stub.file,
              impl: shared.built.impl.file,
              weaver: shared.built.weaver.file,
            },
            version: '0.0.0-test',
            heartbeatMs: 200,
          },
          settings({ proxyPort: 7001 }),
        );
        hosts.push(host);
        const r = await probe(java, host.stubPath);
        // The probe clears the property macOS sets in every JVM, so the JDK's own answer is DIRECT.
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        const pid = r.child.pid;

        // The startup setting is off: the agent runs, and leaves the program alone.
        await expect
          .poll(async () => (await statusOf(dir, pid))?.reason, { timeout: 15_000 })
          .toBe('startup-off');
        expect(await ask(r, 'select http://example.test/')).toBe('DIRECT');

        await host.update(settings({ proxyPort: 7001, startup: true }));
        await expect.poll(async () => (await statusOf(dir, pid))?.reason, { timeout: 15_000 }).toBe('on');
        expect(await ask(r, 'select http://example.test/')).toBe('HTTP 127.0.0.1:7001');

        await host.update(settings({ proxyPort: 7002, startup: true }));
        await expect
          .poll(() => ask(r, 'select http://example.test/'), { timeout: 15_000 })
          .toBe('HTTP 127.0.0.1:7002');

        await host.stop();
        await expect.poll(async () => (await statusOf(dir, pid))?.reason, { timeout: 15_000 }).toBe('off');
        expect(await ask(r, 'select http://example.test/')).toBe('DIRECT');
      });
    });
  }
});
