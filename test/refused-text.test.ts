/** What the Traffic bar says about connections that refused the certificate (refused-text.ts). */
import { describe, expect, it } from 'vitest';
import {
  alreadyDismissed,
  NAMED_REFUSED_HOSTS,
  REFUSED_HELP_URL,
  refusedSummary,
  refusedWhy,
} from '../src/renderer/src/refused-text';
import type { RefusedConnections } from '../src/shared/api';

describe('refusedSummary', () => {
  it('counts the connections and names their hosts, the most frequent first as given', () => {
    expect(
      refusedSummary({
        count: 3,
        hosts: [
          { host: 'api.github.com', count: 2 },
          { host: 'registry.npmjs.org', count: 1 },
        ],
      }),
    ).toBe('3 connections refused Wirescry’s certificate: api.github.com, registry.npmjs.org.');
  });

  it('says one connection, not one connections', () => {
    expect(refusedSummary({ count: 1, hosts: [{ host: 'api.github.com', count: 1 }] })).toBe(
      '1 connection refused Wirescry’s certificate: api.github.com.',
    );
  });

  it(`names ${NAMED_REFUSED_HOSTS} hosts, and counts the rest`, () => {
    const hosts = ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'].map((host) => ({ host, count: 1 }));
    expect(refusedSummary({ count: 5, hosts })).toBe(
      '5 connections refused Wirescry’s certificate: a.test, b.test, c.test, and 2 more.',
    );
    expect(refusedSummary({ count: 3, hosts: hosts.slice(0, 3) })).toBe(
      '3 connections refused Wirescry’s certificate: a.test, b.test, c.test.',
    );
  });

  it('calls a connection that named no host that, in the singular or plural', () => {
    expect(refusedSummary({ count: 1, hosts: [{ host: '', count: 1 }] })).toBe(
      '1 connection refused Wirescry’s certificate: a connection without a hostname.',
    );
    expect(refusedSummary({ count: 4, hosts: [{ host: '', count: 4 }] })).toBe(
      '4 connections refused Wirescry’s certificate: connections without a hostname.',
    );
  });

  it('names nothing when no host was kept, and groups thousands', () => {
    expect(refusedSummary({ count: 1200, hosts: [] })).toBe(
      `${(1200).toLocaleString()} connections refused Wirescry’s certificate.`,
    );
  });
});

describe('refusedWhy', () => {
  it('says why they aren’t listed, for one or many', () => {
    expect(refusedWhy(1)).toBe(
      'The program that made it doesn’t trust the certificate, so that connection isn’t listed.',
    );
    expect(refusedWhy(2)).toBe(
      'The programs that made them don’t trust the certificate, so those connections aren’t listed.',
    );
  });

  it('links to the troubleshooting section on certificate errors', () => {
    expect(REFUSED_HELP_URL).toBe(
      'https://docs.casazium.com/docs/wirescry/troubleshooting#certificate-error',
    );
  });
});

describe('refusedSummary past the hosts kept', () => {
  it('says “and others” when it doesn’t know how many more', () => {
    const hosts = ['a.test', 'b.test', 'c.test', 'd.test'].map((host) => ({ host, count: 1 }));
    expect(refusedSummary({ count: 90, hosts, moreHosts: true })).toBe(
      '90 connections refused Wirescry’s certificate: a.test, b.test, c.test, and others.',
    );
  });
});

describe('alreadyDismissed', () => {
  const at = (hosts: string[], epoch = 1, moreHosts = false): RefusedConnections => ({
    count: hosts.length,
    hosts: hosts.map((host) => ({ host, count: 1 })),
    epoch,
    ...(moreHosts ? { moreHosts: true as const } : {}),
  });

  it('is nothing when nothing was dismissed', () => {
    expect(alreadyDismissed(at(['a.test']), undefined)).toBe(false);
  });

  it('covers the same hosts, or fewer, however many times they refused', () => {
    expect(alreadyDismissed({ ...at(['a.test']), count: 500 }, at(['a.test', 'b.test']))).toBe(true);
    expect(alreadyDismissed(at(['b.test']), at(['a.test', 'b.test']))).toBe(true);
  });

  it('doesn’t cover a new host, refusals that started over, or hosts past those it named', () => {
    expect(alreadyDismissed(at(['a.test', 'c.test']), at(['a.test', 'b.test']))).toBe(false);
    expect(alreadyDismissed(at(['a.test'], 2), at(['a.test'], 1))).toBe(false);
    expect(alreadyDismissed(at(['a.test'], 1, true), at(['a.test']))).toBe(false);
    expect(alreadyDismissed(at(['a.test'], 1, true), at(['a.test'], 1, true))).toBe(true);
  });
});
