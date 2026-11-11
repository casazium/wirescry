/**
 * Where a recorded call's server is, for a plugin's own request (src/backend/upstream-target.ts):
 * where to connect for the calls it may ask about, and a refusal, in words, for those it mustn't.
 */
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, upstreamTargetOf } from '../src/backend/upstream-target';
import type { ExchangeDetail, ExchangeSummary } from '../src/shared/api';

/** A finished call from this computer, sent where its URL says unless `extra` says otherwise. */
const call = (
  url: string,
  summary: Partial<ExchangeSummary> = {},
  headers: Array<[string, string]> = [],
  extra: Partial<ExchangeDetail> = {},
): ExchangeDetail => ({
  summary: {
    id: 'c',
    method: 'POST',
    protocol: new URL(url).protocol.slice(0, -1),
    httpVersion: '2.0',
    host: new URL(url).host,
    path: new URL(url).pathname,
    url,
    startedAt: 0,
    ...summary,
  },
  requestHeaders: headers,
  timing: { startTimestamp: 0, bodyReceivedTimestamp: 1 },
  destination: {
    hostname: new URL(url).hostname,
    port: Number(new URL(url).port) || (url.startsWith('https:') ? 443 : 80),
  },
  fromThisComputer: true,
  ...extra,
});
const target = (detail: ExchangeDetail, cas: string[] = [], ownPorts: number[] = []) => {
  const result = upstreamTargetOf(detail, cas, ownPorts);
  if (!('target' in result)) throw new Error(`refused: ${result.refused}`);
  return result.target;
};
const refusal = (detail: ExchangeDetail, ownPorts: number[] = []) => {
  const result = upstreamTargetOf(detail, [], ownPorts);
  if (!('refused' in result)) throw new Error('not refused');
  return result.refused;
};

describe('where a call’s server is', () => {
  it('gives the host, port, server name and authority of an HTTPS call', () => {
    expect(
      target(call('https://api.example.com/shop.v1.Orders/Get', {}, [[':authority', 'api.example.com']])),
    ).toEqual({
      host: 'api.example.com',
      port: 443,
      tls: true,
      servername: 'api.example.com',
      authority: 'api.example.com',
      ca: [],
    });
    expect(
      target(call('https://api.example.com:8443/x', {}, [['Host', 'api.example.com:8443']])),
    ).toMatchObject({
      port: 8443,
      authority: 'api.example.com:8443',
    });
    // A call sent to an address under another name keeps the name it was sent with.
    expect(target(call('https://203.0.113.9/x', {}, [['host', 'api.example.com']])).authority).toBe(
      'api.example.com',
    );
    // HTTP/2's :authority, likewise.
    expect(target(call('https://203.0.113.9/x', {}, [[':authority', 'grpc.example.com']])).authority).toBe(
      'grpc.example.com',
    );
    // No Host or :authority header: the URL's.
    expect(target(call('https://api.example.com:9000/x')).authority).toBe('api.example.com:9000');
  });

  it('gives no server name for an IP address, and an IPv6 address without brackets', () => {
    expect(target(call('https://203.0.113.9/x'))).toMatchObject({ host: '203.0.113.9', tls: true });
    expect(target(call('https://203.0.113.9/x')).servername).toBeUndefined();
    const v6 = target(call('https://[2001:db8::1]:8443/x'));
    expect(v6).toMatchObject({ host: '2001:db8::1', port: 8443 });
    expect(v6.servername).toBeUndefined();
  });

  it('connects where the proxy sent the call, not where its Host header says', () => {
    // An app tunnels to an address and names the server something else.
    const tunneled = call('https://localhost/x', {}, [['host', 'localhost']], {
      destination: { hostname: '203.0.113.7', port: 8443 },
    });
    expect(target(tunneled)).toMatchObject({ host: '203.0.113.7', port: 8443, servername: 'localhost' });
    // Over plain HTTP, the same trick doesn't make it this computer.
    const plain = call('http://localhost/x', {}, [['host', 'localhost']], {
      destination: { hostname: '10.0.0.5', port: 80 },
    });
    expect(refusal(plain)).toMatch(/plain HTTP/);
  });

  it('reaches any name for this computer as localhost, never looking it up', () => {
    expect(target(call('http://api.localhost:8080/x'))).toMatchObject({ host: 'localhost', port: 8080 });
    expect(target(call('https://api.localhost/x'))).toMatchObject({
      host: 'localhost',
      servername: 'api.localhost',
    });
    expect(target(call('http://LOCALHOST./x')).host).toBe('localhost');
    // Numeric forms are read as the URL standard reads them.
    expect(target(call('http://2130706433:9000/x'))).toMatchObject({ host: '127.0.0.1', port: 9000 });
  });

  it('allows plain HTTP to this computer only', () => {
    for (const url of [
      'http://localhost:50051/x',
      'http://127.0.0.1:50051/x',
      'http://[::1]:50051/x',
      'http://api.localhost/x',
    ]) {
      expect(target(call(url)), url).toMatchObject({ tls: false });
    }
    expect(target(call('http://localhost/x')).port).toBe(80);
  });

  it('sends Docker’s name for this computer here, keeping the name for TLS and the authority', () => {
    expect(
      target(call('https://host.docker.internal:7443/x', {}, [[':authority', 'host.docker.internal:7443']])),
    ).toMatchObject({
      host: 'localhost',
      // As the proxy itself checked TLS: under the name it connected with.
      servername: 'localhost',
      authority: 'host.docker.internal:7443',
    });
    // Plain HTTP to it is plain HTTP to this computer.
    expect(target(call('http://host.docker.internal:8080/x'))).toMatchObject({
      host: 'localhost',
      tls: false,
    });
  });

  it('passes on the certificates the proxy trusts, as a copy', () => {
    const cas = ['-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----'];
    const result = target(call('https://api.example.com/x'), cas);
    expect(result.ca).toEqual(cas);
    expect(result.ca).not.toBe(cas);
  });
});

describe('calls whose server a plugin mustn’t contact', () => {
  it('refuses a call loaded from a HAR file', () => {
    expect(refusal(call('https://api.example.com/x', { imported: true }))).toMatch(/HAR file/);
  });

  it('refuses a call a rule handled, naming the rule', () => {
    const handled = call('https://api.example.com/x', {
      handledBy: { plugin: 'pro', ruleId: 'r1', label: 'Forward to staging' },
    });
    expect(refusal(handled)).toBe(
      'The rule "Forward to staging" handled it, so it may not have gone to the server shown.',
    );
  });

  it('refuses a call sent from Compose, from a device, or a WebSocket', () => {
    expect(refusal(call('https://api.example.com/x', { composed: true }))).toMatch(/Compose/);
    expect(
      refusal(call('https://api.example.com/x', { source: { kind: 'android', id: 's1', label: 'Pixel 8' } })),
    ).toBe("It came from Pixel 8. Asking servers from devices isn't supported yet.");
    expect(refusal(call('https://api.example.com/socket', { websocket: true }))).toMatch(/WebSocket/);
  });

  it('refuses plain HTTP to any other computer, local network or not', () => {
    for (const url of [
      'http://api.example.com/x',
      'http://10.0.0.5:50051/x',
      'http://192.168.1.20/x',
      'http://127.example.com/x',
      'http://localhost.example.com/x',
      'http://[::ffff:10.0.0.1]/x',
    ]) {
      expect(refusal(call(url)), url).toMatch(/plain HTTP/);
    }
  });

  it('refuses a call whose client wasn’t on this computer, as a container’s localhost is its own', () => {
    expect(refusal(call('http://localhost:8080/x', {}, [], { fromThisComputer: undefined }))).toMatch(
      /another machine or a container/,
    );
    expect(refusal(call('https://api.example.com/x', {}, [], { destination: undefined }))).toMatch(
      /another machine or a container/,
    );
  });

  it('refuses a call whose request is still being sent: a rule may yet handle it', () => {
    expect(refusal(call('https://api.example.com/x', {}, [], { timing: { startTimestamp: 0 } }))).toMatch(
      /still being sent/,
    );
  });

  it('refuses a call that didn’t reach a server', () => {
    for (const kind of ['blocked', 'rule'] as const) {
      expect(refusal(call('https://api.example.com/x', { failure: { kind, code: 'X', message: 'x' } }))).toBe(
        "It didn't reach a server.",
      );
    }
  });

  it('refuses Wirescry itself: its setup page and its own ports', () => {
    expect(refusal(call('http://wirescry.internal/setup'))).toMatch(/setup page/);
    expect(refusal(call('https://wirescry.internal/setup'))).toMatch(/setup page/);
    expect(refusal(call('http://localhost:8000/x'), [8000, 51000])).toBe('It went to Wirescry itself.');
    expect(refusal(call('https://127.0.0.1:51000/x'), [8000, 51000])).toBe('It went to Wirescry itself.');
    // The same port on another computer is someone else's.
    expect(target(call('https://api.example.com:8000/x'), [], [8000]).port).toBe(8000);
  });

  it('refuses a port it can’t use', () => {
    expect(
      refusal(
        call('https://api.example.com/x', {}, [], { destination: { hostname: 'api.example.com', port: 0 } }),
      ),
    ).toMatch(/port can't be used/);
  });

  it('takes an IPv4-mapped address as another computer over plain HTTP (it can’t tell, so it refuses)', () => {
    expect(refusal(call('http://[::ffff:127.0.0.1]/x'))).toMatch(/plain HTTP/);
  });

  it('refuses an address it can’t read, or one that isn’t http or https', () => {
    const bad = call('https://api.example.com/x');
    bad.summary.url = 'not a url';
    expect(refusal(bad)).toMatch(/can't be read/);
    expect(refusal(call('ftp://files.example.com/x'))).toMatch(/isn't http or https/);
  });
});

describe('this computer', () => {
  it('is localhost, its subdomains, 127.0.0.0/8 and ::1', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'a.b.localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('is not a name that only starts or ends like it, nor another address', () => {
    for (const host of [
      'localhost.example.com',
      'notlocalhost',
      '127.example.com',
      '10.0.0.1',
      '::2',
      '0.0.0.0',
      '10.127.0.1',
      '192.168.127.1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});
