/**
 * The Java agent's trust hook (native/java-agent: Hooks, Trust, TrustAdvice): with Wirescry's CA
 * in the control file, the JDK's own certificate checks accept servers Wirescry's CA signed, for
 * the right host, and still reject everything else. Real JVMs against HTTPS servers made here.
 *
 * What it needs to run: see test/java-agent-helpers.ts.
 */
import { createRequire } from 'node:module';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterAll, describe, expect, it } from 'vitest';
import { caSha256, writeWhole } from '../src/backend/java/agent-files';
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

interface Ca {
  key: string;
  cert: string;
  /** Its PEM file, readable by the agent. */
  file: string;
  sha256: string;
}

/** A key and certificate for `host`, signed by `ca`. */
async function certificateFor(ca: Ca, host: string): Promise<{ key: string; cert: string }> {
  const require = createRequire(import.meta.url);
  const { getCA } = require('mockttp/dist/util/certificates') as {
    getCA(options: { key: string; cert: string }): Promise<{
      generateCertificate(domain: string): Promise<{ key: string; cert: string }>;
    }>;
  };
  return (await getCA(ca)).generateCertificate(host);
}

const servers: https.Server[] = [];

/** An HTTPS server on 127.0.0.1 with a certificate for `host` from `ca`. Returns its URL. */
async function serve(ca: Ca, host: string): Promise<string> {
  const server = https.createServer(await certificateFor(ca, host), (_, res) => res.end('ok'));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `https://localhost:${(server.address() as AddressInfo).port}/`;
}

let probes: string;
/** Wirescry's CA, another CA, and the CA Wirescry has after a reset. */
let wirescry: Ca;
let other: Ca;
let reset: Ca;
let url: { good: string; other: string; wrongHost: string; afterReset: string };

setUpJavaAgentTests(async () => {
  const makeCa = async (name: string): Promise<Ca> => {
    const { key, cert } = await generateCACertificate({ subject: { commonName: `Test ${name} CA` } });
    const file = path.join(shared.work, `${name}-ca.pem`);
    await writeFile(file, cert, { mode: 0o644 });
    return { key, cert, file, sha256: caSha256(cert) };
  };
  [wirescry, other, reset] = [await makeCa('wirescry'), await makeCa('other'), await makeCa('reset')];
  url = {
    good: await serve(wirescry, 'localhost'),
    other: await serve(other, 'localhost'),
    wrongHost: await serve(wirescry, 'elsewhere.test'),
    afterReset: await serve(reset, 'localhost'),
  };
  probes = path.join(shared.work, 'tls-probes');
  const sources = path.join(import.meta.dirname, 'java');
  compileJava(8, probes, [path.join(sources, 'TlsProbe.java')]);
  compileJava(11, probes, [path.join(sources, 'TlsProbeHttpClient.java')]);
});

afterAll(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The control file's CA settings for `ca`. */
const caSettings = (ca: Ca) => ({ caPath: ca.file, caSha256: ca.sha256 });

/** A TLS probe, ready to connect. */
async function tlsProbe(java: string, args: string[], jvm: string[] = []): Promise<Run> {
  const mainClass = args[0] === 'httpclient' ? 'TlsProbeHttpClient' : 'TlsProbe';
  const r = run(java, [...jvm, '-cp', probes, mainClass, ...args.slice(args[0] === 'httpclient' ? 1 : 0)], {
    stdin: true,
  });
  await expect.poll(r.stdout, { timeout: 15_000 }).toContain('ready');
  return r;
}

/** Connects once and returns "OK" or "FAIL <exception>". */
async function connect(r: Run): Promise<string> {
  const before = r.stdout().split('\n').filter(Boolean).length;
  r.send('');
  await expect
    .poll(() => r.stdout().split('\n').filter(Boolean).length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  return r.stdout().split('\n').filter(Boolean)[before]!.trim();
}

describe.skipIf(!buildJava)('the Java agent’s trust hook', () => {
  for (const java of javas) {
    const major = majorOf(java);
    describe(`on Java ${major}`, () => {
      it('changes nothing without the agent: Wirescry’s CA isn’t trusted', async () => {
        const r = await tlsProbe(java, ['url', url.good]);
        expect(await connect(r)).toMatch(/^FAIL .*SSLHandshakeException/);
      });

      it('trusts a server Wirescry’s CA signed, and only for its host (HttpsURLConnection)', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const jvm = [`-javaagent:${agent.stub}`];
        const good = await tlsProbe(java, ['url', url.good], jvm);
        expect(await connect(good)).toBe('OK');
        await expect.poll(() => statusOf(agent.dir, good.child.pid)).toMatchObject({ hooks: ['trust:ok'] });
        // Not another CA's, and not Wirescry's for the wrong host.
        expect(await connect(await tlsProbe(java, ['url', url.other], jvm))).toMatch(/^FAIL /);
        expect(await connect(await tlsProbe(java, ['url', url.wrongHost], jvm))).toMatch(/^FAIL /);
        expect(good.stderr()).toBe('');
      });

      it('checks the host on an SSLSocket the same way', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const jvm = [`-javaagent:${agent.stub}`];
        expect(await connect(await tlsProbe(java, ['socket', url.good], jvm))).toBe('OK');
        expect(await connect(await tlsProbe(java, ['socket', url.wrongHost], jvm))).toMatch(/^FAIL /);
        expect(await connect(await tlsProbe(java, ['socket', url.other], jvm))).toMatch(/^FAIL /);
      });

      it('also reaches a program’s own trust store, which keeps trusting what it did', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const jvm = [`-javaagent:${agent.stub}`];
        // A store with only the other CA: the JDK's own trust manager, so Wirescry's CA counts too.
        expect(await connect(await tlsProbe(java, ['store', url.good, other.file], jvm))).toBe('OK');
        expect(await connect(await tlsProbe(java, ['store', url.other, other.file], jvm))).toBe('OK');
        expect(await connect(await tlsProbe(java, ['store', url.wrongHost, other.file], jvm))).toMatch(
          /^FAIL /,
        );
      });

      it('leaves a hand-written trust manager alone', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const r = await tlsProbe(java, ['own', url.good], [`-javaagent:${agent.stub}`]);
        expect(await connect(r)).toMatch(/^FAIL /);
      });

      it('trusts only while the agent is on', async () => {
        const agent = await agentFolder({ ...caSettings(wirescry), enabled: false });
        const r = await tlsProbe(java, ['url', url.good], [`-javaagent:${agent.stub}`]);
        expect(await connect(r)).toMatch(/^FAIL /);
        await agent.update({ enabled: true });
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: true });
        expect(await connect(r)).toBe('OK');
        await agent.update({ enabled: false });
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ enabled: false });
        expect(await connect(r)).toMatch(/^FAIL /);
      });

      it('follows a CA reset, and stops trusting the old CA', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const old = await tlsProbe(java, ['url', url.good], [`-javaagent:${agent.stub}`]);
        const fresh = await tlsProbe(java, ['url', url.afterReset], [`-javaagent:${agent.stub}`]);
        expect(await connect(old)).toBe('OK');
        expect(await connect(fresh)).toMatch(/^FAIL /);
        await agent.update(caSettings(reset));
        await expect
          .poll(() => statusOf(agent.dir, old.child.pid))
          .toMatchObject({ appliedConfig: agent.control().config, caSha256: reset.sha256 });
        await expect
          .poll(() => statusOf(agent.dir, fresh.child.pid))
          .toMatchObject({ caSha256: reset.sha256 });
        expect(await connect(old)).toMatch(/^FAIL /);
        expect(await connect(fresh)).toBe('OK');
      });

      it('trusts no CA whose file doesn’t match the hash Wirescry gave', async () => {
        // The file is another CA's: someone swapped it, or it's stale.
        const agent = await agentFolder({ caPath: other.file, caSha256: wirescry.sha256 });
        const r = await tlsProbe(java, ['url', url.good], [`-javaagent:${agent.stub}`]);
        expect(await connect(r)).toMatch(/^FAIL /);
        const r2 = await tlsProbe(java, ['url', url.other], [`-javaagent:${agent.stub}`]);
        // The other CA isn't trusted either: it doesn't match.
        expect(await connect(r2)).toMatch(/^FAIL /);
      });

      it.skipIf(!posix)('trusts no CA file that other users can change', async () => {
        const file = path.join(shared.work, `writable-ca-${major}.pem`);
        await writeFile(file, wirescry.cert);
        await chmod(file, 0o664);
        const agent = await agentFolder({ caPath: file, caSha256: wirescry.sha256 });
        const r = await tlsProbe(java, ['url', url.good], [`-javaagent:${agent.stub}`]);
        expect(await connect(r)).toMatch(/^FAIL /);
      });

      it('reaches clients built before it was attached', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const r = await tlsProbe(java, ['url', url.good]);
        expect(await connect(r)).toMatch(/^FAIL /);
        expectAttached(['load', String(r.child.pid), agent.stub, `id=${newId()}`]);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: true, hooks: ['trust:ok'] });
        expect(await connect(r)).toBe('OK');
      });

      it.skipIf(major < 11)(
        'reaches Java’s HttpClient (an SSLEngine), even one built before the attach',
        async () => {
          const agent = await agentFolder(caSettings(wirescry));
          const atStart = await tlsProbe(java, ['httpclient', url.good], [`-javaagent:${agent.stub}`]);
          expect(await connect(atStart)).toBe('OK');
          const wrong = await tlsProbe(java, ['httpclient', url.wrongHost], [`-javaagent:${agent.stub}`]);
          expect(await connect(wrong)).toMatch(/^FAIL /);
          const before = await tlsProbe(java, ['httpclient', url.good]);
          expect(await connect(before)).toMatch(/^FAIL /);
          expectAttached(['load', String(before.child.pid), agent.stub, `id=${newId()}`]);
          await expect
            .poll(() => statusOf(agent.dir, before.child.pid), { timeout: 10_000 })
            .toMatchObject({ enabled: true, hooks: ['trust:ok'] });
          expect(await connect(before)).toBe('OK');
        },
      );

      it('takes a relative CA path as a damaged control file', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const file = path.join(agent.dir, 'control.properties');
        await writeWhole(file, (await readFile(file, 'utf8')).replace(/caPath=.*/, 'caPath=wirescry-ca.pem'));
        const r = await tlsProbe(java, ['url', url.good], [`-javaagent:${agent.stub}`]);
        expect(await connect(r)).toMatch(/^FAIL /);
        await expect
          .poll(() => statusOf(agent.dir, r.child.pid), { timeout: 10_000 })
          .toMatchObject({ enabled: false, reason: 'bad-control' });
      });

      it('says the hook is waiting until the program first checks a certificate', async () => {
        const agent = await agentFolder(caSettings(wirescry));
        const r = await tlsProbe(java, ['own', url.good], [`-javaagent:${agent.stub}`]);
        // The hand-written manager never loads the JDK's.
        await expect.poll(() => statusOf(agent.dir, r.child.pid)).toMatchObject({ hooks: ['trust:waiting'] });
      });
    });
  }
});
