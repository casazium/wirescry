/**
 * The Java agent's Reactor Netty hook (native/java-agent: ReactorNetty, ReactorNettyAdvice, Hooks,
 * ProgramWeaver): with the agent on, Reactor Netty's HttpClient (1.0 to 1.3) sends http and https
 * through Wirescry's port, deciding per connection attempt, so turning off or moving takes effect
 * on the next request. It leaves alone this computer, the program's exclusions, a proxy of the
 * program's own, and requests that can't go through an HTTP proxy (h2c, HTTP/3, an address that
 * isn't a host and port); and a proxy that is Wirescry's own, from a terminal's properties, follows
 * Wirescry: direct once it quits, moved when it moves. Real JVMs and the real libraries
 * (test/java/NettyProbe.java), against a stand-in proxy made here.
 *
 * Reactor Netty sends every request through a proxy in a CONNECT tunnel, plain http included: the
 * stand-in tunnels port 443 to a TLS server and any other port to a plain one. The hosts are under
 * `.test`, which never resolves: a request that skips the proxy, or that's looked up here rather
 * than by the proxy, fails with UnknownHostException, so nothing passes by reaching the internet.
 * "Direct" is shown by the stand-in seeing nothing, never by a request merely working; and what the
 * hook decided is read from what HttpConnectionProvider.acquire was handed (the probe's `route`).
 *
 * What it needs to run: see test/java-agent-helpers.ts. The jars come from Maven Central, pinned by
 * SHA-256 (scripts/build-java-agent.mjs, testJars).
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
  waitForAgent,
  type Run,
  waitForOutput,
  waitForLines,
} from './java-agent-helpers';

/** A stand-in for Wirescry's proxy: tunnels CONNECT, and records what it was asked. */
interface StandIn {
  port: number;
  /** "CONNECT host:port", or "GET url" for a request sent to it as a plain proxy. */
  seen: string[];
}

/**
 * The releases: the first and last of 1.0, 1.1 and 1.2 (1.1.24 the last 1.1 without proxy
 * suppliers), and 1.3's latest. `full` runs every test; the others the main ones. `sysprops` is
 * false where the release has no proxyWithSystemProperties (1.0.0).
 */
const LINES: Array<{ set: TestJarSet; label: string; full: boolean; sysprops?: false }> = [
  { set: 'reactorNetty1.0.0', label: '1.0.0', full: false, sysprops: false },
  { set: 'reactorNetty1.0.48', label: '1.0.48', full: false },
  { set: 'reactorNetty1.1.0', label: '1.1.0', full: false },
  { set: 'reactorNetty1.1.24', label: '1.1.24', full: false },
  { set: 'reactorNetty1.1.31', label: '1.1.31', full: true },
  { set: 'reactorNetty1.2.0', label: '1.2.0', full: false },
  { set: 'reactorNetty1.2.18', label: '1.2.18', full: true },
  { set: 'reactorNetty1.3.8', label: '1.3.8', full: true },
];

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
let tlsPort: number;
let plainPort: number;
let ca: { file: string; sha256: string };
const classpaths: Partial<Record<TestJarSet, string>> = {};
/** A PKCS12 trust store with another CA alone, not the stand-in's. */
let otherTrust: string;
/** Isolated (test/java/Isolated.java): runs a main class in a class loader of its own. */
let isolated: string;
/** NettyProbe with Reactor Netty 1.2.18 and Spring's WebClient (NettyWebClient), on Java 17+. */
let webClasspath: string | undefined;
/** NettyLoaderProbe's classes. */
let loaderProbe: string;
/** The stand-in Reactor Netty (test/java/fake-netty), built: `no-copy` and its renamed copy `shaded`. */
const fakes: Record<string, string> = {};

async function listen<T extends net.Server>(server: T): Promise<number> {
  servers.push(server);
  // Node closes an idle kept-alive connection after 5 s, and a slow runner can take that long
  // between two requests: the program's pooled connection would then be gone, and it would open
  // a new tunnel the tests don't expect. Pooling is what they check, so idle connections stay.
  if ('keepAliveTimeout' in server) (server as unknown as { keepAliveTimeout: number }).keepAliveTimeout = 0;
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** `redirects`: paths on the plain server it answers with a 302 to the given location. */
async function standIn(redirects: Record<string, string> = {}): Promise<StandIn> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end(`absolute ${req.url}`);
  });
  server.on('connect', (req, client: net.Socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    const port = req.url?.endsWith(':443') ? tlsPort : plainPort;
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  redirectsByPath = { ...redirectsByPath, ...redirects };
  return { port: await listen(server), seen };
}

/** Redirects the plain tunnel target answers, by host and path. */
let redirectsByPath: Record<string, string> = {};

setUpJavaAgentTests(async () => {
  const { key, cert } = await generateCACertificate({ subject: { commonName: 'Test proxy CA' } });
  const file = path.join(shared.work, 'netty-ca.pem');
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
  tlsPort = await listen(
    http2.createSecureServer({ ...leaf, allowHTTP1: true }, (req, res) =>
      res.end(req.httpVersion === '2.0' ? 'tunneled h2' : 'tunneled'),
    ),
  );
  plainPort = await listen(
    http.createServer((req, res) => {
      const location = redirectsByPath[`${req.headers.host}${req.url}`];
      if (location) {
        res.writeHead(302, { location });
        res.end();
        return;
      }
      res.end(`plain ${req.headers.host}${req.url}`);
    }),
  );
  const other = await generateCACertificate({ subject: { commonName: 'Another CA' } });
  const otherPem = path.join(shared.work, 'other-ca.pem');
  await writeFile(otherPem, other.cert);
  // No space in its path: the probe's commands are split at spaces (a kind's path goes last).
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
  for (const line of LINES) {
    const jars = (await fetchTestJars(line.set)).join(path.delimiter);
    const out = path.join(shared.work, `netty-probe-${line.label}`);
    compileJava(8, out, [path.join(sources, 'NettyProbe.java')], jars);
    classpaths[line.set] = [out, jars].join(path.delimiter);
  }
  isolated = path.join(shared.work, 'netty-isolated');
  compileJava(8, isolated, [path.join(sources, 'Isolated.java')]);
  loaderProbe = path.join(shared.work, 'netty-loader-probe');
  compileJava(8, loaderProbe, [path.join(sources, 'NettyLoaderProbe.java')]);
  // The stand-in, and a copy renamed under `shaded.`, as a shading plugin would.
  const fakeSources = path.join(sources, 'fake-netty', 'no-copy');
  const files = (await readdir(fakeSources, { recursive: true })).filter((f) => f.endsWith('.java'));
  const shadedSources = path.join(shared.work, 'fake-netty-shaded-src');
  for (const f of files) {
    const text = (await readFile(path.join(fakeSources, f), 'utf8')).replace(
      /\b(package|import) (io\.netty|reactor\.netty)/g,
      '$1 shaded.$2',
    );
    const to = path.join(shadedSources, 'shaded', f);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, text);
  }
  fakes['no-copy'] = path.join(shared.work, 'fake-netty-no-copy');
  compileJava(
    8,
    fakes['no-copy'],
    files.map((f) => path.join(fakeSources, f)),
  );
  fakes.shaded = path.join(shared.work, 'fake-netty-shaded');
  compileJava(
    8,
    fakes.shaded,
    files.map((f) => path.join(shadedSources, 'shaded', f)),
  );
  if (Math.max(...javas.map(majorOf)) >= 17) {
    const spring = [
      ...(await fetchTestJars('reactorNetty1.2.18')),
      ...(await fetchTestJars('spring')),
      ...(await fetchTestJars('webflux')),
    ].join(path.delimiter);
    const out = path.join(shared.work, 'netty-webclient');
    compileJava(17, out, [path.join(sources, 'NettyWebClient.java')], spring);
    webClasspath = [classpaths['reactorNetty1.2.18'], out, spring].join(path.delimiter);
  }
});

afterEach(() => {
  for (const s of sockets) s.destroy();
});

afterAll(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Turns on the bytecode verifier for every class, so a bad rewrite fails the test. */
const VERIFY = ['-XX:+UnlockDiagnosticVMOptions', '-XX:+BytecodeVerificationLocal'];
/**
 * A lookup here that failed: the JDK's, or Netty's DNS resolver's (a subclass, by its own name); or
 * one still going when the probe stopped waiting (20 s), which a loaded machine's DNS can take for
 * a name that doesn't exist. Either way the request went direct: every test that expects this also
 * checks that the stand-in saw nothing of it.
 */
const UNKNOWN_HOST =
  /^FAIL ([\w.$]*UnknownHostException: |java\.lang\.IllegalStateException: Timeout on blocking read)/;
const HANDSHAKE = /^FAIL javax\.net\.ssl\.SSLHandshakeException: /;

/** A NettyProbe for `set`, ready for commands, on `classpath` if given. */
async function probe(java: string, set: TestJarSet, jvm: string[] = [], classpath?: string): Promise<Run> {
  const r = run(java, [...VERIFY, ...jvm, '-cp', classpath ?? classpaths[set]!, 'NettyProbe'], {
    stdin: true,
  });
  await waitForOutput(r, 'ready', 30_000);
  await waitForAgent(r.child.spawnargs, r.child.pid);
  return r;
}

/**
 * Sends one command and returns the line it printed. Answers are paired with commands by count,
 * so a command is never sent before the last one's answer is in (see askUntil).
 */
async function ask(r: Run, command: string): Promise<string> {
  const before = r.stdout().split('\n').filter(Boolean).length;
  r.send(command);
  await waitForLines(r, before, 30_000);
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

describe.skipIf(!buildJava)('the Java agent’s Reactor Netty hook', { timeout: 180_000 }, () => {
  for (const java of javas) {
    const major = majorOf(java);
    for (const line of LINES) {
      const { set } = line;
      describe(`Reactor Netty ${line.label} on Java ${major}`, () => {
        const on = async (proxy: StandIn, change = {}) =>
          agentFolder(
            { proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256, ...change },
            { beat: true },
          );
        const via = (proxy: StandIn, resolver = 'noop') => `PROXY 127.0.0.1:${proxy.port} ${resolver}`;

        it('sends http and https through Wirescry’s proxy, the host name unresolved, and says so', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // The program's settings: Wirescry's proxy, and a resolver that leaves names to it.
          expect(await ask(r, 'route default http://proxied.test/')).toBe(via(proxy));
          expect(await ask(r, 'route default https://proxied.test/')).toBe(via(proxy));
          // Plain http too goes through a tunnel; the name is only resolvable on the far side.
          expect(await ask(r, 'get default http://proxied.test/a?b=1')).toBe('OK plain proxied.test/a?b=1');
          // The trust hook accepting the stand-in's certificate for the host it names.
          expect(await ask(r, 'get default https://proxied.test/c')).toBe('OK tunneled');
          // A client made after the agent started, too (sharing the default pool: no new tunnel).
          expect(await ask(r, 'fresh http://proxied.test/f')).toBe('OK plain proxied.test/f');
          expect(proxy.seen).toEqual(['CONNECT proxied.test:80', 'CONNECT proxied.test:443']);
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['reactor-netty:ok']) });
        });

        it('changes nothing without the agent', async () => {
          const proxy = await standIn();
          const r = await probe(java, set);
          expect(await ask(r, 'route default http://proxied.test/')).toBe('DIRECT dns');
          expect(await ask(r, 'get default http://proxied.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('goes direct while the agent is off or detached, and follows a new port, with pooled connections', async () => {
          const proxy = await standIn();
          const moved = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // The same client throughout, so its pooled connections are there to be reused.
          expect(await ask(r, 'get default http://proxied.test/on')).toBe('OK plain proxied.test/on');
          expect(await ask(r, 'get default http://proxied.test/again')).toBe('OK plain proxied.test/again');
          await agent.update({ enabled: false, seq: 2 });
          expect(await askUntil(r, 'route default http://proxied.test/', 'DIRECT dns')).toBe('DIRECT dns');
          expect(await ask(r, 'get default http://proxied.test/off')).toMatch(UNKNOWN_HOST);
          await agent.update({ enabled: true, proxyPort: moved.port, seq: 3 });
          expect(await askUntil(r, 'route default http://proxied.test/', via(moved))).toBe(via(moved));
          expect(await ask(r, 'get default http://proxied.test/m')).toBe('OK plain proxied.test/m');
          const id = (await statusOf(agent.dir, r.child.pid))!.id;
          await agent.update({ detached: [id], seq: 4 });
          expect(await askUntil(r, 'route default http://proxied.test/', 'DIRECT dns')).toBe('DIRECT dns');
          expect(await ask(r, 'get default http://proxied.test/detached')).toMatch(UNKNOWN_HOST);
          // Tunnels to the first port before the switch, and to the new one after, none while off.
          // (Usually one each, kept alive; a loaded machine may see Reactor Netty open another.)
          expect(proxy.seen.length).toBeGreaterThan(0);
          expect(proxy.seen.every((x) => x === 'CONNECT proxied.test:80')).toBe(true);
          expect(moved.seen.length).toBeGreaterThan(0);
          expect(moved.seen.every((x) => x === 'CONNECT proxied.test:80')).toBe(true);
        });

        it('reaches a program that already sent requests before the agent was attached', async () => {
          const proxy = await standIn();
          const agent = await on(proxy, { startup: false });
          const r = await probe(java, set);
          expect(await ask(r, 'get default http://proxied.test/before')).toMatch(UNKNOWN_HOST);
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          expect(
            await askUntil(r, 'get default http://proxied.test/after', 'OK plain proxied.test/after'),
          ).toBe('OK plain proxied.test/after');
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ hooks: expect.arrayContaining(['reactor-netty:ok']) });
          expect(proxy.seen).toEqual(['CONNECT proxied.test:80']);
        });

        it('leaves this computer and the program’s exclusions alone', async () => {
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
            'http://a.skip.test/',
            'http://EXACT.test/',
            `http://127.0.0.1:${proxy.port}/`,
          ]) {
            expect(await ask(r, `route default ${url}`), url).toBe('DIRECT dns');
          }
          for (const url of [
            'http://skip.test.example/',
            'http://notexact.test/',
            'http://localhost.test/',
          ]) {
            expect(await ask(r, `route default ${url}`), url).toBe(via(proxy));
          }
          // A server on this computer is reached directly.
          const local = http.createServer((req, res) => res.end(`local ${req.url}`));
          const localPort = await listen(local);
          expect(await ask(r, `get default http://127.0.0.1:${localPort}/here`)).toBe('OK local /here');
          expect(await ask(r, 'get default http://a.skip.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
        });

        it('keeps the program’s own proxy, and a host it excludes direct', async () => {
          const proxy = await standIn();
          const other = await standIn();
          const agent = await on(proxy);
          const local = http.createServer((req, res) => res.end(`local ${req.url}`));
          const localPort = await listen(local);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // Hosts of their own: Reactor Netty's pool takes the two proxies for the same, and a pool
          // keeps the settings of the client that made it. The excluded host goes direct, reached.
          expect(await ask(r, `get ownskip:${other.port} http://127.0.0.1:${localPort}/skip`)).toBe(
            'OK local /skip',
          );
          expect(await ask(r, `route own:${other.port} http://elsewhere.test/`)).toBe(via(other));
          expect(await ask(r, `get own:${other.port} http://elsewhere.test/own`)).toBe(
            'OK plain elsewhere.test/own',
          );
          expect(proxy.seen).toEqual([]);
          expect(other.seen).toEqual(['CONNECT elsewhere.test:80']);
        });

        it('takes HTTP/2 over TLS, and leaves h2c and odd addresses alone', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // (HTTP/2's pool, h2c's too, doesn't hand acquire's arguments on to the probe's provider,
          // so `route` can't show those: the requests below and the stand-in's log do.)
          // An address that isn't a host and port (as a Unix socket's).
          expect(await ask(r, 'get h2 https://proxied.test/two')).toBe('OK tunneled h2');
          expect(await ask(r, 'get h2only https://proxied.test/only')).toBe('OK tunneled h2');
          expect(await ask(r, 'get h2c http://proxied.test/c')).toMatch(UNKNOWN_HOST);
          expect(await ask(r, 'get h11h2c http://proxied.test/u')).toMatch(UNKNOWN_HOST);
          // h2c, alone or as an upgrade from HTTP/1.1, never: direct.
          expect(proxy.seen).toEqual(['CONNECT proxied.test:443', 'CONNECT proxied.test:443']);
        });

        it('decides by protocol and address as acquire is handed them', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          const yes = `PROXY 127.0.0.1:${proxy.port} noop`;
          // The agent's own decision, called directly: HTTP/2 and h2c go through Reactor Netty's
          // HTTP/2 pool, which `route` can't see.
          expect(await ask(r, 'hook default http proxied.test 80')).toBe(yes);
          expect(await ask(r, 'hook default https proxied.test 443')).toBe(yes);
          expect(await ask(r, 'hook h2 https proxied.test 443')).toBe(yes);
          expect(await ask(r, 'hook h2only https proxied.test 443')).toBe(yes);
          // h2c for plain http, alone or beside HTTP/1.1: left alone.
          expect(await ask(r, 'hook h2c http proxied.test 80')).toBe('LEAVE');
          expect(await ask(r, 'hook h11h2c http proxied.test 80')).toBe('LEAVE');
          // An address that isn't a host and port (as a Unix socket's).
          expect(await ask(r, 'hook address http proxied.test 80')).toBe('LEAVE');
          // A WebSocket goes the same way (through a CONNECT tunnel, so ws too).
          expect(await ask(r, 'wsroute default ws://proxied.test/s')).toBe(via(proxy));
          expect(await ask(r, 'wsroute default wss://proxied.test/s')).toBe(via(proxy));
          // A client without a connection pool.
          expect(await ask(r, 'get nopool http://proxied.test/np')).toBe('OK plain proxied.test/np');
          // None of these left the hook reporting itself broken.
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ hooks: expect.arrayContaining(['reactor-netty:ok']) });
        });

        it('keeps a resolver the program chose, and replaces only the default', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // Its own AddressResolverGroup: kept, and asked.
          expect(await ask(r, 'route resolver http://proxied.test/')).toBe(via(proxy, 'own'));
          expect(await ask(r, 'get resolver http://proxied.test/r')).toMatch(/^OK plain /);
          expect(Number(await ask(r, 'lookups'))).toBeGreaterThan(0);
          // A customized DNS resolver: kept (looked up here, so this host fails).
          expect(await ask(r, 'route nameres http://proxied.test/')).toBe(via(proxy, 'dns'));
          // A hosts-file resolver of its own: kept (before 1.3, it's equal to the default by
          // Reactor Netty's own equals, so the hook tells them apart by identity).
          if (line.label !== '1.0.0') {
            expect(await ask(r, 'route hostsfile http://proxied.test/')).toBe(via(proxy, 'dns'));
          }
          // Its own event loops, which fill in the default resolver: replaced, so the name reaches
          // the proxy.
          expect(await ask(r, 'route runon http://proxied.test/')).toBe(via(proxy));
          expect(await ask(r, 'get runon http://proxied.test/loops')).toBe('OK plain proxied.test/loops');
        });

        if (line.sysprops !== false) {
          it('drops Wirescry’s proxy from a terminal’s client once Wirescry quits, and moves it when Wirescry moves', async () => {
            const proxy = await standIn();
            const moved = await standIn();
            const again = await standIn();
            const agent = await on(proxy);
            const local = http.createServer((req, res) => res.end(`local ${req.url}`));
            const localPort = await listen(local);
            // As a terminal Wirescry set up: its proxy properties, and its port named to the agent.
            const r = await probe(java, set, [
              `-Dhttp.proxyHost=127.0.0.1`,
              `-Dhttp.proxyPort=${proxy.port}`,
              // Reactor Netty's own default (localhost and the rest) applies only without this, which
              // the JDK fills in on some systems (macOS, from its settings).
              '-Dhttp.nonProxyHosts=localhost',
              `-javaagent:${agent.stub}=terminalPort=${proxy.port}`,
            ]);
            // The program's own proxy, read once, as it was set: left as it is.
            expect(await ask(r, 'route sysprops http://proxied.test/')).toBe(via(proxy));
            expect(await ask(r, 'get sysprops http://proxied.test/t')).toBe('OK plain proxied.test/t');
            // Wirescry moves, twice: the client follows (as the hook decides, read first, since the
            // old stand-in would answer too), and keeps its own exclusions (localhost).
            await agent.update({ proxyPort: moved.port, seq: 2 });
            expect(await askUntil(r, 'route sysprops http://proxied.test/', via(moved))).toBe(via(moved));
            expect(await ask(r, 'get sysprops http://proxied.test/m')).toBe('OK plain proxied.test/m');
            await agent.update({ proxyPort: again.port, seq: 3 });
            expect(await askUntil(r, 'route sysprops http://proxied.test/', via(again))).toBe(via(again));
            expect(await ask(r, 'get sysprops http://proxied.test/a')).toBe('OK plain proxied.test/a');
            expect(await ask(r, `get sysprops http://localhost:${localPort}/here`)).toBe('OK local /here');
            // Two more terminal clients, made now, on Wirescry's port of the moment: with the
            // program's own event loops (whose default resolver Reactor Netty keeps), and with its
            // own resolver.
            expect(await ask(r, 'route sysrunon http://proxied.test/')).toBe(via(again, 'dns'));
            expect(await ask(r, 'route sysresolver http://proxied.test/')).toBe(via(again, 'own'));
            // Wirescry quits: direct, with names looked up here again.
            await agent.update({ enabled: false, seq: 4 });
            expect(await askUntil(r, 'route sysprops http://proxied.test/', 'DIRECT dns')).toBe('DIRECT dns');
            expect(await ask(r, 'get sysprops http://proxied.test/gone')).toMatch(UNKNOWN_HOST);
            // The other two too, each keeping its resolver.
            expect(await ask(r, 'route sysrunon http://proxied.test/')).toBe('DIRECT dns');
            expect(await ask(r, 'get sysrunon http://proxied.test/gone')).toMatch(UNKNOWN_HOST);
            expect(await ask(r, 'route sysresolver http://proxied.test/')).toBe('DIRECT own');
            expect(proxy.seen).toEqual(['CONNECT proxied.test:80']);
            expect(moved.seen).toEqual(['CONNECT proxied.test:80']);
            expect(again.seen).toEqual(['CONNECT proxied.test:80']);
          });

          it('reaches Wirescry from a terminal it has since left', async () => {
            const old = await standIn();
            const proxy = await standIn();
            // Started in a terminal Wirescry set up on one port, after Wirescry moved to another:
            // the agent moves the terminal's proxy properties to the new port before main, so the
            // client is built on it.
            const agent = await on(proxy);
            const r = await probe(java, set, [
              `-Dhttp.proxyHost=127.0.0.1`,
              `-Dhttp.proxyPort=${old.port}`,
              `-javaagent:${agent.stub}=terminalPort=${old.port}`,
            ]);
            expect(await ask(r, 'route sysprops http://proxied.test/')).toBe(via(proxy));
            expect(await ask(r, 'get sysprops http://proxied.test/n')).toBe('OK plain proxied.test/n');
            expect(old.seen).toEqual([]);
            expect(proxy.seen).toEqual(['CONNECT proxied.test:80']);
          });

          it('leaves a terminal’s client to Wirescry while startup agents are off, and a proxy that isn’t Wirescry’s', async () => {
            const proxy = await standIn();
            const other = await standIn();
            const agent = await on(proxy, { startup: false });
            const r = await probe(java, set, [
              `-Dhttp.proxyHost=127.0.0.1`,
              `-Dhttp.proxyPort=${proxy.port}`,
              `-javaagent:${agent.stub}=terminalPort=${proxy.port}`,
            ]);
            // Wirescry runs, with startup agents off: the terminal's proxy still reaches it.
            expect(await ask(r, 'get sysprops http://proxied.test/s')).toBe('OK plain proxied.test/s');
            // Another proxy at 127.0.0.1, on a port that was never Wirescry's: the program's, kept
            // after Wirescry quits.
            expect(await ask(r, `set http.proxyPort ${other.port}`)).toBe('set');
            expect(await ask(r, 'route sysresolver http://proxied.test/')).toBe(via(other, 'own'));
            // Proxies at Wirescry's port that aren't its own: by name, or SOCKS.
            expect(await ask(r, `route ownhost:localhost:${proxy.port} http://proxied.test/`)).toMatch(
              /^PROXY localhost:\d+ noop$/,
            );
            expect(await ask(r, `route socks:${proxy.port} http://proxied.test/`)).toBe(via(proxy));
            // The agent detached while Wirescry runs: it can't tell, so the terminal's client stays.
            await expect.poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 }).toBeDefined();
            const id = (await statusOf(agent.dir, r.child.pid))!.id;
            await agent.update({ startup: true, detached: [id], seq: 2 });
            await new Promise((resolve) => setTimeout(resolve, 2500));
            expect(await ask(r, 'get sysprops http://proxied.test/d')).toBe('OK plain proxied.test/d');
            await agent.update({ enabled: false, seq: 3 });
            await new Promise((resolve) => setTimeout(resolve, 2500));
            // Wirescry gone: none of those is changed.
            expect(await ask(r, 'route sysresolver http://proxied.test/')).toBe(via(other, 'own'));
            expect(await ask(r, `route ownhost:localhost:${proxy.port} http://proxied.test/`)).toMatch(
              /^PROXY localhost:\d+ noop$/,
            );
            expect(await ask(r, `route socks:${proxy.port} http://proxied.test/`)).toBe(via(proxy));
            // Through Wirescry's port both times (one tunnel, or two if the first wasn't kept).
            expect(proxy.seen.length).toBeGreaterThan(0);
            expect(proxy.seen.every((x) => x === 'CONNECT proxied.test:80')).toBe(true);
          });
        }

        if (!line.full) return;

        it('checks the server’s certificate as the program asked', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // Wirescry's certificate names another host: refused.
          expect(await ask(r, 'get default https://wrong.test/')).toMatch(HANDSHAKE);
          // A program that trusts any certificate, as before.
          expect(await ask(r, 'get insecure https://wrong.test/')).toBe('OK tunneled');
          // A program's own trust store (another CA alone): the JDK's trust manager still, so
          // Wirescry's CA is trusted too, for the host it names.
          expect(await ask(r, `get trust:changeit:${otherTrust} https://proxied.test/`)).toBe('OK tunneled');
          expect(await ask(r, `get trust:changeit:${otherTrust} https://wrong.test/`)).toMatch(HANDSHAKE);
          // A program that pins a certificate with a trust manager of its own: Wirescry's refused.
          expect(await ask(r, 'get pinned https://proxied.test/')).toMatch(HANDSHAKE);
        });

        it('trusts Wirescry’s certificate through Netty’s OpenSSL engine, for its host only', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const classpath = [classpaths[set], ...(await fetchTestJars('tcnative'))].join(path.delimiter);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`], classpath);
          expect(await ask(r, 'openssl')).toBe('true');
          expect(await ask(r, 'get opensslclient https://proxied.test/o')).toBe('OK tunneled');
          expect(await ask(r, 'get opensslclient https://wrong.test/')).toMatch(
            /^FAIL javax\.net\.ssl\.SSL\w*Exception/,
          );
          // The default client too, which takes OpenSSL when it's there.
          expect(await ask(r, 'get default https://proxied.test/d')).toBe('OK tunneled');
        });

        it('leaves a program without Netty’s proxy support direct, and says so', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const classpath = classpaths[set]!.split(path.delimiter)
            .filter((j) => !/netty-handler-proxy-|netty-codec-socks-/.test(path.basename(j)))
            .join(path.delimiter);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`], classpath);
          expect(await ask(r, 'route default http://proxied.test/')).toBe('DIRECT dns');
          expect(await ask(r, 'get default http://proxied.test/')).toMatch(UNKNOWN_HOST);
          expect(proxy.seen).toEqual([]);
          await expect
            .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
            .toMatchObject({ hooks: expect.arrayContaining(['reactor-netty:no-proxy-handler']) });
        });

        it('follows a redirect to each host by its own rules', async () => {
          const local = http.createServer((req, res) => res.end(`local ${req.url}`));
          const localPort = await listen(local);
          const proxy = await standIn({
            'proxied.test/hop': 'http://other.test/next',
            'proxied.test/home': `http://127.0.0.1:${localPort}/landed`,
          });
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          expect(await ask(r, 'get default http://proxied.test/hop')).toBe('OK plain other.test/next');
          expect(await ask(r, 'get default http://proxied.test/home')).toBe('OK local /landed');
          expect(proxy.seen).toEqual(['CONNECT proxied.test:80', 'CONNECT other.test:80']);
        });

        it('reaches Reactor Netty in a class loader of the program’s own', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = run(
            java,
            [
              ...VERIFY,
              `-javaagent:${agent.stub}`,
              '-cp',
              isolated,
              'Isolated',
              classpaths[set]!,
              'NettyProbe',
            ],
            { stdin: true },
          );
          await waitForOutput(r, 'ready', 30_000);
          await waitForAgent(r.child.spawnargs, r.child.pid);
          expect(await ask(r, 'route default http://proxied.test/')).toBe(via(proxy));
          expect(await ask(r, 'get default http://proxied.test/i')).toBe('OK plain proxied.test/i');
        });

        it('gives every thread the same answer at once', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          // The agent's decision itself, unlocked, from 8 threads at once.
          expect(await ask(r, 'storm 8 1500 http://proxied.test:80/')).toBe(
            `ANSWERS PROXY 127.0.0.1:${proxy.port} noop ERRORS 0`,
          );
        });

        it('adds little to each request', async () => {
          const proxy = await standIn();
          const agent = await on(proxy);
          const plain = await probe(java, set);
          const r = await probe(java, set, [`-javaagent:${agent.stub}`]);
          const ns = async (run: Run) => (await ask(run, 'bench 3000 http://proxied.test/')).split(' ');
          let before = Infinity;
          let after = Infinity;
          for (let round = 0; round < 5; round++) {
            await agent.heartbeat();
            const [, b, direct] = await ns(plain);
            before = Math.min(before, Number(b));
            const [, a, proxied] = await ns(r);
            after = Math.min(after, Number(a));
            // Still on through each round: timed with the agent off, a round would pass for any hook.
            expect(direct).toBe('DIRECT');
            expect(proxied).toBe('PROXY');
          }
          // A request the probe's provider fails at once, so most of it is Reactor Netty's own work.
          // The hook copies the config and builds a provider: under 1 µs on a fast machine (Java 11
          // to 27); GitHub's runners take about three times as long.
          const bound = process.env.CI ? 15_000 : 5_000;
          expect(after - before, `before ${before} ns, after ${after} ns`).toBeLessThan(bound);
        });

        it.skipIf(set !== 'reactorNetty1.2.18' || major < 17)(
          'sends Spring’s WebClient through Wirescry',
          async () => {
            const proxy = await standIn();
            const agent = await on(proxy);
            const r = await probe(java, set, [`-javaagent:${agent.stub}`], webClasspath);
            expect(await ask(r, 'webclient http://proxied.test/w')).toBe('OK plain proxied.test/w');
            expect(await ask(r, 'webclient https://proxied.test/s')).toBe('OK tunneled');
            expect(proxy.seen).toEqual(['CONNECT proxied.test:80', 'CONNECT proxied.test:443']);
          },
        );
      });
    }
  }

  it('knows Wirescry’s ports: the terminal’s for good, a control file’s 1,024 most recent', () => {
    const out = path.join(shared.work, 'ports-check');
    compileJava(8, out, [path.join(import.meta.dirname, 'java', 'PortsCheck.java')], shared.built.impl.file);
    const result = spawnSync(
      buildJava!,
      ['-cp', [shared.built.impl.file, out].join(path.delimiter), 'com.wirescry.agent.impl.PortsCheck'],
      { encoding: 'utf8' },
    );
    expect(result.stdout).not.toContain('FAIL');
    expect(result.stdout.match(/^ok /gm)).toHaveLength(10);
    expect(result.status).toBe(0);
  });

  describe('in class loaders of the program’s own, and with stand-in classes', () => {
    const java = javas.find((j) => majorOf(j) >= 8)!;
    const on = async (proxy: StandIn) =>
      agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256 }, { beat: true });
    const loaders = async (agent: { stub: string }, classpath: string) => {
      const r = run(
        java,
        [...VERIFY, `-javaagent:${agent.stub}`, '-cp', loaderProbe, 'NettyLoaderProbe', classpath],
        {
          stdin: true,
        },
      );
      await waitForOutput(r, 'ready', 30_000);
      await waitForAgent(r.child.spawnargs, r.child.pid);
      return r;
    };

    it('reaches two copies of Reactor Netty, and lets a dropped one be freed', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaders(agent, classpaths['reactorNetty1.3.8']!);
      expect(await ask(r, 'load')).toBe('loaded 0');
      expect(await ask(r, 'load')).toBe('loaded 1');
      const via = `PROXY 127.0.0.1:${proxy.port} noop`;
      // The hook called as Reactor Netty calls it, without a request: a request starts Reactor
      // Netty's own threads, which keep their class loader whatever the agent does.
      expect(await ask(r, 'decide 0 proxied.test 80')).toBe(via);
      expect(await ask(r, 'decide 1 proxied.test 80')).toBe(via);
      expect(await ask(r, 'decide 1 localhost 80')).toBe('DIRECT dns');
      expect(await ask(r, 'drop 0')).toBe('dropped');
      // Nothing of the agent's (its cache of what it read of each copy) keeps the loader.
      expect(await ask(r, 'gc')).toBe('COLLECTED');
      expect(await ask(r, 'decide 1 proxied.test 80')).toBe(via);
      // And a real request, through the copy that stays.
      expect(await ask(r, 'route 1 default http://proxied.test/')).toBe(via);
    });

    it('leaves requests as they were when the hook can’t read the library, and says so', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaders(agent, classpaths['reactorNetty1.3.8']!);
      expect(await ask(r, `fake ${fakes['no-copy']}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0')).toBe('unchanged');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ hooks: expect.arrayContaining(['reactor-netty:failed']) });
    });

    it('leaves a renamed copy of Reactor Netty alone', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await loaders(agent, classpaths['reactorNetty1.3.8']!);
      expect(await ask(r, `fake ${fakes.shaded}`)).toBe('loaded 0');
      expect(await ask(r, 'describe 0')).toBe('unchanged');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ enabled: true });
      expect((await statusOf(agent.dir, r.child.pid))!.hooks.some((h) => h.startsWith('reactor-netty'))).toBe(
        false,
      );
    });

    it('reports nothing of Reactor Netty for a program that never loads it', async () => {
      const proxy = await standIn();
      const agent = await on(proxy);
      const r = await probe(java, 'reactorNetty1.3.8', [`-javaagent:${agent.stub}`]);
      expect(await ask(r, 'set some.property x')).toBe('set');
      await expect
        .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 15_000 })
        .toMatchObject({ enabled: true });
      expect((await statusOf(agent.dir, r.child.pid))!.hooks.some((h) => h.startsWith('reactor-netty'))).toBe(
        false,
      );
    });
  });
});
