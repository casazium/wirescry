/**
 * The Java agent's Apache HttpClient hook (native/java-agent: Hooks, Proxies.apache, ProgramWeaver,
 * ApacheAdvice): with the agent on, a client using Apache's own DefaultRoutePlanner (the default
 * in 4.x and in 5.x up to 5.6) sends http and https to Wirescry's port. It leaves alone this
 * computer, the program's exclusions, a request's own proxy, a builder's fixed proxy, and any
 * planner of the program's own. Real JVMs and the real libraries (test/java/ApacheProbe4.java,
 * ApacheProbe5.java), against a stand-in proxy made here.
 *
 * The hosts are under `.test`, which never resolves: a request that skips the proxy fails with
 * UnknownHostException, so nothing passes by reaching the internet.
 *
 * What it needs to run: see test/java-agent-helpers.ts. The Apache jars come from Maven Central,
 * pinned by SHA-256 (scripts/build-java-agent.mjs, testJars).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fetchTestJars, jdkTool } from '../scripts/build-java-agent.mjs';
import { caSha256 } from '../src/backend/java/agent-files';
import {
  agentFolder,
  attacher,
  buildJava,
  compileJava,
  expectAttached,
  javas,
  majorOf,
  newId,
  run,
  setUpJavaAgentTests,
  shared,
  statusOf,
  type Run,
} from './java-agent-helpers';

/** A stand-in for Wirescry's proxy: answers plain requests itself, and tunnels CONNECT. */
interface StandIn {
  port: number;
  /** What it was asked: "GET http://…" or "CONNECT host:port". */
  seen: string[];
}

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
let tunnelPort: number;
let ca: { file: string; sha256: string };
const classpath: Record<4 | 5, string> = { 4: '', 5: '' };
let isolated: string;
let loaderProbe: string;
const fakes: Record<string, string> = {};
let retransformer: string;

async function listen<T extends net.Server>(server: T): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** `redirects`: request URLs it answers with a 302 to the given location. */
async function standIn(answer = 'proxied', redirects: Record<string, string> = {}): Promise<StandIn> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const location = redirects[req.url ?? ''];
    if (location) {
      res.writeHead(302, { location });
      res.end();
      return;
    }
    res.end(`${answer} ${req.url}`);
  });
  server.on('connect', (req, client: net.Socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    const upstream = net.connect(tunnelPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { port: await listen(server), seen };
}

setUpJavaAgentTests(async () => {
  const { key, cert } = await generateCACertificate({ subject: { commonName: 'Test proxy CA' } });
  const file = path.join(shared.work, 'apache-ca.pem');
  await writeFile(file, cert, { mode: 0o644 });
  ca = { file, sha256: caSha256(cert) };
  const require = createRequire(import.meta.url);
  const { getCA } = require('mockttp/dist/util/certificates') as {
    getCA(options: { key: string; cert: string }): Promise<{
      generateCertificate(domain: string): Promise<{ key: string; cert: string }>;
    }>;
  };
  const leaf = await (await getCA({ key, cert })).generateCertificate('proxied.test');
  tunnelPort = await listen(https.createServer(leaf, (_, res) => res.end('tunneled')));
  const sources = path.join(import.meta.dirname, 'java');
  for (const v of [4, 5] as const) {
    // 4.x's async client too, beside its classic one.
    const jars =
      v === 4
        ? [...(await fetchTestJars('apache4')), ...(await fetchTestJars('apache4async'))]
        : await fetchTestJars('apache5');
    const out = path.join(shared.work, `apache${v}-probe`);
    compileJava(8, out, [path.join(sources, `ApacheProbe${v}.java`)], jars.join(path.delimiter));
    classpath[v] = [out, ...jars].join(path.delimiter);
  }
  isolated = path.join(shared.work, 'isolated');
  compileJava(8, isolated, [path.join(sources, 'Isolated.java')]);
  loaderProbe = path.join(shared.work, 'loader-probe');
  compileJava(8, loaderProbe, [path.join(sources, 'LoaderProbe.java')]);
  // Stand-in Apache classes (test/java/fake-apache/README.md).
  for (const kind of ['no-method', 'bad-host']) {
    const dir = path.join(sources, 'fake-apache', kind);
    const files = (await readdir(dir, { recursive: true }))
      .filter((f) => f.endsWith('.java'))
      .map((f) => path.join(dir, f));
    fakes[kind] = path.join(shared.work, `fake-${kind}`);
    compileJava(8, fakes[kind], files);
  }
  // Another agent that retransforms classes when attached.
  const classes = path.join(shared.work, 'retransformer');
  compileJava(8, classes, [path.join(sources, 'Retransformer.java')]);
  await writeFile(
    path.join(shared.work, 'retransformer.mf'),
    'Agent-Class: Retransformer\nCan-Retransform-Classes: true\n',
  );
  retransformer = path.join(shared.work, 'retransformer.jar');
  const jar = spawnSync(
    jdkTool('jar')!,
    ['cfm', retransformer, path.join(shared.work, 'retransformer.mf'), '-C', classes, '.'],
    {
      encoding: 'utf8',
    },
  );
  if (jar.status !== 0) throw new Error(jar.stderr);
});

afterEach(() => {
  for (const s of sockets) s.destroy();
});

afterAll(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Turns on the bytecode verifier for every class, so a bad rewrite fails the test. */
const VERIFY = ['-XX:+UnlockDiagnosticVMOptions', '-XX:+BytecodeVerificationLocal'];
const UNKNOWN_HOST = /^FAIL java\.net\.UnknownHostException/;

/** An ApacheProbe for version `v`, ready for commands; in a class loader of its own if `isolate`. */
async function probe(java: string, v: 4 | 5, jvm: string[] = [], isolate = false): Promise<Run> {
  const args = isolate
    ? [...VERIFY, ...jvm, '-cp', isolated, 'Isolated', classpath[v], `ApacheProbe${v}`]
    : [...VERIFY, ...jvm, '-cp', classpath[v], `ApacheProbe${v}`];
  const r = run(java, args, { stdin: true });
  await expect.poll(r.stdout, { timeout: 20_000 }).toContain('ready');
  return r;
}

/**
 * Sends one command and returns the line it printed. Answers are paired with commands by count,
 * so a command is never sent before the last one's answer is in (see askUntil).
 */
async function ask(r: Run, command: string): Promise<string> {
  const before = r.stdout().split('\n').filter(Boolean).length;
  r.send(command);
  await expect
    .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 20_000 })
    .toBeGreaterThan(before);
  return r.stdout().split('\n').filter(Boolean)[before]!.trim();
}

/**
 * Asks `command` until it answers `expected` or `timeoutMs` passes, one at a time (never a new
 * one while one is unanswered, which would pair later answers with the wrong commands). Returns
 * the last answer.
 */
async function askUntil(r: Run, command: string, expected: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await ask(r, command);
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

describe.skipIf(!buildJava)('the Java agent’s Apache HttpClient hook', { timeout: 120_000 }, () => {
  for (const java of javas) {
    const major = majorOf(java);
    for (const v of [4, 5] as const) {
      describe(`Apache ${v}.x on Java ${major}`, () => {
        const on = async (proxy: StandIn, change = {}) =>
          agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change });

        it('sends a default client’s http and https through Wirescry’s proxy, and says so', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'route http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          expect(await ask(r, 'get http://proxied.test/a?b=1')).toBe('OK proxied http://proxied.test/a?b=1');
          // Through a CONNECT tunnel, the trust hook accepting the stand-in's certificate.
          expect(await ask(r, 'get https://proxied.test/c')).toBe('OK tunneled');
          // The client built when the program started, before any request.
          expect(await ask(r, 'early http://proxied.test/e')).toBe('OK proxied http://proxied.test/e');
          expect(proxy.seen).toEqual([
            'GET http://proxied.test/a?b=1',
            'CONNECT proxied.test:443',
            'GET http://proxied.test/e',
          ]);
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['apache:ok']) });
        });

        it('changes nothing without the agent', async () => {
          const proxy = await standIn();
          const r = await probe(java, v);
          expect(await ask(r, 'route http://proxied.test/')).toBe('DIRECT');
          expect(await ask(r, 'get http://proxied.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('leaves this computer and the program’s exclusions alone', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, v, [
            `-javaagent:${agent.stub}`,
            '-Dhttp.nonProxyHosts=*.skip.test|exact.test',
          ]);
          for (const url of [
            'http://localhost/',
            'http://127.0.0.1:8080/',
            'http://127.9.9.9/',
            'http://[::1]:8080/',
            'http://app.localhost/',
            'http://0.0.0.0/',
            'http://a.skip.test/',
            'http://EXACT.test/',
            `http://127.0.0.1:${proxy.port}/`,
          ]) {
            expect(await ask(r, `route ${url}`), url).toBe('DIRECT');
          }
          // Near misses still go through Wirescry.
          for (const url of [
            'http://skip.test.example/',
            'http://notexact.test/',
            'http://localhost.test/',
          ]) {
            expect(await ask(r, `route ${url}`), url).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          }
          expect(await ask(r, 'get http://a.skip.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('keeps a request’s own proxy, a builder’s fixed proxy, and a planner of the program’s', async () => {
          const proxy = await standIn();
          const other = await standIn('other');
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, `own ${other.port} http://proxied.test/own`)).toBe(
            'OK other http://proxied.test/own',
          );
          expect(await ask(r, `fixed ${other.port} http://proxied.test/fixed`)).toBe(
            'OK other http://proxied.test/fixed',
          );
          // A subclass of the planner, adding nothing: the program's choice, left alone.
          expect(await ask(r, 'subclass http://proxied.test/sub')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
          expect(other.seen).toEqual(['GET http://proxied.test/own', 'GET http://proxied.test/fixed']);
        });

        it('sends a client using the system’s proxy settings through Wirescry too, by the JDK’s selector', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
          // macOS sets http.nonProxyHosts in every JVM.
          expect(await ask(r, 'set http.nonProxyHosts')).toBe('set');
          expect(await ask(r, 'system http://proxied.test/s')).toBe('OK proxied http://proxied.test/s');
          expect(proxy.seen).toEqual(['GET http://proxied.test/s']);
        });

        it('goes direct while the agent is off or detached, and follows a new port', async () => {
          const proxy = await standIn();
          const moved = await standIn('moved');
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'route http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          await agent.update({ enabled: false, seq: 2 });
          expect(await askUntil(r, 'route http://proxied.test/', 'DIRECT')).toBe('DIRECT');
          // The client built at start too, its pool and all.
          expect(await ask(r, 'early http://proxied.test/off')).toMatch(UNKNOWN_HOST);
          await agent.update({ enabled: true, proxyPort: moved.port, seq: 3 });
          expect(await askUntil(r, 'route http://proxied.test/', `PROXY 127.0.0.1:${moved.port}`)).toBe(
            `PROXY 127.0.0.1:${moved.port}`,
          );
          expect(await ask(r, 'early http://proxied.test/m')).toBe('OK moved http://proxied.test/m');
          const id = (await statusOf(agent.dir, r.child.pid))!.id;
          await agent.update({ detached: [id], seq: 4 });
          expect(await askUntil(r, 'route http://proxied.test/', 'DIRECT')).toBe('DIRECT');
        });

        it('reaches a client built before the agent was attached', async () => {
          const proxy = await standIn();
          const agent = await on(proxy, { startup: false });
          const r = await probe(java, v);
          // The planner's class is loaded, and a client built, before the agent arrives.
          expect(await ask(r, 'early http://proxied.test/before')).toMatch(UNKNOWN_HOST);
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          expect(
            await askUntil(r, 'early http://proxied.test/after', 'OK proxied http://proxied.test/after'),
          ).toBe('OK proxied http://proxied.test/after');
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ hooks: expect.arrayContaining(['apache:ok']) });
        });

        it('reaches Apache in a class loader of the program’s own', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`], true);
          expect(await ask(r, 'get http://proxied.test/iso')).toBe('OK proxied http://proxied.test/iso');
          expect(proxy.seen).toEqual(['GET http://proxied.test/iso']);
        });

        it('follows a redirect to each host by its own rules', async () => {
          const local = http.createServer((req, res) => res.end(`local ${req.url}`));
          const localPort = await listen(local);
          const proxy = await standIn('proxied', {
            'http://proxied.test/hop': 'http://other.test/next',
            'http://proxied.test/home': `http://127.0.0.1:${localPort}/landed`,
            'http://proxied.test/skip': 'http://excluded.test/x',
          });
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`, '-Dhttp.nonProxyHosts=excluded.test']);
          // Another proxied host: through Wirescry again.
          expect(await ask(r, 'get http://proxied.test/hop')).toBe('OK proxied http://other.test/next');
          // This computer: direct.
          expect(await ask(r, 'get http://proxied.test/home')).toBe('OK local /landed');
          // An excluded host: direct (and it doesn't exist).
          expect(await ask(r, 'get http://proxied.test/skip')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([
            'GET http://proxied.test/hop',
            'GET http://other.test/next',
            'GET http://proxied.test/home',
            'GET http://proxied.test/skip',
          ]);
        });

        it('judges a host made by hand by the same rules: IPv6, and other schemes', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
          const proxied = `PROXY 127.0.0.1:${proxy.port}`;
          for (const [host, answer] of [
            ['http ::1 8080', 'DIRECT'],
            ['http 0:0:0:0:0:0:0:1 8080', 'DIRECT'],
            ['http :: 8080', 'DIRECT'],
            ['http [::1] 8080', 'DIRECT'],
            ['http 2001:db8::1 80', proxied],
            ['https proxied.test 443', proxied],
            ['HTTP proxied.test 80', proxied],
            ['ftp files.test 21', 'DIRECT'],
            ['ws proxied.test 80', 'DIRECT'],
          ] as const) {
            expect(await ask(r, `host ${host}`), host).toBe(answer);
          }
        });

        if (v === 4) {
          it('sends 4.x’s async client through Wirescry’s proxy', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
            expect(await ask(r, 'async http://proxied.test/async4')).toBe(
              'OK proxied http://proxied.test/async4',
            );
            expect(await ask(r, 'async https://proxied.test/tls4')).toBe('OK tunneled');
            expect(proxy.seen).toEqual(['GET http://proxied.test/async4', 'CONNECT proxied.test:443']);
          });
        }

        if (v === 5) {
          it('sends the async client through Wirescry’s proxy', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
            expect(await ask(r, 'async http://proxied.test/async')).toBe(
              'OK proxied http://proxied.test/async',
            );
            expect(await ask(r, 'async https://proxied.test/tls')).toBe('OK tunneled');
            expect(proxy.seen).toEqual(['GET http://proxied.test/async', 'CONNECT proxied.test:443']);
          });

          it.skipIf(major < 16 || process.platform === 'win32')(
            'leaves a request over a Unix domain socket alone, and proxies the rest',
            async () => {
              const socketPath = path.join(os.tmpdir(), `wsx-${randomBytes(4).toString('hex')}.sock`);
              const unix = http.createServer((req, res) => res.end(`socket ${req.url}`));
              await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
              servers.push(unix);
              const proxy = await standIn();
              const agent = await on(proxy);
              const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
              // A placeholder host, as Docker clients send: never resolved, never proxied.
              expect(await ask(r, `unix ${socketPath} http://docker.example/v1/info`)).toBe(
                'OK socket /v1/info',
              );
              expect(await ask(r, 'get http://proxied.test/tcp')).toBe('OK proxied http://proxied.test/tcp');
              expect(proxy.seen).toEqual(['GET http://proxied.test/tcp']);
            },
          );

          it('leaves the HTTP/2-only client alone: it can’t go through a proxy', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
            const plain = await probe(java, v);
            for (const url of ['http://proxied.test/h2', 'https://proxied.test/h2s']) {
              const withAgent = await ask(r, `h2 ${url}`);
              // As without the agent: straight to the host (which doesn't exist here), not
              // "HTTP/2 tunneling not supported".
              expect(withAgent, url).toMatch(UNKNOWN_HOST);
              expect(withAgent, url).toBe(await ask(plain, `h2 ${url}`));
            }
            expect(proxy.seen).toEqual([]);
            // Other clients in the same program still go through Wirescry.
            expect(await ask(r, 'async http://proxied.test/after')).toBe(
              'OK proxied http://proxied.test/after',
            );
          });
        }
      });
    }

    describe(`Apache in class loaders of the program’s own, on Java ${major}`, () => {
      const on = async (proxy: StandIn, change = {}) =>
        agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change });
      const jars = (v: 4 | 5) => classpath[v].split(path.delimiter).slice(1).join(path.delimiter);

      /** A LoaderProbe, ready for commands. */
      async function loaderProbeRun(jvm: string[] = []): Promise<Run> {
        const r = run(java, [...VERIFY, ...jvm, '-cp', loaderProbe, 'LoaderProbe', jars(5), jars(4)], {
          stdin: true,
        });
        await expect.poll(r.stdout, { timeout: 20_000 }).toContain('ready');
        return r;
      }

      it('reaches several copies of Apache in one program, 4.x and 5.x, and each follows a new port', async () => {
        const proxy = await standIn();
        const moved = await standIn('moved');
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        for (const [n, v] of [
          [0, 5],
          [1, 5],
          [2, 4],
          [3, 4],
        ] as const) {
          expect(await ask(r, `load ${v}`)).toBe(`loaded ${n}`);
        }
        // In turn, each with its own HttpHost class.
        for (const n of [0, 2, 1, 3, 0, 3]) {
          expect(await ask(r, `route ${n} http://proxied.test/`), `loader ${n}`).toBe(
            `PROXY 127.0.0.1:${proxy.port}`,
          );
        }
        await agent.update({ proxyPort: moved.port, seq: 2 });
        for (const n of [0, 1, 2, 3]) {
          expect(
            await askUntil(r, `route ${n} http://proxied.test/`, `PROXY 127.0.0.1:${moved.port}`),
            `loader ${n}`,
          ).toBe(`PROXY 127.0.0.1:${moved.port}`);
        }
      });

      it('keeps the hook when a planner’s class loader is closed, even when another agent retransforms it', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'load 5')).toBe('loaded 0');
        expect(await ask(r, 'close 0')).toBe('closed');
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        // Past the agent's first poll, which mustn't lose it (a closed loader can't be woven again).
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
          .toMatchObject({ hooks: expect.arrayContaining(['apache:ok']) });
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        // Another agent retransforms the planner: the weave from before stands.
        const other = attacher([
          'load',
          String(r.child.pid),
          retransformer,
          'org.apache.hc.client5.http.impl.routing.DefaultRoutePlanner',
        ]);
        expect(other.code, other.why).toBe(0);
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect((await statusOf(agent.dir, r.child.pid))?.hooks).toContain('apache:ok');
      });

      it('never keeps a dropped class loader alive', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'load 5')).toBe('loaded 0');
        expect(await ask(r, 'load 4')).toBe('loaded 1');
        // Answers made: Wirescry's proxy, as each loader's HttpHost.
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        for (const n of [0, 1]) {
          expect(await ask(r, `close ${n}`)).toBe('closed');
          expect(await ask(r, `drop ${n}`)).toBe('dropped');
        }
        expect(await ask(r, 'gc')).toBe('COLLECTED');
      });

      it('reaches a planner in its own class loader loaded before an attach', async () => {
        const proxy = await standIn();
        const agent = await on(proxy, { startup: false });
        const r = await loaderProbeRun();
        expect(await ask(r, 'load 5')).toBe('loaded 0');
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe('DIRECT');
        expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
        expect(await askUntil(r, 'route 0 http://proxied.test/', `PROXY 127.0.0.1:${proxy.port}`)).toBe(
          `PROXY 127.0.0.1:${proxy.port}`,
        );
      });

      it('reports a planner it can’t change, and keeps reporting it', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        // The JDK's proxy hook before any Apache: what it says must stay its own.
        await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
        const proxyBefore = (await statusOf(agent.dir, r.child.pid))!.hooks.find((h) =>
          h.startsWith('proxy:'),
        );
        expect(proxyBefore).toBeDefined();
        // A stand-in DefaultRoutePlanner without determineProxy.
        expect(await ask(r, `fake ${fakes['no-method']}`)).toBe('loaded 0');
        await expect
          .poll(async () => (await statusOf(agent.dir, r.child.pid))?.hooks, { timeout: 15_000 })
          .toContain('apache:failed');
        expect((await statusOf(agent.dir, r.child.pid))!.hooks).toContain(proxyBefore);
        // A real one woven after it doesn't hide that one failed.
        expect(await ask(r, 'load 5')).toBe('loaded 1');
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const hooks = (await statusOf(agent.dir, r.child.pid))!.hooks;
        expect(hooks.filter((h) => h.startsWith('apache:'))).toEqual(['apache:failed']);
        // The other hooks report for themselves.
        expect(hooks).toContain(proxyBefore);
        expect(hooks.find((h) => h.startsWith('trust:'))).not.toBe('trust:failed');
      });

      it('keeps the program’s own answer when the hook throws', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        // A stand-in whose HttpHost the hook can't make its proxy with: it throws, inside.
        expect(await ask(r, `fake ${fakes['bad-host']}`)).toBe('loaded 0');
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe('DIRECT');
        // Woven, and working for a real Apache beside it.
        expect(await ask(r, 'load 5')).toBe('loaded 1');
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe('DIRECT');
        await expect
          .poll(async () => (await statusOf(agent.dir, r.child.pid))?.hooks, { timeout: 15_000 })
          .toContain('apache:ok');
      });

      it('says nothing of Apache in a program that never loads it', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
        // A few polls, for any late report.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const hooks = (await statusOf(agent.dir, r.child.pid))!.hooks;
        expect(hooks.length).toBeGreaterThan(0);
        expect(hooks.filter((h) => h.startsWith('apache:'))).toEqual([]);
      });
    });
  }
});
