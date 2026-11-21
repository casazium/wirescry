/**
 * The window's side of View › Hide Secrets (src/renderer/src/secrets.ts and hexDump's masking):
 * the switch remembered, and summaries, URLs and headers masked.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { hexDump } from '../src/renderer/src/bytes';
import {
  HIDE_SECRETS_KEY,
  maskHeaders,
  maskSummary,
  maskText,
  maskUrl,
  readHideSecrets,
  writeHideSecrets,
} from '../src/renderer/src/secrets';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const PASSWORD = 'hunter2' + 'Correct9Horse';

const memory = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as Storage;
};

describe('the switch, remembered', () => {
  it('is off by default, and remembers on and off', () => {
    const storage = memory();
    expect(readHideSecrets(storage)).toBe(false);
    writeHideSecrets(true, storage);
    expect(storage.getItem(HIDE_SECRETS_KEY)).toBe('1');
    expect(readHideSecrets(storage)).toBe(true);
    writeHideSecrets(false, storage);
    expect(storage.getItem(HIDE_SECRETS_KEY)).toBeNull();
    expect(readHideSecrets(storage)).toBe(false);
  });

  it('reads anything but "1" as off', () => {
    const storage = memory();
    storage.setItem(HIDE_SECRETS_KEY, 'true');
    expect(readHideSecrets(storage)).toBe(false);
  });

  it('is on when storage can’t be read, and a write that fails is ignored', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readHideSecrets(broken)).toBe(true);
    expect(() => writeHideSecrets(true, broken)).not.toThrow();
    expect(readHideSecrets(undefined)).toBe(false);
  });
});

describe('masking what the window shows', () => {
  it('masks URLs and paths, and leaves ordinary ones alone', () => {
    expect(maskUrl(`https://a.test/x?access_token=${ACCESS}&page=2`)).toBe(
      'https://a.test/x?access_token=[redacted]&page=2',
    );
    expect(maskUrl(`/x?api_key=${ACCESS}`)).toBe('/x?api_key=[redacted]');
    expect(maskUrl('https://a.test/x?page=2&sort=name')).toBe('https://a.test/x?page=2&sort=name');
  });

  it('masks headers by name and shape, keeping the scheme and cookie names', () => {
    expect(
      maskHeaders([
        ['Authorization', `Bearer ${BEARER}`],
        ['Cookie', `sid=${BEARER}; theme=dark`],
        ['Host', 'a.test'],
        ['Idempotency-Key', 'k-123'],
      ]),
    ).toEqual([
      ['Authorization', 'Bearer [redacted]'],
      // Every cookie's value, as in export; names kept.
      ['Cookie', 'sid=[redacted]; theme=[redacted]'],
      ['Host', 'a.test'],
      ['Idempotency-Key', 'k-123'],
    ]);
  });

  it('masks a message’s secrets and leaves plain words', () => {
    expect(maskText(`password=${PASSWORD} failed`)).toBe('password=[redacted] failed');
    expect(maskText('Not Found')).toBe('Not Found');
  });

  it('masks a summary’s URL, path, messages and labels, and drops badge titles', () => {
    const s: ExchangeSummary = {
      id: 'a',
      method: 'GET',
      protocol: 'https',
      httpVersion: '2.0',
      host: 'a.test',
      path: `/x?access_token=${ACCESS}`,
      url: `https://a.test/x?access_token=${ACCESS}`,
      startedAt: 0,
      status: 500,
      statusMessage: `token=${BEARER}`,
      contentType: 'application/json',
      failure: {
        kind: 'connection',
        code: 'ECONNRESET',
        message: `password=${PASSWORD}`,
        detail: `https://b.test/?api_key=${ACCESS}`,
      } as ExchangeSummary['failure'],
      grpcMessage: `token=${BEARER}`,
      closeReason: `password=${PASSWORD}`,
      handledBy: { id: 'r', label: `token=${BEARER}` } as ExchangeSummary['handledBy'],
      annotations: [{ plugin: 'pro', label: 'Spec', tone: 'warn', title: BEARER }],
    };
    const masked = maskSummary(s);
    const text = JSON.stringify(masked);
    for (const secret of [ACCESS, BEARER, PASSWORD]) expect(text).not.toContain(secret);
    expect(masked.annotations).toEqual([{ plugin: 'pro', label: 'Spec', tone: 'warn' }]);
    expect(masked).toMatchObject({ id: 'a', host: 'a.test', status: 500, contentType: 'application/json' });
    // The same object each time, and the summary itself isn't changed.
    expect(maskSummary(s)).toBe(masked);
    expect(s.url).toContain(ACCESS);
  });

  it('leaves a summary with nothing secret as it was', () => {
    const s = {
      id: 'b',
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'a.test',
      path: '/users?page=2',
      url: 'https://a.test/users?page=2',
      startedAt: 0,
      statusMessage: 'OK',
    } as ExchangeSummary;
    expect(maskSummary(s)).toEqual(s);
  });
});

describe('hexDump with masked bytes', () => {
  const bytes = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz');

  it('shows masked bytes as dots in both columns, across rows', () => {
    const dump = hexDump(bytes, undefined, [
      [0, 2],
      [14, 18],
    ]).split('\n');
    expect(dump[0]).toBe('00000000  •• •• 63 64 65 66 67 68 69 6a 6b 6c 6d 6e •• ••  ••cdefghijklmn••');
    expect(dump[1]).toBe('00000010  •• •• 73 74 75 76 77 78 79 7a                    ••stuvwxyz');
  });

  it('is the same as before with no ranges', () => {
    expect(hexDump(bytes, undefined, [])).toBe(hexDump(bytes));
    expect(hexDump(bytes)).toContain('61 62 63');
  });
});
