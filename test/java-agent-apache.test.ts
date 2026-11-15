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
import { copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fetchTestJars, jdkTool, type TestJarSet } from '../scripts/build-java-agent.mjs';
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

/**
 * The version matrix: older and newer releases than the probes above are built for, each run
 * with ApacheBasic4 or ApacheBasic5 (built against the oldest, 4.3 and 5.0).
 */
const MATRIX: Array<{ set: TestJarSet; v: 4 | 5; label: string }> = [
  { set: 'apache4.3', v: 4, label: '4.3.6 (httpcore 4.3.3)' },
  { set: 'apache4.4', v: 4, label: '4.4.1' },
  { set: 'apache5.0', v: 5, label: '5.0.4' },
  { set: 'apache5.2', v: 5, label: '5.2.3' },
  { set: 'apache5.4', v: 5, label: '5.4.4' },
  { set: 'apache5.7', v: 5, label: '5.7-beta1' },
];
const matrixClasspath: Partial<Record<TestJarSet, string>> = {};
/** SpringProbe on a plain class path, and the same in a Spring Boot fat jar. */
let springClasspath: string;
let fatJar: string;

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

/** Runs the JDK's jar tool, throwing on failure. */
function jarTool(args: string[], cwd?: string) {
  const result = spawnSync(jdkTool('jar')!, args, { encoding: 'utf8', cwd });
  if (result.status !== 0) throw new Error(result.stderr);
}

/**
 * SpringProbe (Java 17+) on Spring's RestTemplate and HttpClient 5.6, on a class path and as a
 * Spring Boot fat jar laid out as Spring Boot's build plugins make one: the launcher's classes at
 * the root, the application in BOOT-INF/classes, its libraries stored whole in BOOT-INF/lib.
 */
async function buildSpring(sources: string) {
  const libs = [...(await fetchTestJars('spring')), ...(await fetchTestJars('apache5'))];
  const classes = path.join(shared.work, 'spring-probe');
  compileJava(17, classes, [path.join(sources, 'SpringProbe.java')], libs.join(path.delimiter));
  springClasspath = [classes, ...libs].join(path.delimiter);
  const root = path.join(shared.work, 'fat-jar');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'BOOT-INF', 'lib'), { recursive: true });
  const [loader] = await fetchTestJars('springBootLoader');
  jarTool(['xf', loader!], root);
  await rm(path.join(root, 'META-INF', 'MANIFEST.MF'), { force: true });
  await cp(classes, path.join(root, 'BOOT-INF', 'classes'), { recursive: true });
  for (const lib of libs) await copyFile(lib, path.join(root, 'BOOT-INF', 'lib', path.basename(lib)));
  const manifest = path.join(shared.work, 'fat-jar.mf');
  await writeFile(
    manifest,
    [
      'Main-Class: org.springframework.boot.loader.launch.JarLauncher',
      'Start-Class: SpringProbe',
      'Spring-Boot-Classes: BOOT-INF/classes/',
      'Spring-Boot-Lib: BOOT-INF/lib/',
      '',
    ].join('\n'),
  );
  fatJar = path.join(shared.work, 'spring-probe-fat.jar');
  // Stored, not compressed: Spring Boot reads the jars inside in place.
  jarTool(['--create', '--file', fatJar, '--manifest', manifest, '--no-compress', '-C', root, '.']);
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
  for (const v of [4, 5] as const) {
    const out = path.join(shared.work, `apache${v}-basic`);
    compileJava(
      8,
      out,
      [path.join(sources, `ApacheBasic${v}.java`)],
      (await fetchTestJars(v === 4 ? 'apache4.3' : 'apache5.0')).join(path.delimiter),
    );
    for (const m of MATRIX.filter((m) => m.v === v)) {
      matrixClasspath[m.set] = [out, ...(await fetchTestJars(m.set))].join(path.delimiter);
    }
  }
  if (javas.some((java) => majorOf(java) >= 17)) await buildSpring(sources);
  isolated = path.join(shared.work, 'isolated');
  compileJava(8, isolated, [path.join(sources, 'Isolated.java')]);
  loaderProbe = path.join(shared.work, 'loader-probe');
  compileJava(8, loaderProbe, [path.join(sources, 'LoaderProbe.java')]);
  // Stand-in Apache classes (test/java/fake-apache/README.md).
  for (const kind of ['no-method', 'bad-host', 'shaded', 'system-no-method', 'system-bad-host']) {
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

          it.skipIf(major < 16 || process.platform === 'win32')(
            'leaves a Unix domain socket alone on the system planner too, and only takes out its own proxy',
            async () => {
              const socketPath = path.join(os.tmpdir(), `wsx-${randomBytes(4).toString('hex')}.sock`);
              const unix = http.createServer((req, res) => res.end(`socket ${req.url}`));
              await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
              servers.push(unix);
              const proxy = await standIn();
              const other = await standIn('other');
              const agent = await on(proxy);
              const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
              expect(await ask(r, 'set http.nonProxyHosts')).toBe('set');
              // The JDK's selector answers Wirescry's proxy; for the socket, it's taken back out.
              expect(await ask(r, `sysunix ${socketPath} http://docker.example/v1/info`)).toBe(
                'OK socket /v1/info',
              );
              // On a subclass of it that overrides nothing too.
              expect(await ask(r, `sysunix ${socketPath} http://docker.example/v1/sub sub`)).toBe(
                'OK socket /v1/sub',
              );
              // Over TCP, the same planner still goes through Wirescry.
              expect(await ask(r, 'system http://proxied.test/tcp')).toBe(
                'OK proxied http://proxied.test/tcp',
              );
              // A proxy the program's own selector chose stands, socket or not, as without the agent.
              expect(await ask(r, `sysproxy ${other.port} http://proxied.test/own`)).toBe(
                'OK other http://proxied.test/own',
              );
              const refused = await ask(
                r,
                `sysproxy ${other.port} http://docker.example/v1/info ${socketPath}`,
              );
              expect(refused).toMatch(/Proxies are not supported over Unix domain sockets/);
              const plain = await probe(java, v);
              expect(
                await ask(plain, `sysproxy ${other.port} http://docker.example/v1/info ${socketPath}`),
              ).toBe(refused);
              expect(proxy.seen).toEqual(['GET http://proxied.test/tcp']);
              expect(other.seen).toEqual(['GET http://proxied.test/own']);
              await expect
                .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
                .toMatchObject({ hooks: expect.arrayContaining(['apache:ok']) });
            },
          );

          it.skipIf(major < 16 || process.platform === 'win32')(
            'takes out only Wirescry’s own proxy, and only while on, on the system planner',
            async () => {
              const socketPath = path.join(os.tmpdir(), `wsx-${randomBytes(4).toString('hex')}.sock`);
              const unix = http.createServer((req, res) => res.end(`socket ${req.url}`));
              await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
              servers.push(unix);
              const proxy = await standIn();
              const agent = await on(proxy);
              const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
              const refused = /Proxies are not supported over Unix domain sockets/;
              const url = 'http://docker.example/v1/info';
              // The program's own selector answering Wirescry's port at another address (a
              // documentation address, never reached: HttpClient refuses first): its own, it stands.
              expect(await ask(r, `sysproxy 192.0.2.1:${proxy.port} ${url} ${socketPath}`)).toMatch(refused);
              // Wirescry's address and port, from the program's own selector, while the agent is
              // on: indistinguishable from the JDK hook's answer, so taken out.
              expect(await ask(r, `sysproxy ${proxy.port} ${url} ${socketPath}`)).toBe('OK socket /v1/info');
              // While the agent is off, nothing is changed.
              await agent.update({ enabled: false, seq: 2 });
              expect(await askUntil(r, 'route http://proxied.test/', 'DIRECT')).toBe('DIRECT');
              expect(await ask(r, `sysproxy ${proxy.port} ${url} ${socketPath}`)).toMatch(refused);
              // Nor while it's detached.
              await agent.update({ enabled: true, seq: 3 });
              expect(await askUntil(r, 'route http://proxied.test/', `PROXY 127.0.0.1:${proxy.port}`)).toBe(
                `PROXY 127.0.0.1:${proxy.port}`,
              );
              const id = (await statusOf(agent.dir, r.child.pid))!.id;
              await agent.update({ detached: [id], seq: 4 });
              expect(await askUntil(r, 'route http://proxied.test/', 'DIRECT')).toBe('DIRECT');
              expect(await ask(r, `sysproxy ${proxy.port} ${url} ${socketPath}`)).toMatch(refused);
              // A subclass with a determineProxy of its own answering Wirescry's address and port:
              // the program's, and it stands, on or off.
              await agent.update({ detached: [], seq: 5 });
              expect(await askUntil(r, 'route http://proxied.test/', `PROXY 127.0.0.1:${proxy.port}`)).toBe(
                `PROXY 127.0.0.1:${proxy.port}`,
              );
              expect(await ask(r, `sysover ${proxy.port} ${url} ${socketPath}`)).toMatch(refused);
              expect(proxy.seen).toEqual([]);
            },
          );

          it.skipIf(major < 16 || process.platform === 'win32')(
            'takes its proxy back out on the system planner after an attach, and in a class loader of the program’s own',
            async () => {
              const socketPath = path.join(os.tmpdir(), `wsx-${randomBytes(4).toString('hex')}.sock`);
              const unix = http.createServer((req, res) => res.end(`socket ${req.url}`));
              await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
              servers.push(unix);
              const proxy = await standIn();
              const agent = await on(proxy, { startup: false });
              for (const isolate of [false, true]) {
                const r = await probe(java, v, [], isolate);
                expect(await ask(r, 'set http.nonProxyHosts')).toBe('set');
                // The planner loaded, and a request made, before the agent arrives.
                expect(await ask(r, `sysunix ${socketPath} http://docker.example/before`)).toBe(
                  'OK socket /before',
                );
                expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
                expect(
                  await askUntil(r, 'system http://proxied.test/s', 'OK proxied http://proxied.test/s'),
                  `isolated: ${isolate}`,
                ).toBe('OK proxied http://proxied.test/s');
                expect(
                  await ask(r, `sysunix ${socketPath} http://docker.example/after`),
                  `isolated: ${isolate}`,
                ).toBe('OK socket /after');
              }
              expect(proxy.seen).toEqual(['GET http://proxied.test/s', 'GET http://proxied.test/s']);
            },
          );

          it('leaves the HTTP/2-only client alone on the system planner too', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, v, [`-javaagent:${agent.stub}`]);
            const plain = await probe(java, v);
            for (const run of [r, plain]) expect(await ask(run, 'set http.nonProxyHosts')).toBe('set');
            for (const url of ['http://proxied.test/h2', 'https://proxied.test/h2s']) {
              const withAgent = await ask(r, `h2system ${url}`);
              expect(withAgent, url).toMatch(UNKNOWN_HOST);
              expect(withAgent, url).toBe(await ask(plain, `h2system ${url}`));
            }
            expect(proxy.seen).toEqual([]);
            expect(await ask(r, 'system http://proxied.test/after')).toBe(
              'OK proxied http://proxied.test/after',
            );
          });

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

    for (const m of MATRIX) {
      describe(`Apache ${m.label} on Java ${major}`, () => {
        const on = async (proxy: StandIn, change = {}) =>
          agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change });
        async function basic(jvm: string[] = []): Promise<Run> {
          const r = run(java, [...VERIFY, ...jvm, '-cp', matrixClasspath[m.set]!, `ApacheBasic${m.v}`], {
            stdin: true,
          });
          await expect.poll(r.stdout, { timeout: 20_000 }).toContain('ready');
          // macOS sets http.nonProxyHosts in every JVM; the 5.7 builders use the JDK's selector.
          expect(await ask(r, 'set http.nonProxyHosts')).toBe('set');
          return r;
        }

        it('sends a default client’s http and https through Wirescry’s proxy, and says so', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await basic([`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'route http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          expect(await ask(r, 'route https://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          expect(await ask(r, 'get http://proxied.test/m')).toBe('OK proxied http://proxied.test/m');
          expect(await ask(r, 'get https://proxied.test/t')).toBe('OK tunneled');
          expect(await ask(r, 'system http://proxied.test/s')).toBe('OK proxied http://proxied.test/s');
          const seen = ['GET http://proxied.test/m', 'CONNECT proxied.test:443', 'GET http://proxied.test/s'];
          if (m.v === 5) {
            expect(await ask(r, 'async http://proxied.test/a')).toBe('OK proxied http://proxied.test/a');
            expect(await ask(r, 'async https://proxied.test/at')).toBe('OK tunneled');
            seen.push('GET http://proxied.test/a', 'CONNECT proxied.test:443');
          }
          expect(proxy.seen).toEqual(seen);
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['apache:ok']) });
        });

        it('changes nothing without the agent, and leaves this computer and exclusions alone with it', async () => {
          const proxy = await standIn();
          const plain = await basic();
          expect(await ask(plain, 'route http://proxied.test/')).toBe('DIRECT');
          expect(await ask(plain, 'get http://proxied.test/')).toMatch(UNKNOWN_HOST);
          const agent = await on(proxy);
          const r = await basic([`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'set http.nonProxyHosts *.skip.test')).toBe('set');
          for (const url of [
            'http://localhost/',
            'http://127.0.0.1:8080/',
            'http://[::1]/',
            'http://a.skip.test/',
          ]) {
            expect(await ask(r, `route ${url}`), url).toBe('DIRECT');
          }
          expect(await ask(r, 'get http://a.skip.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('keeps a request’s own proxy', async () => {
          const proxy = await standIn();
          const other = await standIn('other');
          const agent = await on(proxy);
          const r = await basic([`-javaagent:${agent.stub}`]);
          expect(await ask(r, `own ${other.port} http://proxied.test/own`)).toBe(
            'OK other http://proxied.test/own',
          );
          expect(proxy.seen).toEqual([]);
          expect(other.seen).toEqual(['GET http://proxied.test/own']);
        });

        it('goes direct while the agent is off', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await basic([`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'route http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          await agent.update({ enabled: false, seq: 2 });
          expect(await askUntil(r, 'route http://proxied.test/', 'DIRECT')).toBe('DIRECT');
          expect(await ask(r, 'get http://proxied.test/off')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        if (m.v === 5) {
          it.skipIf(m.set !== 'apache5.7' || major < 16 || process.platform === 'win32')(
            'leaves a request over a Unix domain socket alone',
            async () => {
              const socketPath = path.join(os.tmpdir(), `wsx-${randomBytes(4).toString('hex')}.sock`);
              const unix = http.createServer((req, res) => res.end(`socket ${req.url}`));
              await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
              servers.push(unix);
              const proxy = await standIn();
              const agent = await on(proxy);
              const r = await basic([`-javaagent:${agent.stub}`]);
              expect(await ask(r, `unix ${socketPath} http://docker.example/v1/info`)).toBe(
                'OK socket /v1/info',
              );
              expect(proxy.seen).toEqual([]);
            },
          );

          it('leaves the HTTP/2-only client alone', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await basic([`-javaagent:${agent.stub}`]);
            const plain = await basic();
            for (const url of ['http://proxied.test/h2', 'https://proxied.test/h2s']) {
              const withAgent = await ask(r, `h2 ${url}`);
              expect(withAgent, url).toMatch(UNKNOWN_HOST);
              expect(withAgent, url).toBe(await ask(plain, `h2 ${url}`));
            }
            expect(proxy.seen).toEqual([]);
          });
        }
      });
    }

    describe.skipIf(major < 17)(`Spring’s RestTemplate on Apache 5.x, on Java ${major}`, () => {
      const on = async (proxy: StandIn, change = {}) =>
        agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change });
      /** SpringProbe on its class path, or from the fat jar. */
      async function spring(fat: boolean, jvm: string[] = []): Promise<Run> {
        const where = fat ? ['-jar', fatJar] : ['-cp', springClasspath, 'SpringProbe'];
        const r = run(java, [...VERIFY, ...jvm, ...where], { stdin: true });
        await expect.poll(r.stdout, { timeout: 30_000 }).toContain('ready');
        expect(await ask(r, 'set http.nonProxyHosts')).toBe('set');
        return r;
      }

      for (const fat of [false, true]) {
        const how = fat ? 'in a Spring Boot fat jar' : 'on a class path';
        it(`sends RestTemplate’s requests through Wirescry’s proxy, ${how}`, async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await spring(fat, [`-javaagent:${agent.stub}`]);
          // Where Apache's classes came from: Spring Boot's own loader in the fat jar.
          expect(await ask(r, 'loader')).toBe(
            fat
              ? 'org.springframework.boot.loader.launch.LaunchedClassLoader'
              : 'jdk.internal.loader.ClassLoaders$AppClassLoader',
          );
          // As Spring makes it (the JDK's selector), and on a default client (DefaultRoutePlanner).
          expect(await ask(r, 'rest http://proxied.test/r')).toBe('OK proxied http://proxied.test/r');
          expect(await ask(r, 'rest https://proxied.test/rs')).toBe('OK tunneled');
          expect(await ask(r, 'default http://proxied.test/d')).toBe('OK proxied http://proxied.test/d');
          expect(await ask(r, 'default https://proxied.test/ds')).toBe('OK tunneled');
          // This computer, direct, by each hook's rules: nothing listens on port 1.
          expect(await ask(r, 'rest http://localhost:1/')).toMatch(/^FAIL .*Connect/);
          expect(await ask(r, 'default http://localhost:1/')).toMatch(/^FAIL .*Connect/);
          expect(proxy.seen).toEqual([
            'GET http://proxied.test/r',
            'CONNECT proxied.test:443',
            'GET http://proxied.test/d',
            'CONNECT proxied.test:443',
          ]);
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['apache:ok']) });
        });

        it(`reaches RestTemplate when attached later, ${how}`, async () => {
          const proxy = await standIn();
          const agent = await on(proxy, { startup: false });
          const r = await spring(fat);
          expect(await ask(r, 'default http://proxied.test/before')).toMatch(UNKNOWN_HOST);
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          expect(
            await askUntil(r, 'default http://proxied.test/after', 'OK proxied http://proxied.test/after'),
          ).toBe('OK proxied http://proxied.test/after');
          expect(await ask(r, 'rest http://proxied.test/r')).toBe('OK proxied http://proxied.test/r');
        });
      }

      it('changes nothing without the agent, in a Spring Boot fat jar', async () => {
        const proxy = await standIn();
        const r = await spring(true);
        expect(await ask(r, 'rest http://proxied.test/')).toMatch(UNKNOWN_HOST);
        expect(await ask(r, 'default http://proxied.test/')).toMatch(UNKNOWN_HOST);
        expect(proxy.seen).toEqual([]);
      });
    });

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

      it('answers the same from many threads at once, through a port change', async () => {
        const proxy = await standIn();
        const moved = await standIn('moved');
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'load 5')).toBe('loaded 0');
        expect(await ask(r, 'load 4')).toBe('loaded 1');
        for (const n of [0, 1]) {
          expect(await ask(r, `storm ${n} 16 300 http://proxied.test/`), `loader ${n}`).toBe(
            `ANSWERS PROXY 127.0.0.1:${proxy.port} ERRORS 0`,
          );
        }
        // The port changes while the threads run, until the agent reads it (once a second): every
        // thread keeps answering, with the old port and then the new, and only those.
        const answer = ask(r, 'storm 0 8 15000 http://proxied.test/ change');
        await new Promise((resolve) => setTimeout(resolve, 300));
        await agent.update({ proxyPort: moved.port, seq: 2 });
        const both = [`PROXY 127.0.0.1:${proxy.port}`, `PROXY 127.0.0.1:${moved.port}`].sort().join('|');
        expect(await answer).toBe(`ANSWERS ${both} ERRORS 0`);
        // And then only the new, from every thread.
        expect(await ask(r, 'storm 0 16 300 http://proxied.test/')).toBe(
          `ANSWERS PROXY 127.0.0.1:${moved.port} ERRORS 0`,
        );
      });

      it('adds little to each request', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const plain = await loaderProbeRun();
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        // 5s: 5.x's SystemDefaultRoutePlanner, which the JDK hook answers and its own small hook
        // checks, for https (the most it does) 200 calls down the stack.
        for (const v of ['5', '4', '5s'] as const) {
          const n = { '5': 0, '4': 1, '5s': 2 }[v];
          expect(await ask(plain, `load ${v}`)).toBe(`loaded ${n}`);
          expect(await ask(r, `load ${v}`)).toBe(`loaded ${n}`);
          expect(await ask(r, `route ${n} http://proxied.test/`)).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          const ns = async (run: Run) =>
            Number(
              (
                await ask(
                  run,
                  v === '5s'
                    ? `bench ${n} 20000 https://proxied.test/ 200`
                    : `bench ${n} 20000 http://proxied.test/`,
                )
              ).split(' ')[1],
            );
          // The best of several rounds each, in turn, so one busy moment on the machine doesn't count.
          let before = Infinity;
          let after = Infinity;
          for (let round = 0; round < 5; round++) {
            before = Math.min(before, await ns(plain));
            after = Math.min(after, await ns(r));
          }
          // Under 1 µs on 4.x, about 2 µs on 5.x and about 6 µs on 5s where measured (Java 11 to
          // 27); a request costs far more. Java 8 reads the whole stack, without StackWalker.
          expect(
            after - before,
            `Apache ${v === '5s' ? '5.x (system planner)' : `${v}.x`}: a route ${before} ns, with the agent ${after} ns`,
          ).toBeLessThan(major < 9 ? 40_000 : 15_000);
        }
      });

      it('leaves a renamed (shaded) copy of Apache alone, and says nothing of it', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        expect(await ask(r, `shaded ${fakes['shaded']}`)).toBe('loaded 0');
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe('DIRECT');
        await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(
          (await statusOf(agent.dir, r.child.pid))!.hooks.filter((h) => h.startsWith('apache:')),
        ).toEqual([]);
        // The real one beside it is still reached.
        expect(await ask(r, 'load 5')).toBe('loaded 1');
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe('DIRECT');
      });

      it('reports nothing for a system planner it has nothing to hook in', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        expect(await ask(r, `fakesys ${fakes['system-no-method']}`)).toBe('loaded 0');
        await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(
          (await statusOf(agent.dir, r.child.pid))!.hooks.filter((h) => h.startsWith('apache:')),
        ).toEqual([]);
        // A real one after it: only "ok".
        expect(await ask(r, 'load 5')).toBe('loaded 1');
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        await expect
          .poll(
            async () =>
              (await statusOf(agent.dir, r.child.pid))?.hooks.filter((h) => h.startsWith('apache:')),
            {
              timeout: 15_000,
            },
          )
          .toEqual(['apache:ok']);
      });

      it('keeps the system planner’s own answer when its hook throws', async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        // Wirescry's address and port, as an HttpHost the hook can't read: the answer stands.
        expect(await ask(r, `fakesys ${fakes['system-bad-host']}`)).toBe('loaded 0');
        expect(await ask(r, `route 0 http://p${proxy.port}/`)).toBe(`PROXY 127.0.0.1:${proxy.port}`);
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
