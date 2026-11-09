import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ICON_SVG } from '../src/backend/app-icon';
import type { RunningBackend } from '../src/backend/backend';
import { FIREFOX_PROFILE_DIR, firefoxPrefs } from '../src/backend/firefox';
import { isLoopback } from '../src/backend/proxy';
import { loadSettings } from '../src/backend/settings';
import type { ProxyStatus } from '../src/shared/api';
import {
  apiClient,
  httpViaProxy,
  moveProxyToPickedPort,
  requestViaProxy,
  startBackendOnPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';

/** This machine's address on the local network, if it has one. */
function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

/** Resolves true if the server closed the connection without answering. */
function isRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let answered = false;
    socket.on('connect', () =>
      socket.write('GET http://wirescry.internal/ HTTP/1.1\r\nHost: wirescry.internal\r\n\r\n'),
    );
    socket.on('data', () => {
      answered = true;
      socket.destroy();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(!answered));
    setTimeout(() => socket.destroy(), 3000);
  });
}

const lastStatus = (messages: { type: string }[]): ProxyStatus | undefined =>
  (messages.filter((m) => m.type === 'status').at(-1) as { status: ProxyStatus } | undefined)?.status;

describe('setup', () => {
  let dataDir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-setup-test-'));
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream.forGet('/hello').thenReply(200, 'hello');
    // Kept across certificate resets: see startBackendOnPickedPort.
    backend = await startBackendOnPickedPort({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await upstream?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('answers this machine but refuses connections from the network', async () => {
    expect(await isRefused('127.0.0.1', backend.proxyPort)).toBe(false);
    const lan = lanAddress();
    if (!lan) return; // No network interface to test from.
    expect(await isRefused(lan, backend.proxyPort)).toBe(true);
  });

  it('serves the setup page and certificate at wirescry.internal', async () => {
    const page = await httpViaProxy(backend.proxyPort, 'http://wirescry.internal/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Wirescry setup');

    // Twice, to check the rule keeps matching after its first use.
    for (let i = 0; i < 2; i++) {
      const cert = await httpViaProxy(backend.proxyPort, 'http://wirescry.internal/certificate');
      expect(cert.type).toBe('application/x-x509-ca-cert');
      expect(cert.body).toBe(await readFile(backend.caCertPath, 'utf8'));
    }
  });

  it('gives the setup page Wirescry’s icon inline, and nothing for /favicon.ico', async () => {
    expect(APP_ICON_SVG).toBe(
      await readFile(path.join(import.meta.dirname, '..', 'build', 'icon.svg'), 'utf8'),
    );
    const page = await httpViaProxy(backend.proxyPort, 'http://wirescry.internal/');
    const href = /<link rel="icon" href="([^"]+)">/.exec(page.body)?.[1];
    expect(href?.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(href!.slice('data:image/svg+xml,'.length))).toBe(APP_ICON_SVG);

    for (const path of [
      '/favicon.ico',
      '/favicon.ico?v=2',
      '/apple-touch-icon.png',
      '/apple-touch-icon-precomposed.png',
    ]) {
      const icon = await httpViaProxy(backend.proxyPort, `http://wirescry.internal${path}`);
      // No content, which Traffic doesn't count as an error.
      expect(icon.status, path).toBe(204);
      expect(icon.body, path).toBe('');
    }
    // Other paths still get the page.
    for (const url of ['http://wirescry.internal/anything', 'http://wirescry.internal/favicon.png']) {
      const other = await httpViaProxy(backend.proxyPort, url);
      expect(other.status, url).toBe(200);
      expect(other.body, url).toContain('Wirescry setup');
    }
  });

  it('marks the Firefox profile trusted when Firefox reaches the check over HTTPS', async () => {
    const api = await apiClient(backend.apiPort);
    const ca = await readFile(backend.caCertPath, 'utf8');
    const hello = api.messages[0] as { status: ProxyStatus };
    expect(hello.status.firefoxTrusted).toBe(false);

    // Plain HTTP proves nothing about trust.
    expect((await httpViaProxy(backend.proxyPort, 'http://wirescry.internal/check')).status).toBe(400);

    const check = await requestViaProxy(backend.proxyPort, 'https://wirescry.internal:443/check', ca, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/150.0' },
    });
    expect(check.status).toBe(200);
    await expect.poll(() => lastStatus(api.messages)?.firefoxTrusted).toBe(true);
    const marker = await readFile(path.join(dataDir, FIREFOX_PROFILE_DIR, 'wirescry-trusted-ca'), 'utf8');
    expect(marker.trim()).toBe(lastStatus(api.messages)?.certificate.spkiFingerprint);
    api.close();
  });

  it('moves the proxy to a chosen port, saves it, and keeps the old port if the new one is taken', async () => {
    const api = await apiClient(backend.apiPort);
    const port = await moveProxyToPickedPort(api);
    expect(backend.proxyPort).toBe(port);
    expect(await loadSettings(dataDir)).toEqual({ proxyPort: port });
    expect(lastStatus(api.messages)).toMatchObject({ proxyPort: port, proxyPortSetting: port });
    expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);

    // Taken on all addresses, on all of IPv4 (which macOS let Wirescry share), and on 127.0.0.1 only.
    for (const host of [undefined, '0.0.0.0', '127.0.0.1']) {
      const blocker = net.createServer();
      await new Promise<void>((resolve) => blocker.listen(0, host, resolve));
      const taken = (blocker.address() as net.AddressInfo).port;
      await expect(api.send({ command: 'setProxyPort', port: taken })).rejects.toThrow(
        `Port ${taken} is already in use.`,
      );
      blocker.close();
    }
    expect(backend.proxyPort).toBe(port);
    expect((await httpViaProxy(port, 'http://wirescry.internal/')).status).toBe(200);

    for (const port of [80, 1023, 65536, 8080.5, '8080', -1]) {
      await expect(api.send({ command: 'setProxyPort', port: port as number }), String(port)).rejects.toThrow(
        '1024 to 65535',
      );
    }

    await api.send({ command: 'setProxyPort', port: null });
    expect(await loadSettings(dataDir)).toEqual({});
    expect(lastStatus(api.messages)?.proxyPortSetting).toBeNull();
    api.close();
  });

  it('resets the certificate: new CA, old one no longer works, Firefox profile removed', async () => {
    const api = await apiClient(backend.apiPort);
    // The reset restarts the proxy on its port. The test before cleared the port setting, which
    // leaves it near 8000, where other test files pick ports too: one took it during a restart.
    await moveProxyToPickedPort(api);
    const oldCA = await readFile(backend.caCertPath, 'utf8');
    const oldStatus = lastStatus(api.messages)!;
    const url = `https://localhost:${upstream.port}/hello`;
    expect((await requestViaProxy(backend.proxyPort, url, oldCA)).status).toBe(200);

    await api.send({ command: 'resetCertificate' });
    const newStatus = lastStatus(api.messages)!;
    expect(newStatus.certificate.spkiFingerprint).not.toBe(oldStatus.certificate.spkiFingerprint);
    expect(newStatus.firefoxTrusted).toBe(false);
    expect(newStatus.proxyPort).toBe(oldStatus.proxyPort);
    await expect(stat(path.join(dataDir, FIREFOX_PROFILE_DIR))).rejects.toThrow();

    const newCA = await readFile(backend.caCertPath, 'utf8');
    expect(newCA).not.toBe(oldCA);
    await expect(requestViaProxy(backend.proxyPort, url, oldCA)).rejects.toThrow();
    expect((await requestViaProxy(backend.proxyPort, url, newCA)).status).toBe(200);
    api.close();
  });
});

describe('firefoxPrefs', () => {
  it('points both HTTP and HTTPS at the proxy, includes localhost, and turns off HTTP/3', () => {
    const prefs = firefoxPrefs(8123);
    expect(prefs).toContain('user_pref("network.proxy.type", 1);');
    expect(prefs).toContain('user_pref("network.proxy.http_port", 8123);');
    expect(prefs).toContain('user_pref("network.proxy.ssl_port", 8123);');
    expect(prefs).toContain('user_pref("network.proxy.allow_hijacking_localhost", true);');
    expect(prefs).toContain('user_pref("network.http.http3.enable", false);');
  });
});

describe('isLoopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.1.20', false],
    ['::ffff:10.0.0.5', false],
    ['fe80::1', false],
    [undefined, false],
  ])('%s → %s', (address, expected) => {
    expect(isLoopback(address)).toBe(expected);
  });
});
