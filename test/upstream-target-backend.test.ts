/**
 * A plugin asking where a recorded call's server is (BackendPluginHost.upstreamTarget), through the
 * real backend: it can reach the server with what it's given, and is refused for a call a rule
 * handled, a call that's gone, and before it has started.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import * as mockttp from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ExchangeSummary } from '../src/shared/api';
import {
  apiClient,
  exchangesIn,
  localhostCertificate,
  TOKEN,
  tunnelThroughProxy,
  UI_ORIGIN,
} from './helpers';

const WAIT = { timeout: 10_000 };

describe('where a call’s server is, for a plugin', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let server: http2.Http2SecureServer;
  let port: number;
  let ca: string;
  let upstreamCA: string;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let host: BackendPluginHost | undefined;
  let started = false;
  const early: unknown[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-target-'));
    const authority = await mockttp.generateCACertificate();
    upstreamCA = authority.cert;
    const leaf = await localhostCertificate(authority);
    server = http2.createSecureServer({ key: leaf.key, cert: leaf.cert });
    server.on('stream', (stream, headers) => {
      stream.respond({ ':status': 200, 'content-type': 'text/plain' });
      stream.end(`hello ${headers[':path']}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
    const asker: BackendPlugin = {
      name: 'asker',
      apiVersion: PLUGIN_API_VERSION,
      start: (h) => {
        // Before it has started, it's told nothing.
        early.push(h.upstreamTarget?.('anything'));
        host = h;
        started = true;
      },
      stop: () => undefined,
      handle: async () => undefined,
    };
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA],
      plugins: [asker],
      pluginsEnabled: true,
    });
    ca = await readFile(backend.caCertPath, 'utf8');
    api = await apiClient(backend.apiPort);
    // Until its start has finished: before then, it's told nothing.
    for (let i = 0; !started && i < 200; i++) await new Promise((r) => setTimeout(r, 50));
    await host!.setProxyRules([
      {
        id: 'mock',
        label: 'Mock orders',
        matchers: [new mockttp.matchers.FlexiblePathMatcher('/mocked')],
        steps: [new mockttp.requestSteps.FixedResponseStep(200, undefined, 'mocked')],
      },
    ]);
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** An HTTP/2 GET through Wirescry; resolves with the recorded summary once it has finished. */
  const callThrough = async (urlPath: string, tunnelTo = `localhost:${port}`): Promise<ExchangeSummary> => {
    const socket = await tunnelThroughProxy(backend.proxyPort, tunnelTo);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${port}`, { createConnection: () => secure });
    await new Promise<void>((resolve, reject) => {
      const req = session.request({ ':path': urlPath });
      req.resume();
      req.on('error', reject);
      req.on('close', resolve);
    });
    session.close();
    let found: ExchangeSummary | undefined;
    await expect
      .poll(() => {
        found = exchangesIn(api.messages).find((e) => e.path === urlPath && e.durationMs !== undefined);
        return found;
      }, WAIT)
      .toBeDefined();
    return found!;
  };

  it('gives a target the plugin can reach the server with, by TLS', async () => {
    const recorded = await callThrough('/shop.v1.Orders/Get');
    const result = host!.upstreamTarget!(recorded.id)!;
    expect(result).toEqual({
      target: {
        host: 'localhost',
        port,
        tls: true,
        servername: 'localhost',
        authority: `localhost:${port}`,
        ca: [upstreamCA],
      },
    });
    // Its own request, straight to the server, as reflection would send.
    const { target } = result as {
      target: NonNullable<Extract<typeof result, { target: unknown }>['target']>;
    };
    const secure = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.servername,
      ca: [...tls.rootCertificates, ...target.ca],
      ALPNProtocols: ['h2'],
    });
    await new Promise<void>((resolve, reject) => secure.once('secureConnect', resolve).once('error', reject));
    expect(secure.alpnProtocol).toBe('h2');
    const session = http2.connect(`https://${target.authority}`, { createConnection: () => secure });
    const text = await new Promise<string>((resolve, reject) => {
      const req = session.request({ ':path': '/own-request', ':authority': target.authority });
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d: string) => (body += d));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    session.close();
    expect(text).toBe('hello /own-request');
  });

  it('refuses a call a rule handled, and gives nothing for a call that’s gone or before starting', async () => {
    const mocked = await callThrough('/mocked');
    expect(host!.upstreamTarget!(mocked.id)).toEqual({
      refused: 'The rule "Mock orders" handled it, so it may not have gone to the server shown.',
    });
    expect(host!.upstreamTarget!('no-such-exchange')).toBeNull();
    expect(early).toEqual([null]);
  });

  it('connects where the tunnel went, with the name the call used for TLS', async () => {
    // Tunneled to the address, the server named as localhost.
    const recorded = await callThrough('/by-address', `127.0.0.1:${port}`);
    expect(host!.upstreamTarget!(recorded.id)).toMatchObject({
      target: { host: '127.0.0.1', port, servername: 'localhost', authority: `localhost:${port}` },
    });
  });

  it('allows plain HTTP to this computer', async () => {
    const plain = http.createServer((_req, res) => res.end('plain'));
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const plainPort = (plain.address() as net.AddressInfo).port;
    try {
      await new Promise<void>((resolve, reject) => {
        http
          .get(
            {
              host: '127.0.0.1',
              port: backend.proxyPort,
              path: `http://127.0.0.1:${plainPort}/plain`,
              headers: { host: `127.0.0.1:${plainPort}` },
            },
            (res) => {
              res.resume();
              res.on('end', resolve);
            },
          )
          .on('error', reject);
      });
      let recorded: ExchangeSummary | undefined;
      await expect
        .poll(() => {
          recorded = exchangesIn(api.messages).find((e) => e.path === '/plain' && e.durationMs !== undefined);
          return recorded;
        }, WAIT)
        .toBeDefined();
      expect(host!.upstreamTarget!(recorded!.id)).toEqual({
        target: {
          host: '127.0.0.1',
          port: plainPort,
          tls: false,
          authority: `127.0.0.1:${plainPort}`,
          ca: [upstreamCA],
        },
      });
    } finally {
      plain.close();
    }
  });

  it('refuses a call while its request is still being sent, as a rule may yet handle it', async () => {
    const socket = await tunnelThroughProxy(backend.proxyPort, `localhost:${port}`);
    const secure = tls.connect({ socket, servername: 'localhost', ca, ALPNProtocols: ['h2'] });
    const session = http2.connect(`https://localhost:${port}`, { createConnection: () => secure });
    const req = session.request({ ':method': 'POST', ':path': '/streaming-up' });
    req.on('error', () => undefined);
    req.resume();
    req.write('part of the request');
    let recorded: ExchangeSummary | undefined;
    await expect
      .poll(() => (recorded = exchangesIn(api.messages).find((e) => e.path === '/streaming-up')), WAIT)
      .toBeDefined();
    expect(host!.upstreamTarget!(recorded!.id)).toEqual({
      refused: 'Its request is still being sent. Ask once it has been, or from another call.',
    });
    req.end();
    await expect.poll(() => 'target' in (host!.upstreamTarget!(recorded!.id) ?? {}), WAIT).toBe(true);
    session.close();
  });

  it('hands each plugin its own copy', async () => {
    const recorded = await callThrough('/copy');
    const first = host!.upstreamTarget!(recorded.id) as { target: { ca: string[] } };
    first.target.ca.push('changed');
    const second = host!.upstreamTarget!(recorded.id) as { target: { ca: string[] } };
    expect(second.target.ca).toEqual([upstreamCA]);
  });
});
