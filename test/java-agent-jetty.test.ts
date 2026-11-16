/**
 * The Java agent's Jetty hooks (native/java-agent: Hooks, Jetty, ProgramWeaver, JettyOriginAdvice,
 * JettyMatchAdvice): with the agent on, Jetty's HttpClient (9.4 to 12.1) sends http and https to
 * Wirescry's port, deciding per request, so turning off or moving takes effect on the next one. It
 * leaves alone this computer, the program's exclusions, a proxy of the program's own (and a host
 * that proxy excludes), a request's own tag, and clients that can't go through an HTTP proxy
 * (HTTP/2-only, h2c-first, PROXY protocol, Unix sockets). Real JVMs and the real libraries
 * (test/java/JettyProbe9.java, JettyProbe10.java, JettyProbe12.java), against a stand-in proxy
 * made here; and stand-in Jetty classes (test/java/fake-jetty) to make the hooks fail on purpose.
 *
 * The hosts are under `.test`, which never resolves: a request that skips the proxy fails with
 * UnknownHostException, so nothing passes by reaching the internet. "Direct" is shown by the stand-in
 * seeing nothing, never by a request merely working.
 *
 * What it needs to run: see test/java-agent-helpers.ts. The Jetty jars come from Maven Central,
 * pinned by SHA-256 (scripts/build-java-agent.mjs, testJars).
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
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

type Probe = 9 | 10 | 12;

/**
 * The lines and releases: the newest of each with every test (`full`), the oldest with the main
 * ones. `min` is the oldest Java the release runs on.
 */
const LINES: Array<{
  set: TestJarSet;
  probe: Probe;
  min: number;
  label: string;
  full: boolean;
  /** False for a release the hooks don't cover: 9.4 before 9.4.25 has no tags. */
  covered?: false;
  /** False where the release has no Unix-socket connector to test (10.0.0 and 11.0.0). */
  unix?: false;
}> = [
  { set: 'jetty9.4.0', probe: 9, min: 8, label: '9.4.0', full: false, covered: false },
  { set: 'jetty9.4.25', probe: 9, min: 8, label: '9.4.25', full: false },
  { set: 'jetty9.4', probe: 9, min: 8, label: '9.4.58', full: true },
  { set: 'jetty10.0.0', probe: 10, min: 11, label: '10.0.0', full: false, unix: false },
  { set: 'jetty10', probe: 10, min: 11, label: '10.0.26', full: true },
  { set: 'jetty11.0.0', probe: 10, min: 11, label: '11.0.0', full: false, unix: false },
  { set: 'jetty11', probe: 10, min: 11, label: '11.0.26', full: true },
  { set: 'jetty12.0.0', probe: 12, min: 17, label: '12.0.0', full: false },
  { set: 'jetty12.0', probe: 12, min: 17, label: '12.0.41', full: true },
  { set: 'jetty12.1.0', probe: 12, min: 17, label: '12.1.0', full: false },
  { set: 'jetty12.1', probe: 12, min: 17, label: '12.1.15', full: true },
];
/** The oldest release each probe is built against, so it runs on every release of its line. */
const BUILT_AGAINST: Record<Probe, { set: TestJarSet; release: number }> = {
  9: { set: 'jetty9.4.0', release: 8 },
  10: { set: 'jetty10.0.0', release: 11 },
  12: { set: 'jetty12.0.0', release: 17 },
};

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
let tunnelPort: number;
let ca: { file: string; sha256: string };
const probeClasses: Partial<Record<Probe, string>> = {};
const classpaths: Partial<Record<TestJarSet, string>> = {};
let isolated: string;
let loaderProbe: string;
const fakes: Record<string, string> = {};
/** Another agent that retransforms the classes it's given when attached (test/java/Retransformer.java). */
let retransformer: string;
/** A PKCS12 trust store with another CA alone, not the stand-in's. */
let otherTrust: string;
/** JettyProbe12 with Jetty 12.1 and Spring's RestClient. */
let springClasspath: string;

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

const highestJava = () => Math.max(...javas.map(majorOf));

setUpJavaAgentTests(async () => {
  const { key, cert } = await generateCACertificate({ subject: { commonName: 'Test proxy CA' } });
  const file = path.join(shared.work, 'jetty-ca.pem');
  await writeFile(file, cert, { mode: 0o644 });
  ca = { file, sha256: caSha256(cert) };
  const require = createRequire(import.meta.url);
  const { getCA } = require('mockttp/dist/util/certificates') as {
    getCA(options: { key: string; cert: string }): Promise<{
      generateCertificate(domain: string): Promise<{ key: string; cert: string }>;
    }>;
  };
  const leaf = await (await getCA({ key, cert })).generateCertificate('proxied.test');
  // HTTP/2 or HTTP/1.1, by what the client offers: the body says which it spoke.
  tunnelPort = await listen(
    http2.createSecureServer({ ...leaf, allowHTTP1: true }, (req, res) =>
      res.end(req.httpVersion === '2.0' ? 'tunneled h2' : 'tunneled'),
    ),
  );
  const other = await generateCACertificate({ subject: { commonName: 'Another CA' } });
  const otherPem = path.join(shared.work, 'other-ca.pem');
  await writeFile(otherPem, other.cert);
  // No space in its path: the probe's commands are split at spaces.
  otherTrust = path.join(os.tmpdir(), `wsx-trust-${randomBytes(4).toString('hex')}.p12`);
  const keytool = spawnSync(
    jdkTool('keytool')!,
    ['-importcert', '-noprompt', '-alias', 'other', '-file', otherPem, '-keystore', otherTrust].concat([
      '-storetype',
      'PKCS12',
      '-storepass',
      'changeit',
    ]),
    { encoding: 'utf8' },
  );
  if (keytool.status !== 0) throw new Error(keytool.stderr);
  const sources = path.join(import.meta.dirname, 'java');
  const top = highestJava();
  for (const probe of [9, 10, 12] as const) {
    const { set, release } = BUILT_AGAINST[probe];
    if (top < release) continue;
    const out = path.join(shared.work, `jetty-probe-${probe}`);
    compileJava(
      release,
      out,
      [path.join(sources, `JettyProbe${probe}.java`)],
      (await fetchTestJars(set)).join(path.delimiter),
    );
    probeClasses[probe] = out;
  }
  for (const line of LINES) {
    if (top < line.min) continue;
    classpaths[line.set] = [probeClasses[line.probe]!, ...(await fetchTestJars(line.set))].join(
      path.delimiter,
    );
  }
  isolated = path.join(shared.work, 'isolated');
  compileJava(8, isolated, [path.join(sources, 'Isolated.java')]);
  loaderProbe = path.join(shared.work, 'jetty-loader-probe');
  compileJava(8, loaderProbe, [path.join(sources, 'JettyLoaderProbe.java')]);
  for (const kind of ['ok', 'no-match', 'no-ctor', 'no-address', 'no-proxy', 'shaded']) {
    const dir = path.join(sources, 'fake-jetty', kind);
    const files = (await readdir(dir, { recursive: true }))
      .filter((f) => f.endsWith('.java'))
      .map((f) => path.join(dir, f));
    fakes[kind] = path.join(shared.work, `fake-jetty-${kind}`);
    compileJava(8, fakes[kind], files);
  }
  if (classpaths['jetty12.1']) {
    springClasspath = [classpaths['jetty12.1'], ...(await fetchTestJars('spring'))].join(path.delimiter);
  }
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
    { encoding: 'utf8' },
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
/**
 * A TLS failure for a certificate naming another host. The trust hook vouches for Wirescry's
 * certificates only for the host they name, so the JDK's own check refuses the rest: the message is
 * the JDK's (an untrusted path), not a name mismatch.
 */
const WRONG_HOST = /^FAIL javax\.net\.ssl\.SSLHandshakeException: /;

/**
 * A JettyProbe for `set`, ready for commands: in a class loader of its own if `isolate`; with
 * Jetty on the module path (as named modules) if `modules`; on `classpath` if given.
 */
async function probe(
  java: string,
  set: TestJarSet,
  jvm: string[] = [],
  isolate = false,
  options: { modules?: boolean; classpath?: string } = {},
): Promise<Run> {
  const line = LINES.find((l) => l.set === set)!;
  const main = `JettyProbe${line.probe}`;
  const args = options.modules
    ? [
        ...VERIFY,
        ...jvm,
        '--module-path',
        (await fetchTestJars(set)).join(path.delimiter),
        '--add-modules',
        'ALL-MODULE-PATH',
        '-cp',
        probeClasses[line.probe]!,
        main,
      ]
    : isolate
      ? [...VERIFY, ...jvm, '-cp', isolated, 'Isolated', classpaths[set]!, main]
      : [...VERIFY, ...jvm, '-cp', options.classpath ?? classpaths[set]!, main];
  const r = run(java, args, { stdin: true });
  await expect.poll(r.stdout, { timeout: 30_000 }).toContain('ready');
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
    .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 30_000 })
    .toBeGreaterThan(before);
  return r.stdout().split('\n').filter(Boolean)[before]!.trim();
}

/** Asks `command` until it answers `expected` or `timeoutMs` passes, one at a time. */
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

async function unixServer(): Promise<string> {
  const socketPath = path.join(os.tmpdir(), `wsx-${randomBytes(4).toString('hex')}.sock`);
  const unix = http.createServer((req, res) => res.end(`socket ${req.url}`));
  await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
  servers.push(unix);
  return socketPath;
}

describe.skipIf(!buildJava)('the Java agent’s Jetty hooks', { timeout: 180_000 }, () => {
  for (const java of javas) {
    const major = majorOf(java);
    for (const line of LINES) {
      if (major < line.min) continue;
      const { set } = line;
      describe(`Jetty ${line.label} on Java ${major}`, () => {
        const on = async (proxy: StandIn, change = {}) =>
          agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change });

        if (line.covered === false) {
          it('leaves a release it doesn’t cover alone, and says so', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
            expect(await ask(r, 'route default http://proxied.test/')).toBe('DIRECT');
            expect(await ask(r, 'get default http://proxied.test/')).toMatch(UNKNOWN_HOST);
            expect(proxy.seen).toEqual([]);
            await expect
              .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
              .toMatchObject({ hooks: expect.arrayContaining(['jetty:not-covered']) });
          });
          return;
        }

        it('sends a client’s http and https through Wirescry’s proxy, and says so', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'route default http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          // Absolute-form through the proxy, as Jetty sends plain http to one.
          expect(await ask(r, 'get default http://proxied.test/a?b=1')).toBe(
            'OK proxied http://proxied.test/a?b=1',
          );
          // Through a CONNECT tunnel, the trust hook accepting the stand-in's certificate.
          expect(await ask(r, 'get default https://proxied.test/c')).toBe('OK tunneled');
          // A client made after the agent started, too.
          expect(await ask(r, 'fresh http://proxied.test/f')).toBe('OK proxied http://proxied.test/f');
          expect(proxy.seen).toEqual([
            'GET http://proxied.test/a?b=1',
            'CONNECT proxied.test:443',
            'GET http://proxied.test/f',
          ]);
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['jetty:ok']) });
        });

        it('changes nothing without the agent', async () => {
          const proxy = await standIn();
          const r = await probe(java, set);
          expect(await ask(r, 'route default http://proxied.test/')).toBe('DIRECT');
          expect(await ask(r, 'get default http://proxied.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('goes direct while the agent is off or detached, and follows a new port', async () => {
          const proxy = await standIn();
          const moved = await standIn('moved');
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'get default http://proxied.test/on')).toBe(
            'OK proxied http://proxied.test/on',
          );
          await agent.update({ enabled: false, seq: 2 });
          // The same client and host: its destination through Wirescry stays, unused.
          expect(await askUntil(r, 'route default http://proxied.test/', 'DIRECT')).toBe('DIRECT');
          expect(await ask(r, 'get default http://proxied.test/off')).toMatch(UNKNOWN_HOST);
          await agent.update({ enabled: true, proxyPort: moved.port, seq: 3 });
          expect(
            await askUntil(r, 'route default http://proxied.test/', `PROXY 127.0.0.1:${moved.port}`),
          ).toBe(`PROXY 127.0.0.1:${moved.port}`);
          expect(await ask(r, 'get default http://proxied.test/m')).toBe('OK moved http://proxied.test/m');
          const id = (await statusOf(agent.dir, r.child.pid))!.id;
          await agent.update({ detached: [id], seq: 4 });
          expect(await askUntil(r, 'route default http://proxied.test/', 'DIRECT')).toBe('DIRECT');
          expect(await ask(r, 'get default http://proxied.test/detached')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual(['GET http://proxied.test/on']);
          expect(moved.seen).toEqual(['GET http://proxied.test/m']);
        });

        it('reaches a client that already went direct to the host before the agent was attached', async () => {
          const proxy = await standIn();
          const agent = await on(proxy, { startup: false });
          const r = await probe(java, set);
          // Jetty's classes loaded, and a destination made for the host, before the agent arrives.
          expect(await ask(r, 'get default http://proxied.test/before')).toMatch(UNKNOWN_HOST);
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          expect(
            await askUntil(
              r,
              'get default http://proxied.test/after',
              'OK proxied http://proxied.test/after',
            ),
          ).toBe('OK proxied http://proxied.test/after');
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ hooks: expect.arrayContaining(['jetty:ok']) });
          expect(proxy.seen.length).toBeGreaterThan(0);
          expect(proxy.seen.every((s) => s === 'GET http://proxied.test/after')).toBe(true);
        });

        it('leaves this computer alone, IPv6 included, and reaches a subclass of the client', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          for (const url of ['http://localhost/', 'http://127.0.0.1:8080/', 'http://[::1]:8080/']) {
            expect(await ask(r, `route default ${url}`), url).toBe('DIRECT');
          }
          // A subclass the program made, not public, overriding a getter the hook reads.
          expect(await ask(r, 'route sub http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          expect(await ask(r, 'get sub http://proxied.test/sub')).toBe('OK proxied http://proxied.test/sub');
          expect(proxy.seen).toEqual(['GET http://proxied.test/sub']);
        });

        if (line.probe !== 9) {
          it('leaves a client with PROXY protocol alone, and counts it', async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
            // PROXY protocol reads the Origin's tag as its own: never tagged, and no ClassCastException.
            expect(await ask(r, 'route pp http://proxied.test/')).toBe('DIRECT');
            expect(await ask(r, 'get pp http://proxied.test/pp')).toMatch(UNKNOWN_HOST);
            // The other clients still go through Wirescry.
            expect(await ask(r, 'get dynamic http://proxied.test/d')).toBe(
              'OK proxied http://proxied.test/d',
            );
            expect(proxy.seen).toEqual(['GET http://proxied.test/d']);
            await expect
              .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
              .toMatchObject({ hooks: expect.arrayContaining(['jetty:ok', 'jetty-skipped:1']) });
          });

          it.skipIf(major < 16 || process.platform === 'win32' || line.unix === false)(
            'leaves a Unix domain socket alone, and proxies the rest',
            async () => {
              const socketPath = await unixServer();
              const proxy = await standIn();
              const agent = await on(proxy);
              const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
              // An address no one answers at (a documentation address), not this computer: proxied
              // if the hook took it for TCP. Jetty 10 reads an address before it connects, so not a name.
              expect(await ask(r, `unix ${socketPath} http://192.0.2.1/v1/info`)).toBe('OK socket /v1/info');
              expect(await ask(r, 'get default http://proxied.test/tcp')).toBe(
                'OK proxied http://proxied.test/tcp',
              );
              expect(proxy.seen).toEqual(['GET http://proxied.test/tcp']);
            },
          );
        }

        if (!line.full) return;

        it('reaches a client whose proxy hook another agent put in before its own attach finished', async () => {
          const proxy = await standIn();
          const agent = await on(proxy, { startup: false });
          // The agent pauses before it changes the classes already loaded: the window in which
          // another agent's retransform weaves ProxyConfiguration first.
          const r = await probe(java, set, ['-Dwirescry.agent.test.retransformDelayMs=8000']);
          expect(await ask(r, 'get default http://proxied.test/before')).toMatch(UNKNOWN_HOST);
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          const other = attacher([
            'load',
            String(r.child.pid),
            retransformer,
            'org.eclipse.jetty.client.ProxyConfiguration',
          ]);
          expect(other.code, other.why).toBe(0);
          // Still in the window: the agent writes its first status file only after the pause, so
          // the other agent's retransform came first.
          expect(await statusOf(agent.dir, r.child.pid)).toBeUndefined();
          expect(
            await askUntil(
              r,
              'get default http://proxied.test/after',
              'OK proxied http://proxied.test/after',
            ),
          ).toBe('OK proxied http://proxied.test/after');
          expect(await ask(r, 'route default http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        });

        it('leaves this computer and the program’s exclusions alone', async () => {
          const local = http.createServer((req, res) => res.end(`local ${req.url}`));
          const localPort = await listen(local);
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [
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
            expect(await ask(r, `route default ${url}`), url).toBe('DIRECT');
          }
          // Near misses still go through Wirescry.
          for (const url of [
            'http://skip.test.example/',
            'http://notexact.test/',
            'http://localhost.test/',
          ]) {
            expect(await ask(r, `route default ${url}`), url).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          }
          expect(await ask(r, `get default http://127.0.0.1:${localPort}/here`)).toBe('OK local /here');
          expect(await ask(r, 'get default http://a.skip.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('keeps the program’s own proxy, a host it excludes, and a request’s own tag', async () => {
          const proxy = await standIn();
          const other = await standIn('other');
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, `own ${other.port} http://proxied.test/own`)).toBe(
            'OK other http://proxied.test/own',
          );
          // The program's proxy excludes this host: direct, as without the agent.
          expect(await ask(r, `ownskip ${other.port} http://proxied.test/skip`)).toMatch(UNKNOWN_HOST);
          expect(await ask(r, 'tag default http://proxied.test/tagged')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
          expect(other.seen).toEqual(['GET http://proxied.test/own']);
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
          const r = await probe(java, set, [
            `-javaagent:${agent.stub}`,
            '-Dhttp.nonProxyHosts=excluded.test',
          ]);
          expect(await ask(r, 'get default http://proxied.test/hop')).toBe(
            'OK proxied http://other.test/next',
          );
          expect(await ask(r, 'get default http://proxied.test/home')).toBe('OK local /landed');
          expect(await ask(r, 'get default http://proxied.test/skip')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([
            'GET http://proxied.test/hop',
            'GET http://other.test/next',
            'GET http://proxied.test/home',
            'GET http://proxied.test/skip',
          ]);
        });

        it('reaches Jetty in a class loader of the program’s own', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`], true);
          expect(await ask(r, 'get default http://proxied.test/iso')).toBe(
            'OK proxied http://proxied.test/iso',
          );
          expect(proxy.seen).toEqual(['GET http://proxied.test/iso']);
        });

        it('costs little per request', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'route default http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          const plain = await probe(java, set);
          let best = Infinity;
          let base = Infinity;
          for (let round = 0; round < 5; round++) {
            await agent.heartbeat();
            await ask(r, 'bench 20000 http://proxied.test/');
            best = Math.min(best, Number((await ask(r, 'bench 20000 http://proxied.test/')).slice(3)));
            base = Math.min(base, Number((await ask(plain, 'bench 20000 http://proxied.test/')).slice(3)));
            expect(await ask(r, 'route default http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          }
          // What the agent adds to each request's destination lookup, in nanoseconds: measured at 1 to
          // 2 µs on a fast machine, Java 11 to 27, and GitHub's runners take about three times as long.
          const added = best - base;
          expect(added, `with ${best} ns, without ${base} ns`).toBeLessThan(
            process.env['CI'] ? 25_000 : 8_000,
          );
        });

        if (line.probe === 9) return;

        it('sends the dynamic transport through Wirescry’s proxy, over HTTP/1.1 and HTTP/2', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'get dynamic http://proxied.test/d')).toBe('OK proxied http://proxied.test/d');
          expect(await ask(r, 'get dynamic https://proxied.test/d')).toBe('OK tunneled');
          // HTTP/2 first: https speaks h2 inside the tunnel.
          expect(await ask(r, 'route h2first https://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
          expect(await ask(r, 'get h2first https://proxied.test/h')).toBe('OK tunneled h2');
          expect(proxy.seen).toEqual([
            'GET http://proxied.test/d',
            'CONNECT proxied.test:443',
            'CONNECT proxied.test:443',
          ]);
        });

        it('sends wss through Wirescry’s proxy, and leaves ws direct', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // Through a proxy Jetty sends a ws URL as the request line, which Wirescry doesn't read.
          expect(await ask(r, 'route default ws://proxied.test/')).toBe('DIRECT');
          // wss goes through a CONNECT tunnel.
          expect(await ask(r, 'route default wss://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        });

        it('leaves alone clients that can’t go through an HTTP proxy, and counts them', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // HTTP/2 first over plain http would mean h2c in a CONNECT tunnel to a plain port.
          expect(await ask(r, 'route h2first http://proxied.test/')).toBe('DIRECT');
          // No HTTP/1.1 at all: the hop to the proxy can't be made.
          expect(await ask(r, 'route h2only https://proxied.test/')).toBe('DIRECT');
          // The HTTP/2-only transport.
          expect(await ask(r, 'route h2 https://proxied.test/')).toBe('DIRECT');
          expect(proxy.seen).toEqual([]);
          // The two whole clients; the h2c-first plain request is left alone on its own.
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ hooks: expect.arrayContaining(['jetty:ok', 'jetty-skipped:2']) });
        });

        it('checks the server’s certificate as the program asked: host, its own trust store, peer validation', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // The stand-in's certificate names proxied.test: refused for another host, as without Wirescry.
          expect(await ask(r, 'get default https://wrong.test/')).toMatch(WRONG_HOST);
          // A trust store of the program's own, with another CA alone: Wirescry's is still trusted.
          expect(await ask(r, `owntrust ${otherTrust} changeit https://proxied.test/own`)).toBe(
            'OK tunneled',
          );
          // Jetty checking the chain itself (validatePeerCerts): accepted, and still host-checked.
          expect(await ask(r, `validate ${otherTrust} changeit https://proxied.test/v`)).toBe('OK tunneled');
          expect(await ask(r, `validate ${otherTrust} changeit https://wrong.test/v`)).toMatch(WRONG_HOST);
          expect(proxy.seen).toEqual([
            'CONNECT wrong.test:443',
            'CONNECT proxied.test:443',
            'CONNECT proxied.test:443',
            'CONNECT wrong.test:443',
          ]);
        });

        it('gives every thread the same answer at once', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'storm 8 1500 http://proxied.test/')).toBe(
            `ANSWERS PROXY 127.0.0.1:${proxy.port} ERRORS 0`,
          );
        });

        it.skipIf(process.platform === 'win32')(
          'works with Jetty as named modules on the module path',
          async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, set, [`-javaagent:${agent.stub}`], false, { modules: true });
            expect(await ask(r, 'get default http://proxied.test/mod')).toBe(
              'OK proxied http://proxied.test/mod',
            );
            expect(await ask(r, 'route pp http://proxied.test/')).toBe('DIRECT');
            if (major >= 16) {
              const socketPath = await unixServer();
              expect(await ask(r, `unix ${socketPath} http://192.0.2.1/m`)).toBe('OK socket /m');
            }
            expect(proxy.seen).toEqual(['GET http://proxied.test/mod']);
            await expect
              .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
              .toMatchObject({ hooks: expect.arrayContaining(['jetty:ok']) });
          },
        );

        it.skipIf(set !== 'jetty12.1')('sends Spring’s RestClient on Jetty through Wirescry', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`], false, {
            classpath: springClasspath,
          });
          expect(await ask(r, 'spring http://proxied.test/s')).toBe('OK proxied http://proxied.test/s');
          expect(await ask(r, 'spring https://proxied.test/s')).toBe('OK tunneled');
          expect(proxy.seen).toEqual(['GET http://proxied.test/s', 'CONNECT proxied.test:443']);
        });
      });
    }
  }

  describe('in class loaders of the program’s own, and with stand-in classes', () => {
    const java = javas.find((j) => majorOf(j) >= 17) ?? javas[0]!;
    const jettyClasspath = async () => (await fetchTestJars('jetty12.1')).join(path.delimiter);
    const on = async (proxy: StandIn, change = {}) =>
      agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change });

    async function loaderProbeRun(jvm: string[] = []): Promise<Run> {
      const r = run(
        java,
        [...VERIFY, ...jvm, '-cp', loaderProbe, 'JettyLoaderProbe', await jettyClasspath()],
        {
          stdin: true,
        },
      );
      await expect.poll(r.stdout, { timeout: 20_000 }).toContain('ready');
      return r;
    }

    it.skipIf(majorOf(java) < 17)(
      'reaches two copies of Jetty, and lets a dropped one be freed',
      async () => {
        const proxy = await standIn();
        const agent = await on(proxy);
        const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'load')).toBe('loaded 0');
        expect(await ask(r, 'load')).toBe('loaded 1');
        expect(await ask(r, 'route 0 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
        expect(await ask(r, 'drop 0')).toBe('dropped');
        expect(await ask(r, 'gc')).toBe('COLLECTED');
        expect(await ask(r, 'route 1 http://proxied.test/')).toBe(`PROXY 127.0.0.1:${proxy.port}`);
      },
    );

    it('tags and proxies a request on the stand-in Jetty with the shapes it needs', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      expect(await ask(r, `fake ${fakes['ok']}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0 proxied.test')).toBe(
        `tag=wirescry-proxy@127.0.0.1:${proxy.port} proxy=HttpProxy 127.0.0.1:${proxy.port}`,
      );
      expect(await ask(r, 'describe 0 localhost')).toBe('tag=null proxy=null');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ hooks: expect.arrayContaining(['jetty:ok']) });
    });

    it('tags nothing when the proxy hook can’t be put in, and says so', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      expect(await ask(r, `fake ${fakes['no-match']}`)).toBe('loaded 0');
      // A tag with no proxy hook would make a destination that's tagged but direct, for good.
      expect(await ask(r, 'describe 0 proxied.test')).toBe('tag=null');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ hooks: expect.arrayContaining(['jetty:failed']) });
    });

    it('leaves the request as it was when the Origin can’t be copied, and says so', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      expect(await ask(r, `fake ${fakes['no-ctor']}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0 proxied.test')).toBe('tag=null proxy=null');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ hooks: expect.arrayContaining(['jetty:failed']) });
    });

    it('leaves requests as they were when the hook can’t read them, and says so', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      expect(await ask(r, `fake ${fakes['no-address']}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0 proxied.test')).toBe('tag=null proxy=null');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ hooks: expect.arrayContaining(['jetty:failed']) });
    });

    it('tags nothing when Wirescry’s proxy can’t be made, and says so', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      expect(await ask(r, `fake ${fakes['no-proxy']}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0 proxied.test')).toBe('tag=null proxy=null');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ hooks: expect.arrayContaining(['jetty:failed']) });
    });

    it('leaves a renamed copy of Jetty alone', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      expect(await ask(r, `fake ${fakes['shaded']}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0 proxied.test')).toBe('tag=null proxy=null');
      await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
      const status = await statusOf(agent.dir, r.child.pid);
      expect(status?.hooks.some((h) => h.startsWith('jetty'))).toBe(false);
    });

    it('reports nothing of Jetty for a program that never loads it', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaderProbeRun([`-javaagent:${agent.stub}`]);
      await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
      const status = await statusOf(agent.dir, r.child.pid);
      expect(status?.hooks.some((h) => h.startsWith('jetty'))).toBe(false);
    });
  });
});
