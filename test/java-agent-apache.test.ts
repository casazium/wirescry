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
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fetchTestJars } from '../scripts/build-java-agent.mjs';
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

async function listen<T extends net.Server>(server: T): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function standIn(answer = 'proxied'): Promise<StandIn> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
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
    const jars = await fetchTestJars(v === 4 ? 'apache4' : 'apache5');
    const out = path.join(shared.work, `apache${v}-probe`);
    compileJava(8, out, [path.join(sources, `ApacheProbe${v}.java`)], jars.join(path.delimiter));
    classpath[v] = [out, ...jars].join(path.delimiter);
  }
  isolated = path.join(shared.work, 'isolated');
  compileJava(8, isolated, [path.join(sources, 'Isolated.java')]);
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

async function ask(r: Run, command: string): Promise<string> {
  const before = r.stdout().split('\n').filter(Boolean).length;
  r.send(command);
  await expect
    .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 20_000 })
    .toBeGreaterThan(before);
  return r.stdout().split('\n').filter(Boolean)[before]!.trim();
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
          await expect.poll(() => ask(r, 'route http://proxied.test/'), { timeout: 15_000 }).toBe('DIRECT');
          await agent.update({ enabled: true, proxyPort: moved.port, seq: 3 });
          await expect
            .poll(() => ask(r, 'route http://proxied.test/'), { timeout: 15_000 })
            .toBe(`PROXY 127.0.0.1:${moved.port}`);
          expect(await ask(r, 'early http://proxied.test/m')).toBe('OK moved http://proxied.test/m');
          const id = (await statusOf(agent.dir, r.child.pid))!.id;
          await agent.update({ detached: [id], seq: 4 });
          await expect.poll(() => ask(r, 'route http://proxied.test/'), { timeout: 15_000 }).toBe('DIRECT');
        });

        it('reaches a client built before the agent was attached', async () => {
          const proxy = await standIn();
          const agent = await on(proxy, { startup: false });
          const r = await probe(java, v);
          // The planner's class is loaded, and a client built, before the agent arrives.
          expect(await ask(r, 'early http://proxied.test/before')).toMatch(UNKNOWN_HOST);
          expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
          await expect
            .poll(() => ask(r, 'early http://proxied.test/after'), { timeout: 20_000 })
            .toBe('OK proxied http://proxied.test/after');
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
  }
});
