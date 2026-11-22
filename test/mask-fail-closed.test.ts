/**
 * When the redaction rules themselves throw: what's masked is hidden whole, never shown as it is.
 * In the window (src/renderer/src/secrets.ts), the mask worker's fields (src/backend/mask-body.ts),
 * and the MCP tools' own messages (src/backend/mcp/tools.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const broken = vi.hoisted(() => ({ url: false, headers: false, header: new Set<string>(), body: false }));

vi.mock('../src/shared/redact', async (original) => {
  const real = await original<typeof import('../src/shared/redact')>();
  return {
    ...real,
    redactUrl: (...args: Parameters<typeof real.redactUrl>) => {
      if (broken.url) throw new Error('broken rule');
      return real.redactUrl(...args);
    },
    redactHeaders: (...args: Parameters<typeof real.redactHeaders>) => {
      if (broken.headers) throw new Error('broken rule');
      return real.redactHeaders(...args);
    },
    redactHeader: (...args: Parameters<typeof real.redactHeader>) => {
      if (broken.header.has(args[0].toLowerCase())) throw new Error('broken rule');
      return real.redactHeader(...args);
    },
  };
});

vi.mock('../src/shared/redact-body', async (original) => {
  const real = await original<typeof import('../src/shared/redact-body')>();
  return {
    ...real,
    redactBody: (...args: Parameters<typeof real.redactBody>) => {
      if (broken.body) throw new Error('broken rule');
      return real.redactBody(...args);
    },
  };
});

const { maskHeaders, maskText, maskUrl } = await import('../src/renderer/src/secrets');
const { maskFields } = await import('../src/backend/mask-body');
const { KnownValues } = await import('../src/shared/redact-body');
const { sweep } = await import('../src/backend/mcp/tools');

const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';

afterEach(() => {
  broken.url = false;
  broken.headers = false;
  broken.header.clear();
  broken.body = false;
});

describe('the window', () => {
  it('masks as usual when the rules work', () => {
    expect(maskUrl(`https://a.test/?token=${SECRET}`)).toBe('https://a.test/?token=[redacted]');
    expect(maskText(`password=${SECRET}`)).not.toContain(SECRET);
    expect(maskHeaders([['authorization', `Bearer ${SECRET}`]])).toEqual([
      ['authorization', 'Bearer [redacted]'],
    ]);
  });

  it('hides a URL or a message whole when its rule throws', () => {
    broken.url = true;
    expect(maskUrl(`https://a.test/?token=${SECRET}`)).toBe('[redacted]');
    broken.body = true;
    expect(maskText(`failed: ${SECRET}`)).toBe('[redacted]');
  });

  it('masks headers one at a time when the list can’t be, hiding only the one that throws', () => {
    broken.headers = true;
    broken.header.add('x-odd');
    expect(
      maskHeaders([
        ['authorization', `Bearer ${SECRET}`],
        ['x-odd', SECRET],
        ['accept', 'text/html'],
      ]),
    ).toEqual([
      ['authorization', 'Bearer [redacted]'],
      ['x-odd', '[redacted]'],
      ['accept', 'text/html'],
    ]);
  });
});

describe('the mask worker’s fields', () => {
  it('hides a field whole when its rule throws, and masks the others', () => {
    broken.url = true;
    const out = maskFields(
      [
        { kind: 'url', value: `https://a.test/?token=${SECRET}` },
        { kind: 'header', name: 'authorization', value: `Bearer ${SECRET}` },
        { kind: 'host', value: 'a.test' },
      ],
      new KnownValues(),
    );
    expect(out).toEqual(['[redacted]', 'Bearer [redacted]', 'a.test']);
  });

  it('still learns from the fields that work: a value in a header is hidden in a field after', () => {
    broken.url = true;
    const out = maskFields(
      [
        { kind: 'url', value: `https://a.test/x` },
        { kind: 'header', name: 'authorization', value: `Bearer ${SECRET}` },
        { kind: 'host', value: `${SECRET}.a.test` },
      ],
      new KnownValues(),
    );
    expect(out).toEqual(['[redacted]', 'Bearer [redacted]', '[redacted].a.test']);
  });
});

describe('the MCP tools’ messages', () => {
  it('sweeps a message as usual, and gives a plain one when the rule throws', () => {
    expect(sweep(`password=${SECRET}`)).not.toContain(SECRET);
    broken.body = true;
    expect(sweep(`password=${SECRET}`)).toBe('Something went wrong.');
  });
});
