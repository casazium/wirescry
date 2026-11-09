/**
 * PR 5b: connections from a captured device that refuse Wirescry's certificate, and Android's
 * own traffic (android-design.md, "Measured for PR 5b").
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanHost, MAX_REFUSED_HOSTS, Refusals } from '../src/backend/android/refusals';
import { AndroidSetup } from '../src/backend/android/setup';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { addOpenSslAlertReason } from '../src/backend/proxy';
import type { DeviceListeners } from '../src/backend/device-listeners';
import {
  ANDROID_PROBE_URLS,
  ANDROID_SYSTEM_HOSTS,
  HIDE_ANDROID_SYSTEM_QUERY,
  isAndroidSystemHost,
} from '../src/shared/android-system';
import type {
  AndroidDevice,
  ExchangeSource,
  ExchangeSummary,
  ProxyStatus,
  ServerMessage,
} from '../src/shared/api';
import { compileQuery } from '../src/shared/query';
import { fakeDeviceState, startDeviceServer, type FakeDeviceState } from './fake-adb';
import { apiClient, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

let other: string;
beforeAll(async () => {
  other = (await generateCACertificate({ subject: { commonName: 'Not Wirescry' } })).cert;
});

const exchange = (host: string, path = '/', scheme = 'https'): ExchangeSummary =>
  ({
    id: `${scheme}${host}${path}`,
    method: 'GET',
    protocol: scheme,
    httpVersion: '1.1',
    host,
    path,
    url: `${scheme}://${host}${path}`,
    startedAt: 0,
  }) as ExchangeSummary;
const fromUrl = (url: string): ExchangeSummary => {
  const parsed = new URL(url);
  return exchange(parsed.host, parsed.pathname + parsed.search, parsed.protocol.slice(0, -1));
};

describe('Android’s own traffic', () => {
  const hide = compileQuery(HIDE_ANDROID_SYSTEM_QUERY);

  it('is a search the Traffic box reads without complaint', () => {
    expect(hide.errors).toEqual([]);
    expect(hide.hints).toEqual([]);
  });

  it('hides every measured system host and the connectivity check’s probes', () => {
    for (const host of ANDROID_SYSTEM_HOSTS) expect(hide.matches(exchange(host, '/anything'))).toBe(false);
    // As measured: the connectivity check's plain-HTTP probes.
    for (const url of [
      'http://connectivitycheck.gstatic.com/generate_204',
      'http://www.google.com/gen_204',
      'http://play.googleapis.com/generate_204',
      'https://play.googleapis.com/v1/details',
      ...ANDROID_PROBE_URLS,
    ]) {
      expect(hide.matches(fromUrl(url)), url).toBe(false);
    }
  });

  it('keeps everything else, including the probe hosts’ other paths and look-alike hosts', () => {
    for (const kept of [
      exchange('api.example.com', '/v1/items'),
      exchange('www.google.com', '/search'),
      exchange('connectivitycheck.gstatic.com.example.test'),
      exchange('my-connectivitycheck.gstatic.com'),
      exchange('safebrowsing.googleapis.com.evil.test'),
      exchange('api.example.com', '/generate_2040'),
      exchange('api.example.com', '/v1/generate_204'),
      // The same paths elsewhere: YouTube's, Chrome's own logging, a query, an app's endpoint.
      fromUrl('https://www.youtube.com/generate_204'),
      fromUrl('https://rr1---sn-abc.googlevideo.com/generate_204'),
      fromUrl('https://www.google.com/gen_204'),
      fromUrl('http://www.google.com/gen_204?atyp=i'),
      // Hosts many apps use (Firebase and others): not Android's own.
      fromUrl('https://www.gstatic.com/generate_204'),
      fromUrl('https://firebasestorage.googleapis.com/v0/b/x'),
      fromUrl('https://storage.googleapis.com/bucket/file'),
      fromUrl('http://api.example.com/generate_204'),
    ]) {
      expect(hide.matches(kept), kept.url).toBe(true);
    }
  });

  it('counts the connectivity check’s HTTPS probe host as Android’s, in any case, and nothing else', () => {
    expect(isAndroidSystemHost('www.google.com')).toBe(true);
    expect(isAndroidSystemHost('ConnectivityCheck.GSTATIC.com')).toBe(true);
    // Play services' own, as measured (including the misspelled one).
    for (const host of [
      'play.googleapis.com',
      'android.googleapis.com',
      'android.apis.google.com',
      'proactivebackend-pa.googleapis.com',
      'voilatile-pa.googleapis.com',
    ]) {
      expect(isAndroidSystemHost(host), host).toBe(true);
    }
    for (const host of ANDROID_SYSTEM_HOSTS) expect(isAndroidSystemHost(host)).toBe(true);
    for (const host of [
      '',
      'google.com',
      'youtubei.googleapis.com',
      'api.example.com',
      'www.google.com.evil.test',
      // Hosts apps use too.
      'www.gstatic.com',
      'www.googleapis.com',
      'storage.googleapis.com',
      'volatile-pa.googleapis.com',
    ]) {
      expect(isAndroidSystemHost(host), host).toBe(false);
    }
  });
});

describe('Counting refused connections', () => {
  it('counts per device and host, the most frequent first, then by name', () => {
    const refusals = new Refusals();
    for (const host of ['b.test', 'a.test', 'c.test', 'c.test', 'b.test', 'c.test'])
      refusals.add('one', host);
    refusals.add('two', 'b.test');
    expect(refusals.of('one')).toEqual({
      count: 6,
      hosts: [
        { host: 'c.test', count: 3 },
        { host: 'b.test', count: 2 },
        { host: 'a.test', count: 1 },
      ],
    });
    expect(refusals.of('two')).toEqual({ count: 1, hosts: [{ host: 'b.test', count: 1 }] });
  });

  it('has nothing for a device without refusals, or once cleared', () => {
    const refusals = new Refusals();
    expect(refusals.of('one')).toBeUndefined();
    refusals.add('one', 'a.test');
    refusals.add('two', 'a.test');
    refusals.clear('one');
    expect(refusals.of('one')).toBeUndefined();
    expect(refusals.of('two')?.count).toBe(1);
  });

  it('keeps 50 hosts a device, still counting the rest and the hosts it has', () => {
    const refusals = new Refusals();
    for (let i = 0; i < MAX_REFUSED_HOSTS + 10; i++)
      refusals.add('one', `host${String(i).padStart(2, '0')}.test`);
    refusals.add('one', 'host00.test');
    refusals.add('one', 'host99.test');
    const of = refusals.of('one')!;
    expect(of.count).toBe(MAX_REFUSED_HOSTS + 12);
    expect(of.hosts).toHaveLength(MAX_REFUSED_HOSTS);
    expect(of.hosts[0]).toEqual({ host: 'host00.test', count: 2 });
    expect(of.hosts.some((h) => h.host === 'host99.test')).toBe(false);
  });

  it('shows a hostname the device sent in lower case, without a final dot', () => {
    expect(cleanHost('API.Example.TEST.')).toBe('api.example.test');
    expect(cleanHost('localhost')).toBe('localhost');
    expect(cleanHost('_dns.example.test')).toBe('_dns.example.test');
    expect(cleanHost(`${'a'.repeat(63)}.test`)).toBe(`${'a'.repeat(63)}.test`);
  });

  it('shows anything that isn’t a hostname as none: it comes from the device', () => {
    for (const bad of [
      undefined,
      '',
      '.',
      'a b.test',
      'evil.test\nInjected: yes',
      '<img src=x>.test',
      'a..b.test',
      '-start.test',
      'end-.test',
      'café.test',
      `${'a'.repeat(64)}.test`,
      `${'a.'.repeat(127)}test`,
    ]) {
      expect(cleanHost(bad), JSON.stringify(bad)).toBe('');
    }
    const refusals = new Refusals();
    refusals.add('one', 'a b.test');
    refusals.add('one', undefined);
    expect(refusals.of('one')).toEqual({ count: 2, hosts: [{ host: '', count: 2 }] });
  });
});

let dir: string;
let phone: FakeDeviceState;
let fake: Awaited<ReturnType<typeof startDeviceServer>>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-refusals-'));
  phone = fakeDeviceState();
  fake = await startDeviceServer([phone]);
});
afterEach(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

function fakeListeners(): DeviceListeners {
  const opened = new Map<string, { source: ExchangeSource; port: number }>();
  return {
    async open(source, port) {
      if (!opened.has(source.id)) opened.set(source.id, { source, port: port ?? 9001 });
      return { port: opened.get(source.id)!.port };
    },
    async close(id) {
      opened.delete(id);
    },
    list: () => [...opened.values()].map((l) => ({ ...l, localAccess: false })),
    setLocalAccess() {},
    onPortChange: () => () => undefined,
  };
}

describe('Refused connections through Android setup', () => {
  const started: AndroidSetup[] = [];
  afterEach(() => {
    for (const setup of started.splice(0)) setup.stop();
  });

  let current: { cert: string; spki: string };
  async function setup(pollMs = 60_000) {
    let changes = 0;
    current = { cert: 'unused', spki: 'A'.repeat(43) + '=' };
    const android = new AndroidSetup({
      endpoint: () => fake.endpoint,
      findAdb: () => undefined,
      retryDelaysMs: [30],
      timeoutMs: 1000,
      onStatusChange: () => (changes += 1),
      capture: {
        listeners: fakeListeners(),
        recordsDir: path.join(dir, 'records'),
        readBackMs: 200,
        pollMs,
        certificate: () => current,
        trustFile: path.join(dir, 'trust.json'),
      },
    });
    started.push(android);
    await android.start();
    const device = (): AndroidDevice | undefined => android.status().devices[0];
    await expect.poll(() => device()?.id).toBeTruthy();
    return { android, device, id: device()!.id!, changes: () => changes };
  }
  const only = (host: string) => ({ count: 1, hosts: [{ host, count: 1 }] });

  it('shows refusals only while capturing, each capture starting afresh', async () => {
    const { android, device, id } = await setup();
    android.certificateRefused(id, 'before.test');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(device()?.refused).toBeUndefined();
    await android.captureDevice(id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(device()?.refused).toBeUndefined();

    android.certificateRefused(id, 'during.test');
    await expect.poll(() => device()?.refused).toEqual(only('during.test'));

    await android.stopDevice(id);
    expect(device()?.refused).toBeUndefined();
    // A late one, after Stop, isn't shown, nor carried into the next capture.
    android.certificateRefused(id, 'after.test');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(device()?.refused).toBeUndefined();
    await android.captureDevice(id);
    android.certificateRefused(id, 'next.test');
    await expect.poll(() => device()?.refused).toEqual(only('next.test'));
    await android.stopDevice(id);
  });

  it('starts afresh after a capture that ended without Stop (its proxy changed on the device)', async () => {
    const { android, device, id } = await setup(100);
    await android.captureDevice(id);
    android.certificateRefused(id, 'first.test');
    await expect.poll(() => device()?.refused?.count).toBe(1);
    phone.settings.set('http_proxy', '10.0.0.9:3128');
    phone.settings.set('global_http_proxy_host', '10.0.0.9');
    await expect.poll(() => device()?.capture, { timeout: 5000 }).toBeUndefined();
    await android.captureDevice(id, '10.0.0.9:3128');
    await expect.poll(() => device()?.capture).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(device()?.refused).toBeUndefined();
    android.certificateRefused(id, 'second.test');
    await expect.poll(() => device()?.refused).toEqual(only('second.test'));
    await android.stopDevice(id);
  });

  it('keeps counting while a Stop fails and the device stays captured', async () => {
    const { android, device, id } = await setup();
    await android.captureDevice(id);
    android.certificateRefused(id, 'first.test');
    await expect.poll(() => device()?.refused?.count).toBe(1);
    phone.failShell = true;
    await expect(android.stopDevice(id)).rejects.toThrow();
    phone.failShell = false;
    expect(device()?.capture).toBeTruthy();
    android.certificateRefused(id, 'first.test');
    await expect.poll(() => device()?.refused?.count).toBe(2);
    await android.stopDevice(id);
  });

  it('forgets refusals once the device trusts the certificate, and when it changes', async () => {
    const { android, device, id } = await setup();
    await android.captureDevice(id);
    android.certificateRefused(id, 'chrome.test');
    await expect.poll(() => device()?.refused?.count).toBe(1);
    // Trust in another (old) certificate: not news for this one.
    await android.markTrusted(id, 'B'.repeat(43) + '=');
    expect(device()?.refused?.count).toBe(1);
    await android.markTrusted(id, current.spki);
    expect(device()?.certificate?.trusted).toBe(true);
    expect(device()?.refused).toBeUndefined();

    android.certificateRefused(id, 'bank.test');
    await expect.poll(() => device()?.refused).toEqual(only('bank.test'));
    // Trusted already: a check passing again doesn't hide what still refuses.
    await android.markTrusted(id, current.spki);
    expect(device()?.refused).toEqual(only('bank.test'));

    android.certificateChanged();
    expect(device()?.refused).toBeUndefined();
    await android.stopDevice(id);
  });

  it('sends a burst of refusals as one update, and nothing once stopped', async () => {
    const { android, device, id, changes } = await setup();
    await android.captureDevice(id);
    const before = changes();
    for (let i = 0; i < 200; i++) android.certificateRefused(id, 'burst.test');
    await expect.poll(() => device()?.refused?.count).toBe(200);
    expect(changes() - before).toBeLessThanOrEqual(2);

    // Stopped with an update still due: it never comes.
    android.certificateRefused(id, 'burst.test');
    android.stop();
    const after = changes();
    android.certificateRefused(id, 'burst.test');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changes()).toBe(after);
  });
});

/** A CONNECT tunnel through a proxy, to `authority`. */
function tunnel(port: number, authority: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority });
    req.once('connect', (res, socket) =>
      res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode}`)),
    );
    req.once('error', reject);
    req.end();
  });
}

/** TLS alert record: fatal, unknown_ca (RFC 5246 §7.2), in the clear as TLS 1.2 handshakes send it. */
const UNKNOWN_CA_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x30]);

/**
 * Starts a TLS 1.2 handshake through a tunnel and, when the proxy's certificate arrives, does
 * `onServerHello` with the raw tunnel. Node's own client checks certificates only after the
 * handshake, so it can't refuse the way Android's does.
 */
async function handshake(
  port: number,
  host: string,
  servername: string,
  onServerHello: (raw: net.Socket) => void,
): Promise<void> {
  const raw = await tunnel(port, `${host}:443`);
  await new Promise<void>((resolve) => {
    let answered = false;
    const relay = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (raw.writable) raw.write(chunk, () => done());
        else done();
      },
    });
    raw.on('data', (data: Buffer) => {
      if (!answered) {
        answered = true;
        onServerHello(raw);
      }
      relay.push(data);
    });
    raw.once('close', () => {
      relay.push(null);
      resolve();
    });
    raw.on('error', () => undefined);
    tls.connect({ socket: relay, servername, maxVersion: 'TLSv1.2', ca: other }).on('error', () => undefined);
  });
}

/** A fatal TLS 1.2 alert record, in the clear. */
const alertRecord = (description: number): Buffer =>
  Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]);

/** Refuses the certificate with a TLS alert, as Android apps that ignore user certificates do (measured). */
const refuse = (
  port: number,
  host: string,
  servername = host,
  alert: Buffer = UNKNOWN_CA_ALERT,
): Promise<void> => handshake(port, host, servername, (raw) => raw.end(alert));

/** Goes away mid-handshake without a word, as a client dropping a spare connection. */
const drop = (port: number, host: string): Promise<void> =>
  handshake(port, host, host, (raw) => raw.destroy());

describe('Refused connections through the backend', () => {
  let backend: RunningBackend | undefined;
  beforeEach(async () => {
    const endpoint = fake.endpoint;
    backend = await startBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      docker: false,
      android: { endpoint: () => endpoint, findAdb: () => undefined },
    });
  });
  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
  });

  const last = (messages: ServerMessage[]): ProxyStatus | undefined =>
    messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);

  it('shows, by host, the connections the device’s listener saw refuse the certificate', async () => {
    const api = await apiClient(backend!.apiPort);
    try {
      const device = () => last(api.messages)?.android?.devices[0];
      await expect.poll(() => device()?.id).toBeTruthy();
      const id = device()!.id!;
      await api.send({ command: 'androidCapture', deviceId: id });
      await expect.poll(() => device()?.capture).toBeTruthy();
      expect(device()!.refused).toBeUndefined();
      const { hostPort } = device()!.capture!;

      await refuse(hostPort, 'api.example.test');
      await refuse(hostPort, 'api.example.test');
      await refuse(hostPort, 'www.google.com');
      // An IP address: no hostname is sent.
      await refuse(hostPort, '203.0.113.9', '');
      await expect
        .poll(() => device()?.refused)
        .toEqual({
          count: 4,
          hosts: [
            { host: 'api.example.test', count: 2 },
            { host: '', count: 1 },
            { host: 'www.google.com', count: 1 },
          ],
        });
    } finally {
      api.close();
    }
  });

  it('doesn’t count connections that trust it, drop out, go to the check, or use the main proxy', async () => {
    const api = await apiClient(backend!.apiPort);
    try {
      const device = () => last(api.messages)?.android?.devices[0];
      await expect.poll(() => device()?.id).toBeTruthy();
      const id = device()!.id!;
      await api.send({ command: 'androidCapture', deviceId: id });
      await expect.poll(() => device()?.capture).toBeTruthy();
      const { hostPort } = device()!.capture!;
      const pem = await readFile(backend!.caCertPath, 'utf8');

      // Trusted: the check passes and the device shows trusted.
      expect((await requestViaProxy(hostPort, 'https://wirescry.internal:443/check', pem)).status).toBe(200);
      await expect.poll(() => device()?.certificate?.trusted).toBe(true);
      // A connection that goes away mid-handshake isn't a refusal...
      await drop(hostPort, 'api.example.test');
      // ...nor is one to this computer's own proxy, nor the check refusing it (trust covers that).
      await refuse(backend!.proxyPort, 'api.example.test');
      await refuse(hostPort, 'wirescry.internal');
      await expect.poll(() => device()?.certificate?.trusted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(device()!.refused).toBeUndefined();

      // The drop above did reach the listener as a TLS failure: to the check, it counts against trust.
      expect((await requestViaProxy(hostPort, 'https://wirescry.internal:443/check', pem)).status).toBe(200);
      await expect.poll(() => device()?.certificate?.trusted).toBe(true);
      await drop(hostPort, 'wirescry.internal');
      await expect.poll(() => device()?.certificate?.trusted).toBe(false);
      expect(device()!.refused).toBeUndefined();

      // One refusal shows; Stop clears it.
      await refuse(hostPort, 'api.example.test');
      await expect.poll(() => device()?.refused?.count).toBe(1);
      await api.send({ command: 'androidStop', deviceId: id });
      await expect.poll(() => device()?.capture).toBeUndefined();
      expect(device()!.refused).toBeUndefined();
    } finally {
      api.close();
    }
  });
});

describe('TLS alerts worded by BoringSSL, as in the app', () => {
  // Electron's Node is built on BoringSSL, measured November 9, 2026 with Chrome on an API 37
  // emulator refusing the certificate: code ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN, message
  // "...:SSL routines:OPENSSL_internal:SSLV3_ALERT_CERTIFICATE_UNKNOWN:...". Node's OpenSSL
  // says ERR_SSL_TLS_ALERT_CERTIFICATE_UNKNOWN or ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN
  // (by version), with the words in lower case.
  const boringSsl = (code: string): Error & { code: string } =>
    Object.assign(
      new Error(`error:10000416:SSL routines:OPENSSL_internal:${code.slice(8)}:tls_record.cc:491`),
      {
        code,
      },
    );

  it('adds OpenSSL’s words for an alert the client sent', () => {
    const certificateUnknown = boringSsl('ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN');
    addOpenSslAlertReason(certificateUnknown);
    expect(certificateUnknown.message).toMatch(/\(sslv3 alert certificate unknown\)$/);
    const unknownCa = boringSsl('ERR_SSL_TLSV1_ALERT_UNKNOWN_CA');
    addOpenSslAlertReason(unknownCa);
    expect(unknownCa.message).toMatch(/\(tlsv1 alert unknown ca\)$/);
  });

  it('leaves OpenSSL’s own errors, other failures and anything without a code as they were', () => {
    const openSsl = Object.assign(new Error('error:0A000416:SSL routines::sslv3 alert certificate unknown'), {
      code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
    });
    const others = [
      openSsl,
      boringSsl('ERR_SSL_WRONG_VERSION_NUMBER'),
      boringSsl('ERR_SSL_NO_SHARED_CIPHER'),
      // Alerts OpenSSL words without "alert": not refusals under Node either.
      boringSsl('ERR_SSL_TLSV1_ALERT_BAD_CERTIFICATE_STATUS_RESPONSE'),
      boringSsl('ERR_SSL_TLSV1_ALERT_CERTIFICATE_UNOBTAINABLE'),
      boringSsl('ERR_SSL_TLSV1_ALERT_BAD_CERTIFICATE_HASH_VALUE'),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      Object.assign(new Error('SSLV3_ALERT_CERTIFICATE_UNKNOWN'), { code: 42 }),
      new Error('SSLV3_ALERT_CERTIFICATE_UNKNOWN'),
    ];
    const before = others.map((error) => error.message);
    for (const error of others) addOpenSslAlertReason(error);
    expect(others.map((error) => error.message)).toEqual(before);
    expect(() => addOpenSslAlertReason(undefined)).not.toThrow();
    expect(() => addOpenSslAlertReason({ code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' })).not.toThrow();
  });

  describe('through the backend', () => {
    let backend: RunningBackend | undefined;
    const emit = EventEmitter.prototype.emit;
    beforeEach(async () => {
      // Words every failed handshake's error as Electron's Node does, before anyone reads it.
      // Patched before the backend starts: the proxy keeps the emit it finds.
      EventEmitter.prototype.emit = function (
        this: EventEmitter,
        event: string | symbol,
        ...args: unknown[]
      ) {
        const error = args[0] as { code?: unknown; message?: string } | undefined;
        if (
          event === 'tlsClientError' &&
          typeof error?.code === 'string' &&
          error.code.startsWith('ERR_SSL_')
        ) {
          // BoringSSL's codes for alerts 40 to 46 say SSLV3 where OpenSSL's say TLS or SSL/TLS,
          // by version.
          const code = error.code.replace(/^ERR_SSL_(?:SSL\/)?TLS_ALERT_/, 'ERR_SSL_SSLV3_ALERT_');
          error.code = code;
          error.message = boringSsl(code).message;
        }
        return emit.call(this, event, ...args);
      };
      const endpoint = fake.endpoint;
      try {
        backend = await startBackend({
          dataDir: dir,
          token: TOKEN,
          allowedOrigins: [UI_ORIGIN],
          docker: false,
          android: { endpoint: () => endpoint, findAdb: () => undefined },
        });
      } catch (error) {
        EventEmitter.prototype.emit = emit;
        throw error;
      }
    });
    afterEach(async () => {
      await backend?.stop();
      backend = undefined;
      EventEmitter.prototype.emit = emit;
    });

    const last = (messages: ServerMessage[]): ProxyStatus | undefined =>
      messages.flatMap((m) => (m.type === 'status' || m.type === 'hello' ? [m.status] : [])).at(-1);

    it('counts refusals, Chrome’s certificate_unknown included, but not other alerts', async () => {
      const api = await apiClient(backend!.apiPort);
      try {
        const device = () => last(api.messages)?.android?.devices[0];
        await expect.poll(() => device()?.id).toBeTruthy();
        const id = device()!.id!;
        await api.send({ command: 'androidCapture', deviceId: id });
        await expect.poll(() => device()?.capture).toBeTruthy();
        const { hostPort } = device()!.capture!;

        // handshake_failure (40) says nothing about the certificate.
        await refuse(hostPort, 'other.example.test', undefined, alertRecord(40));
        // certificate_unknown (46), as Chrome sends, and unknown_ca (48).
        await refuse(hostPort, 'example.com', undefined, alertRecord(46));
        await refuse(hostPort, 'api.example.test', undefined, alertRecord(48));
        await expect
          .poll(() => device()?.refused)
          .toEqual({
            count: 2,
            hosts: [
              { host: 'api.example.test', count: 1 },
              { host: 'example.com', count: 1 },
            ],
          });
      } finally {
        api.close();
      }
    });

    it('sees the check refused, so the device no longer shows trusted', async () => {
      const api = await apiClient(backend!.apiPort);
      try {
        const device = () => last(api.messages)?.android?.devices[0];
        await expect.poll(() => device()?.id).toBeTruthy();
        await api.send({ command: 'androidCapture', deviceId: device()!.id! });
        await expect.poll(() => device()?.capture).toBeTruthy();
        const { hostPort } = device()!.capture!;
        const pem = await readFile(backend!.caCertPath, 'utf8');
        expect((await requestViaProxy(hostPort, 'https://wirescry.internal:443/check', pem)).status).toBe(
          200,
        );
        await expect.poll(() => device()?.certificate?.trusted).toBe(true);
        // A refusal the TLS layer reports, not one the connection's closing shows.
        await refuse(hostPort, 'wirescry.internal', undefined, alertRecord(46));
        await expect.poll(() => device()?.certificate?.trusted).toBe(false);
      } finally {
        api.close();
      }
    });
  });
});
