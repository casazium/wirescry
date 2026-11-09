/**
 * HTTPS connections through the main proxy (this computer's programs, or its containers) that
 * refuse Wirescry's certificate: counted by host and sent with the status (ProxyStatus.refused),
 * so Traffic can say why their requests are missing. A device's are its own (android-refusals).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REFUSALS_PUBLISH_MS, type RunningBackend } from '../src/backend/backend';
import type { ExchangeSource, ProxyStatus, ServerMessage } from '../src/shared/api';
import {
  apiClient,
  moveProxyToPickedPort,
  NOTHING_LISTENS,
  requestViaProxy,
  startBackendOnPickedPort,
  TOKEN,
  UI_ORIGIN,
} from './helpers';
import { alertRecord, drop, refuse } from './tls-refuse';

const PIXEL: ExchangeSource = { kind: 'android', id: 'a'.repeat(32), label: 'Pixel 8' };

let dataDir: string;
let backend: RunningBackend;
let api: Awaited<ReturnType<typeof apiClient>>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-computer-refusals-'));
  backend = await startBackendOnPickedPort({
    dataDir,
    token: TOKEN,
    allowedOrigins: [UI_ORIGIN],
    docker: false,
  });
  api = await apiClient(backend.apiPort);
});
afterEach(async () => {
  api?.close();
  await backend?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const statuses = (): ProxyStatus[] =>
  api.messages.flatMap((m: ServerMessage) => (m.type === 'status' || m.type === 'hello' ? [m.status] : []));
const refused = () => statuses().at(-1)?.refused;
/** Long enough for a refusal to have been sent, had it counted. */
const settle = () => new Promise((resolve) => setTimeout(resolve, REFUSALS_PUBLISH_MS + 250));

describe('Refusals through the main proxy', () => {
  it('are counted by host, the most frequent first, and sent with the status', async () => {
    expect(refused()).toBeUndefined();
    await refuse(backend.proxyPort, 'api.github.com');
    await refuse(backend.proxyPort, 'api.github.com');
    await refuse(backend.proxyPort, 'registry.npmjs.org');
    await expect.poll(refused).toEqual({
      count: 3,
      hosts: [
        { host: 'api.github.com', count: 2 },
        { host: 'registry.npmjs.org', count: 1 },
      ],
      epoch: expect.any(Number),
    });
  });

  it('don’t include connections to an IP address: the certificate is for another name, trusted or not', async () => {
    await refuse(backend.proxyPort, '203.0.113.9', '');
    await settle();
    expect(refused()).toBeUndefined();
  });

  it('keep counting after a batch has been sent', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    await settle();
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(2);
  });

  it('name the first 50 hosts, and say there were others', async () => {
    for (let i = 0; i < 51; i += 1) await refuse(backend.proxyPort, `h${i}.example.test`);
    await expect.poll(() => refused()?.count).toBe(51);
    expect(refused()!.hosts).toHaveLength(50);
    expect(refused()!.moreHosts).toBe(true);
  });

  it('count every alert that means the certificate was refused: Chrome’s, unknown CA, bad certificate', async () => {
    await refuse(backend.proxyPort, 'a.example.test', undefined, alertRecord(46)); // certificate_unknown
    await refuse(backend.proxyPort, 'b.example.test', undefined, alertRecord(48)); // unknown_ca
    await refuse(backend.proxyPort, 'c.example.test', undefined, alertRecord(42)); // bad_certificate
    await expect.poll(() => refused()?.count).toBe(3);
  });

  it('don’t include connections that trust it, drop out, send another alert, or go to Wirescry’s own check', async () => {
    const pem = await readFile(backend.caCertPath, 'utf8');
    // A client that trusts it, to a real host's name (the server isn't there: Wirescry answers 502).
    expect(
      (await requestViaProxy(backend.proxyPort, `https://localhost:${NOTHING_LISTENS}/`, pem)).status,
    ).toBe(502);
    await drop(backend.proxyPort, 'api.github.com');
    await refuse(backend.proxyPort, 'api.github.com', undefined, alertRecord(40)); // handshake_failure
    await refuse(backend.proxyPort, 'wirescry.internal');
    await settle();
    expect(refused()).toBeUndefined();
    // And the next real refusal still counts, alone.
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(refused).toMatchObject({ count: 1, hosts: [{ host: 'api.github.com', count: 1 }] });
  });

  it('don’t include a device’s, which are shown with the device', async () => {
    const { port } = await backend.listeners.open(PIXEL);
    await refuse(port, 'api.github.com');
    await settle();
    expect(refused()).toBeUndefined();
  });

  it('are sent together when many come at once', async () => {
    const before = statuses().length;
    await Promise.all(Array.from({ length: 8 }, () => refuse(backend.proxyPort, 'api.github.com')));
    await expect.poll(() => refused()?.count).toBe(8);
    await settle();
    // One update for the burst (two if it straddled the moment it was sent), not eight.
    expect(statuses().length - before).toBeLessThanOrEqual(2);
  });

  it('aren’t counted while recording is paused', async () => {
    await api.send({ command: 'setPaused', paused: true });
    await refuse(backend.proxyPort, 'api.github.com');
    await settle();
    expect(refused()).toBeUndefined();
    await api.send({ command: 'setPaused', paused: false });
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
  });

  it('start over when the list is cleared, but not when only some requests are', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    await api.send({ command: 'clear', ids: ['not-an-exchange'] });
    await settle();
    expect(refused()?.count).toBe(1);
    const before = refused()!.epoch!;
    await api.send({ command: 'clear' });
    await expect.poll(refused).toBeUndefined();
    await refuse(backend.proxyPort, 'registry.npmjs.org');
    await expect.poll(refused).toMatchObject({ count: 1, hosts: [{ host: 'registry.npmjs.org', count: 1 }] });
    // Started over: a new epoch, so the window shows them even if it had dismissed the old ones.
    expect(refused()!.epoch).toBeGreaterThan(before);
  });

  it('start over when the window says its Clear went through (clearRefused)', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    await api.send({ command: 'clearRefused' });
    await expect.poll(refused).toBeUndefined();
    await refuse(backend.proxyPort, 'pypi.org');
    await expect.poll(refused).toMatchObject({ count: 1, hosts: [{ host: 'pypi.org', count: 1 }] });
  });

  it('keep the ones that came after what the window cleared, under a new epoch', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(2);
    const seen = refused()!;
    // While Undo was offered: one more from a host it showed, and one from a new host.
    await refuse(backend.proxyPort, 'api.github.com');
    await refuse(backend.proxyPort, 'pypi.org');
    await expect.poll(() => refused()?.count).toBe(4);
    await api.send({ command: 'clearRefused', seen });
    await expect.poll(refused).toMatchObject({
      count: 2,
      hosts: [
        { host: 'api.github.com', count: 1 },
        { host: 'pypi.org', count: 1 },
      ],
    });
    expect(refused()!.epoch).toBeGreaterThan(seen.epoch!);
  });

  it('ignore a Clear of refusals that have started over since', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    const seen = refused()!;
    await api.send({ command: 'clear' });
    await expect.poll(refused).toBeUndefined();
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    await api.send({ command: 'clearRefused', seen });
    await settle();
    expect(refused()?.count).toBe(1);
  });

  it('stay when the proxy moves to another port', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    await moveProxyToPickedPort(api);
    await settle();
    expect(refused()?.count).toBe(1);
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(2);
  });

  it('start over once Wirescry’s Firefox trusts the certificate: Firefox’s own refusals are settled', async () => {
    await refuse(backend.proxyPort, 'firefox.settings.services.mozilla.com');
    await expect.poll(() => refused()?.count).toBe(1);
    const pem = await readFile(backend.caCertPath, 'utf8');
    // A browser other than Firefox passing the check changes nothing.
    await requestViaProxy(backend.proxyPort, 'https://wirescry.internal:443/check', pem, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150.0 Safari/537.36' },
    });
    await settle();
    expect(refused()?.count).toBe(1);
    await requestViaProxy(backend.proxyPort, 'https://wirescry.internal:443/check', pem, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/150.0' },
    });
    await expect.poll(() => statuses().at(-1)?.firefoxTrusted).toBe(true);
    expect(refused()).toBeUndefined();
  });

  it('send nothing new when cleared without any', async () => {
    const before = statuses().length;
    await api.send({ command: 'clearRefused' });
    await settle();
    expect(statuses().length).toBe(before);
  });

  it('send nothing new when the list is cleared without any', async () => {
    const before = statuses().length;
    await api.send({ command: 'clear' });
    await settle();
    expect(statuses().length).toBe(before);
  });

  it('start over when the certificate is reset: they refused the old one', async () => {
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
    await api.send({ command: 'resetCertificate' });
    await expect.poll(refused).toBeUndefined();
    // And the new certificate's refusals count afresh.
    await refuse(backend.proxyPort, 'api.github.com');
    await expect.poll(() => refused()?.count).toBe(1);
  });
});
