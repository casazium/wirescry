/**
 * The Java agent's proxy hook (native/java-agent: Hooks, Proxies, ProxyAdvice): with the agent
 * on, the JDK's default proxy selector sends http and https to Wirescry's port, and leaves alone
 * this computer, other schemes, the program's own exclusions, and any proxy or selector the
 * program chose. Real JVMs, against a stand-in proxy made here.
 *
 * The hosts are under `.test`, which never resolves: a request that skips the proxy fails with
 * UnknownHostException, so nothing passes by reaching the internet.
 *
 * What it needs to run: see test/java-agent-helpers.ts.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { jdkTool } from '../scripts/build-java-agent.mjs';
import { caSha256 } from '../src/backend/java/agent-files';
import {
  agentFolder,
  buildJava,
  compileJava,
  expectAttached,
  javas,
  majorOf,
  newId,
  posix,
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
let probes: string;
let ca: { file: string; sha256: string };
/** A jar whose agent asks the JDK's proxy selector in its premain (test/java/EarlyAgent.java). */
let earlyAgent: string;

async function listen<T extends net.Server>(server: T): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function standIn(): Promise<StandIn> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end(`proxied ${req.url}`);
  });
  server.on('connect', (req, client: net.Socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    // Every CONNECT reaches the HTTPS server here, whatever host it names.
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
  const file = path.join(shared.work, 'proxy-ca.pem');
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
  probes = path.join(shared.work, 'proxy-probes');
  const sources = path.join(import.meta.dirname, 'java');
  compileJava(8, probes, [path.join(sources, 'ProxyProbe.java')]);
  compileJava(11, probes, [path.join(sources, 'TlsProbeHttpClient.java')]);
  const early = path.join(shared.work, 'early-agent');
  compileJava(8, early, [path.join(sources, 'EarlyAgent.java')]);
  await writeFile(path.join(shared.work, 'early.mf'), 'Premain-Class: EarlyAgent\n');
  earlyAgent = path.join(shared.work, 'early-agent.jar');
  const jar = spawnSync(
    jdkTool('jar')!,
    ['cfm', earlyAgent, path.join(shared.work, 'early.mf'), '-C', early, '.'],
    {
      encoding: 'utf8',
    },
  );
  if (jar.status !== 0) throw new Error(jar.stderr);
});

/**
 * A copy of `java`'s JDK with `lines` added to its net.properties, the JDK-wide settings an
 * administrator may set, or undefined where copying a JDK isn't cheap (Windows). A clone on
 * macOS, a copy on Linux.
 */
async function jdkWithNetProperties(java: string, major: number, lines: string): Promise<string | undefined> {
  if (!posix) return undefined;
  const home = path.dirname(path.dirname(java));
  const copy = path.join(shared.work, `jdk-${major}-${newId()}`);
  const cp = spawnSync('cp', process.platform === 'darwin' ? ['-cR', home, copy] : ['-a', home, copy]);
  if (cp.status !== 0) throw new Error(String(cp.stderr));
  // Java 8's JDK keeps it in jre/lib, its JRE in lib; later ones in conf.
  const file = ['conf/net.properties', 'jre/lib/net.properties', 'lib/net.properties']
    .map((f) => path.join(copy, f))
    .find((f) => existsSync(f));
  if (!file) throw new Error(`No net.properties in ${home}`);
  await appendFile(file, `\n${lines}\n`);
  return path.join(copy, 'bin', path.basename(java));
}

afterEach(() => {
  // No keep-alive between tests: each test's stand-in sees only its own requests.
  for (const s of sockets) s.destroy();
});

afterAll(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Turns on the bytecode verifier for JDK classes too, so a bad rewrite fails the test. */
const VERIFY = ['-XX:+UnlockDiagnosticVMOptions', '-XX:+BytecodeVerificationLocal'];
const UNKNOWN_HOST = /^FAIL java\.net\.UnknownHostException/;

/** A ProxyProbe, ready for commands. */
async function probe(java: string, jvm: string[] = []): Promise<Run> {
  const r = run(java, [...VERIFY, ...jvm, '-cp', probes, 'ProxyProbe'], { stdin: true });
  await expect.poll(r.stdout, { timeout: 15_000 }).toContain('ready');
  return r;
}

/** Sends one command and returns the line it printed. */
async function ask(r: Run, command: string): Promise<string> {
  const before = r.stdout().split('\n').filter(Boolean).length;
  r.send(command);
  await expect
    .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  return r.stdout().split('\n').filter(Boolean)[before]!.trim();
}

/** What each URI selects, in one go. */
async function selects(r: Run, uris: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const uri of uris) out[uri] = await ask(r, `select ${uri}`);
  return out;
}

const all = (uris: string[], answer: string) => Object.fromEntries(uris.map((u) => [u, answer]));

describe.skipIf(!buildJava)('the Java agent’s proxy hook', { timeout: 90_000 }, () => {
  for (const java of javas) {
    const major = majorOf(java);
    describe(`on Java ${major}`, () => {
      it('sends http and https through Wirescry’s proxy', async () => {
        const proxy = await standIn();
        const agent = await agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256 });
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'get http://proxied.test/a?b=1')).toBe('OK proxied http://proxied.test/a?b=1');
        // Through a CONNECT tunnel, with the trust hook accepting the stand-in's certificate.
        expect(await ask(r, 'get https://proxied.test/c')).toBe('OK tunneled');
        expect(proxy.seen).toEqual(['GET http://proxied.test/a?b=1', 'CONNECT proxied.test:443']);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['proxy:ok']) });
      });

      it('changes nothing without the agent', async () => {
        const proxy = await standIn();
        const r = await probe(java);
        expect(await ask(r, 'select http://proxied.test/')).toBe('DIRECT');
        expect(await ask(r, 'get http://proxied.test/')).toMatch(UNKNOWN_HOST);
        expect(proxy.seen).toEqual([]);
      });

      it('chooses Wirescry for other hosts, whatever their spelling', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        const r = await probe(java, [
          `-javaagent:${agent.stub}`,
          '-Dhttp.nonProxyHosts=*.corp.test|exact.test',
        ]);
        const uris = [
          'http://proxied.test/',
          'HTTPS://PROXIED.TEST:8443/x',
          'http://user:pw@proxied.test/',
          // Names URI can't parse, which the JDK takes from the authority.
          'http://my_host.test/',
          'http://u:p@under_score.test:8080/',
          'http://10.0.0.1:8080/',
          'http://[2001:db8::1]/',
          // Close to an exclusion or to this computer, but not one.
          'http://corp.test/',
          'http://exact.test.example/',
          'http://notlocalhost/',
          'http://localhost.example/',
          'http://1270.0.0.1/',
          // Not an address, and not looked up as a name either.
          'http://999.1.1.1/',
          'http://[fe80::1]/',
        ];
        expect(await selects(r, uris)).toEqual(all(uris, 'HTTP 127.0.0.1:4567'));
      });

      it('leaves this computer, other schemes and the program’s exclusions alone', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        const r = await probe(java, [
          `-javaagent:${agent.stub}`,
          '-Dhttp.nonProxyHosts=*.corp.test|EXACT.test|*inner*|start*|under_score.test',
        ]);
        const uris = [
          'http://localhost/',
          'http://LOCALHOST:3000/',
          'http://app.localhost/',
          'http://localhost./',
          'http://app.localhost./',
          // As the JDK's own default list has it: `127.*`, names included.
          'http://127.example.test/',
          'http://127.0.0.1:4567/',
          'http://127.5.6.7/',
          'http://0.0.0.0/',
          'http://[::1]:8080/',
          'http://[0:0:0:0:0:0:0:1]/',
          'http://[::]/',
          'http://[::ffff:127.0.0.1]/',
          'http://a.corp.test/',
          'http://exact.test/',
          'http://xinnerx.test/',
          'http://start.test/',
          // A name URI can't parse, excluded once its user and port are taken off.
          'http://u:p@under_score.test:8080/',
          // No host at all.
          'http://:80/',
          'ftp://proxied.test/',
          'socket://proxied.test:5432',
          'ws://proxied.test/',
        ];
        expect(await selects(r, uris)).toEqual(all(uris, 'DIRECT'));
      });

      it('leaves loopback alone even when the program excludes nothing', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        // The JDK's empty value turns off its own loopback defaults.
        const r = await probe(java, [`-javaagent:${agent.stub}`, '-Dhttp.nonProxyHosts=']);
        const uris = ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/'];
        expect(await selects(r, uris)).toEqual(all(uris, 'DIRECT'));
        expect(await ask(r, 'select http://proxied.test/')).toBe('HTTP 127.0.0.1:4567');
      });

      it('keeps a proxy the program’s settings name', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        const company = await probe(java, [
          `-javaagent:${agent.stub}`,
          '-Dhttp.proxyHost=company.test',
          '-Dhttp.proxyPort=3128',
          '-Dhttp.nonProxyHosts=skip.test',
        ]);
        expect(
          await selects(company, ['http://proxied.test/', 'http://skip.test/', 'https://proxied.test/']),
        ).toEqual({
          'http://proxied.test/': 'HTTP company.test:3128',
          // Skipped by the program's own setting: the JDK says DIRECT, and so does the hook.
          'http://skip.test/': 'DIRECT',
          // No https.proxyHost, so the JDK goes direct for https; Wirescry's takes it.
          'https://proxied.test/': 'HTTP 127.0.0.1:4567',
        });
        const socks = await probe(java, [`-javaagent:${agent.stub}`, '-DsocksProxyHost=socks.test']);
        expect(await ask(socks, 'select http://proxied.test/')).toBe('SOCKS socks.test:1080');
      });

      it('keeps a connection’s own proxy, or NO_PROXY', async () => {
        const proxy = await standIn();
        const theirs = await standIn();
        const agent = await agentFolder({ proxyPort: proxy.port });
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'direct http://proxied.test/')).toMatch(UNKNOWN_HOST);
        expect(await ask(r, `via ${theirs.port} http://proxied.test/x`)).toBe(
          'OK proxied http://proxied.test/x',
        );
        expect(proxy.seen).toEqual([]);
        expect(theirs.seen).toEqual(['GET http://proxied.test/x']);
      });

      it('keeps the program’s own selector, and says so', async () => {
        const proxy = await standIn();
        const agent = await agentFolder({ proxyPort: proxy.port });
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'select http://proxied.test/')).toBe(`HTTP 127.0.0.1:${proxy.port}`);
        expect(await ask(r, 'own')).toBe('set');
        expect(await ask(r, 'get http://proxied.test/')).toMatch(UNKNOWN_HOST);
        expect(proxy.seen).toEqual([]);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ hooks: expect.arrayContaining(['proxy:app-selector']) });
      });

      it.skipIf(!posix)('keeps the exclusions in the JDK’s own net.properties', async () => {
        const jdk = await jdkWithNetProperties(
          java,
          major,
          'http.proxyHost=company.test\nhttp.proxyPort=3128\nhttp.nonProxyHosts=internal.test',
        );
        const agent = await agentFolder({ proxyPort: 4567 });
        const uris = [
          'http://internal.test/',
          'https://internal.test/',
          'http://other.test/',
          'https://other.test/',
        ];
        const answers = async (jvm: string[]) => {
          const r = await probe(jdk!, jvm);
          // macOS sets the property from its own bypass list in every JVM, hiding the file's.
          expect(await ask(r, 'clear http.nonProxyHosts')).toBe('cleared');
          return selects(r, uris);
        };
        // The JDK's own answers: the company proxy, except for the excluded host.
        expect(await answers([])).toEqual({
          'http://internal.test/': 'DIRECT',
          'https://internal.test/': 'DIRECT',
          'http://other.test/': 'HTTP company.test:3128',
          'https://other.test/': 'DIRECT',
        });
        expect(await answers([`-javaagent:${agent.stub}`])).toEqual({
          'http://internal.test/': 'DIRECT',
          'https://internal.test/': 'DIRECT',
          'http://other.test/': 'HTTP company.test:3128',
          'https://other.test/': 'HTTP 127.0.0.1:4567',
        });
      });

      it('reaches a selector another agent loaded first', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        const r = await probe(java, [`-javaagent:${earlyAgent}`, `-javaagent:${agent.stub}`]);
        // Once the agent's control thread has changed the class, a second after the start.
        await expect
          .poll(() => ask(r, 'select http://proxied.test/'), { timeout: 10_000 })
          .toBe('HTTP 127.0.0.1:4567');
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ hooks: expect.arrayContaining(['proxy:ok', 'trust:waiting']) });
        expect(await ask(r, 'select http://localhost/')).toBe('DIRECT');
      });

      it.skipIf(!posix)('changes nothing when its weaver can’t load, and says so', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        await chmod(path.join(agent.dir, agent.impl.replace(/\.jar$/, '-weaver.jar')), 0o664);
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'select http://proxied.test/')).toBe('DIRECT');
        expect(await ask(r, 'get http://proxied.test/')).toMatch(UNKNOWN_HOST);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['proxy:failed']) });
      });

      it('goes direct while the agent is off, and follows a new port', async () => {
        const agent = await agentFolder({ proxyPort: 4567, enabled: false });
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'select http://proxied.test/')).toBe('DIRECT');
        await agent.update({ enabled: true, seq: 2 });
        await expect
          .poll(() => ask(r, 'select http://proxied.test/'), { timeout: 10_000 })
          .toBe('HTTP 127.0.0.1:4567');
        await agent.update({ proxyPort: 5678, seq: 3 });
        await expect
          .poll(() => ask(r, 'select http://proxied.test/'), { timeout: 10_000 })
          .toBe('HTTP 127.0.0.1:5678');
        await agent.update({ enabled: false, seq: 4 });
        await expect.poll(() => ask(r, 'select http://proxied.test/'), { timeout: 10_000 }).toBe('DIRECT');
      });

      it('goes direct when the agent is off with Wirescry still on', async () => {
        // On for attached programs, off for those started with the agent.
        const agent = await agentFolder({ proxyPort: 4567, startup: false });
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        expect(await ask(r, 'select http://proxied.test/')).toBe('DIRECT');
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: false, hooks: expect.arrayContaining(['proxy:ok']) });
        expect(await ask(r, 'select http://proxied.test/')).toBe('DIRECT');
      });

      it('says the hook is waiting until the program first asks for a proxy', async () => {
        const agent = await agentFolder({ proxyPort: 4567 });
        const r = await probe(java, [`-javaagent:${agent.stub}`]);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ hooks: expect.arrayContaining(['proxy:waiting']) });
        await ask(r, 'select http://proxied.test/');
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ hooks: expect.arrayContaining(['proxy:ok']) });
      });

      it('reaches a selector loaded before it was attached', async () => {
        const proxy = await standIn();
        const agent = await agentFolder({ proxyPort: proxy.port });
        const r = await probe(java);
        expect(await ask(r, 'select http://proxied.test/')).toBe('DIRECT');
        expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['proxy:ok']) });
        expect(await ask(r, 'get http://proxied.test/late')).toBe('OK proxied http://proxied.test/late');
        expect(await ask(r, 'select http://localhost/')).toBe('DIRECT');
      });

      it.skipIf(major < 11)('reaches Java’s HttpClient, even one built before the attach', async () => {
        const proxy = await standIn();
        const agent = await agentFolder({ proxyPort: proxy.port, caPath: ca.file, caSha256: ca.sha256 });
        const client = run(java, [...VERIFY, '-cp', probes, 'TlsProbeHttpClient', 'https://proxied.test/'], {
          stdin: true,
        });
        await expect.poll(client.stdout, { timeout: 15_000 }).toContain('ready');
        const send = async () => {
          const before = client.stdout().split('\n').filter(Boolean).length;
          client.send('');
          await expect
            .poll(() => client.stdout().split('\n').filter(Boolean).length, { timeout: 15_000 })
            .toBeGreaterThan(before);
          return client.stdout().split('\n').filter(Boolean)[before]!.trim();
        };
        // No such host: Java 11 to 25 word it differently.
        expect(await send()).toMatch(/^FAIL /);
        expect(proxy.seen).toEqual([]);
        expectAttached(['load', String(client.child.pid), agent.stub, `id=${newId()}`]);
        await expect
          .poll(() => statusOf(agent.dir, client.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: true, hooks: expect.arrayContaining(['proxy:ok']) });
        expect(await send()).toBe('OK');
        expect(proxy.seen).toEqual(['CONNECT proxied.test:443']);
      });
    });
  }
});
