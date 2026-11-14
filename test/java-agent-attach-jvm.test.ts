/**
 * Attaching from Setup with real JVMs: the backend's javaRefresh, javaAttach and javaDetach, the
 * attacher and the agent together, on each Java the agent workflow gives (Java 8 to 25). The
 * pieces alone, without a JVM: test/java-agent-attach.test.ts.
 *
 * What these tests need to run: see test/java-agent-helpers.ts.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JavaAttachStatus, ProxyStatus } from '../src/shared/api';
import { apiClient, startBackendOnPickedPort, TOKEN, UI_ORIGIN } from './helpers';
import {
  attachJava,
  buildJava,
  compileJava,
  javas,
  majorOf,
  run,
  setUpJavaAgentTests,
  shared,
  type Run,
} from './java-agent-helpers';

const version = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
).version;
let probes: string;
let target: http.Server;
let targetPort: number;
/**
 * This computer's own address, not loopback: the agent leaves loopback direct, as the JDK does. Not
 * every machine has one.
 */
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

setUpJavaAgentTests(async () => {
  probes = path.join(shared.work, 'attach-probes');
  compileJava(8, probes, [path.join(import.meta.dirname, 'java', 'ProxyProbe.java')]);
});

beforeAll(async () => {
  target = http.createServer((_req, res) => res.end('hello from the target'));
  await new Promise<void>((resolve) => target.listen(0, lanAddress ?? '127.0.0.1', resolve));
  targetPort = (target.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => target.close(resolve));
});

describe.skipIf(!buildJava)('attaching from Setup', () => {
  let backend: Awaited<ReturnType<typeof startBackendOnPickedPort>> | undefined;
  let api: Awaited<ReturnType<typeof apiClient>> | undefined;
  let dataDir: string;

  afterEach(async () => {
    api?.close();
    api = undefined;
    await backend?.stop();
    backend = undefined;
  });

  async function start() {
    dataDir = await mkdtemp(path.join(shared.work, 'backend '));
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      app: { version, releaseDate: '2026-11-14' },
      javaAgent: {
        jars: {
          stub: shared.built.stub.file,
          impl: shared.built.impl.file,
          weaver: shared.built.weaver.file,
          attach: shared.built.attach.file,
        },
        // As the app: the startup setting is off, so nothing runs until an attach.
        followSetting: true,
        heartbeatMs: 500,
        attach: {
          findJdk: async () => ({
            jdk: {
              home: path.dirname(path.dirname(attachJava!)),
              java: attachJava!,
              version: '',
              major: 21,
              from: 'JAVA_HOME',
            },
            passed: [],
          }),
          pollMs: 250,
        },
      },
    });
    api = await apiClient(backend.apiPort);
  }

  const attachStatus = (): JavaAttachStatus | undefined => {
    const statuses = api!.messages.flatMap((m) =>
      m.type === 'status' || m.type === 'hello' ? [m.status] : [],
    );
    return (statuses.at(-1) as ProxyStatus | undefined)?.javaAgent?.attach;
  };
  const programOf = (pid: number | undefined) => attachStatus()?.programs.find((p) => p.pid === pid);

  async function probe(java: string, flags: string[] = []): Promise<Run> {
    const r = run(java, [...flags, '-cp', probes, 'ProxyProbe'], { stdin: true });
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
    const major = majorOf(java);
    describe(`on Java ${major}`, () => {
      it('lists, attaches, sends through Wirescry, detaches, and attaches again', async () => {
        await start();
        const r = await probe(java, ['-Dsecret.token=hunter2']);
        // macOS sets this in every JVM, and it would keep 127.0.0.1 direct.
        expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
        const pid = r.child.pid!;

        const listed = await api!.send<JavaAttachStatus>({ command: 'javaRefresh' });
        expect(listed.state).toBe('ready');
        expect(listed.programs).toContainEqual({ pid, name: 'ProxyProbe' });
        expect(JSON.stringify(listed)).not.toContain('hunter2');
        // Nothing runs before an attach: the setting is off.
        expect(await ask(r, 'select http://example.test/')).toBe('DIRECT');

        expect(await api!.send({ command: 'javaAttach', pid, confirmWarning: true })).toEqual({
          attached: true,
        });
        await expect
          .poll(() => programOf(pid)?.agent, { timeout: 20_000 })
          .toMatchObject({ route: 'attach', on: true, reason: 'on', current: true });
        expect(programOf(pid)?.agent?.outdated).toBeUndefined();
        expect(await ask(r, 'select http://example.test/')).toBe(`HTTP 127.0.0.1:${backend!.proxyPort}`);
        if (lanAddress) {
          expect(await ask(r, `get http://${lanAddress}:${targetPort}/attached`)).toBe(
            'OK hello from the target',
          );
          await api!.completed('/attached');
        }

        await api!.send({ command: 'javaDetach', pid });
        await expect.poll(() => programOf(pid)?.agent?.reason, { timeout: 20_000 }).toBe('detached');
        expect(programOf(pid)?.agent?.on).toBe(false);
        expect(await ask(r, 'select http://example.test/')).toBe('DIRECT');

        // Attach again: the same agent is turned back on (a JVM keeps the first one it loaded).
        const id = programOf(pid)?.agent?.id;
        expect(await api!.send({ command: 'javaAttach', pid })).toEqual({ attached: true });
        await expect.poll(() => programOf(pid)?.agent, { timeout: 20_000 }).toMatchObject({ id, on: true });
        expect(await ask(r, 'select http://example.test/')).toBe(`HTTP 127.0.0.1:${backend!.proxyPort}`);
      }, 90_000);

      it.skipIf(major < 21)(
        'asks before Java 21’s warning, and remembers the answer',
        async () => {
          await start();
          const r = await probe(java);
          const pid = r.child.pid!;
          expect(await api!.send({ command: 'javaAttach', pid })).toEqual({
            needsConfirmation: 'java-warning',
          });
          // Nothing was loaded, so the program printed no warning.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          expect(r.stderr()).not.toMatch(/agent/i);
          expect(programOf(pid)?.agent).toBeUndefined();

          expect(await api!.send({ command: 'javaAttach', pid, confirmWarning: true })).toEqual({
            attached: true,
          });
          await expect.poll(() => programOf(pid)?.agent?.on, { timeout: 20_000 }).toBe(true);
          await expect
            .poll(r.stderr, { timeout: 10_000 })
            .toMatch(/WARNING: A Java agent has been loaded dynamically/);
          expect(
            JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).javaAttachWarningOk,
          ).toBe(true);
          expect(attachStatus()?.warningOk).toBe(true);
        },
        90_000,
      );

      it('never attaches to a program Java doesn’t list, and leaves it running', async () => {
        await start();
        // -XX:-UsePerfData: the JVM doesn't list itself.
        const r = await probe(java, ['-XX:-UsePerfData']);
        const pid = r.child.pid!;
        const listed = await api!.send<JavaAttachStatus>({ command: 'javaRefresh' });
        expect(listed.programs.map((p) => p.pid)).not.toContain(pid);
        await expect(api!.send({ command: 'javaAttach', pid, confirmWarning: true })).rejects.toThrow(
          /doesn't list this process/,
        );
        expect(await ask(r, 'select http://example.test/')).toBe('DIRECT');
        expect(r.child.exitCode).toBeNull();
      }, 60_000);

      it.skipIf(major < 9)(
        'says why a program that refuses agents can’t be attached to',
        async () => {
          await start();
          const r = await probe(java, ['-XX:-EnableDynamicAgentLoading']);
          const pid = r.child.pid!;
          await expect(api!.send({ command: 'javaAttach', pid, confirmWarning: true })).rejects.toThrow(
            /EnableDynamicAgentLoading/,
          );
          expect(programOf(pid)?.note).toMatch(/EnableDynamicAgentLoading/);
          expect(programOf(pid)?.agent).toBeUndefined();
          expect(programOf(pid)?.busy).toBeUndefined();
        },
        60_000,
      );
    });
  }

  it('refuses a process that isn’t Java, and leaves it alone', async () => {
    await start();
    // This test's own process: an attach would send it SIGQUIT, ending it (and the test run).
    await expect(
      api!.send({ command: 'javaAttach', pid: process.pid, confirmWarning: true }),
    ).rejects.toThrow(/doesn't list this process/);
    await expect(api!.send({ command: 'javaDetach', pid: process.pid })).rejects.toThrow(
      /isn't running in this program/,
    );
  }, 60_000);
});
