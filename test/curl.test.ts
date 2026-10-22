import { describe, expect, it } from 'vitest';
import { shellQuote, toCurl } from '../src/shared/curl';

describe('toCurl', () => {
  it('builds a GET without -X and skips headers curl sets itself', () => {
    expect(
      toCurl({
        method: 'GET',
        url: 'https://example.com/a?b=1&c=2',
        headers: [
          [':authority', 'example.com'],
          ['Host', 'example.com'],
          ['Accept', '*/*'],
        ],
      }),
    ).toBe(`curl \\\n  'https://example.com/a?b=1&c=2' \\\n  -H 'Accept: */*'`);
  });

  it('includes a text body and quotes single quotes safely', () => {
    const command = toCurl({
      method: 'PUT',
      url: 'https://example.com/',
      headers: [['Content-Length', '9']],
      body: new TextEncoder().encode(`it's "ok"`),
    });
    expect(command).toBe(`curl \\\n  -X PUT \\\n  https://example.com/ \\\n  --data-raw 'it'\\''s "ok"'`);
  });

  it('points to a file for binary bodies', () => {
    const command = toCurl({
      method: 'POST',
      url: 'https://x.test/',
      headers: [],
      body: new Uint8Array([0, 1, 2]),
    });
    expect(command).toContain('--data-binary @body.bin');
    expect(command).not.toContain('-X');
  });

  it('leaves simple words unquoted', () => {
    expect(shellQuote('abc-1.2')).toBe('abc-1.2');
    expect(shellQuote('a b')).toBe(`'a b'`);
  });
});
