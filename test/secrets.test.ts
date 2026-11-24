/**
 * The window's side of View › Hide Secrets (src/renderer/src/secrets.ts and hexDump's masking):
 * the switch remembered, and summaries, URLs and headers masked.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { hexDump } from '../src/renderer/src/bytes';
import { KnownValues } from '../src/shared/redact-body';
import {
  CHECKING,
  HIDE_SECRETS_KEY,
  maskHeaders,
  maskMessage,
  maskSummary,
  maskSummaryWith,
  maskText,
  maskUrl,
  ownValues,
  readHideSecrets,
  STALE,
  staleSummary,
  writeHideSecrets,
  type Masking,
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
    expect(maskUrl(`https://a.test/x?access_token=${ACCESS}&page=2`, [])).toBe(
      'https://a.test/x?access_token=[redacted]&page=2',
    );
    expect(maskUrl(`/x?api_key=${ACCESS}`, [])).toBe('/x?api_key=[redacted]');
    expect(maskUrl('https://a.test/x?page=2&sort=name', [])).toBe('https://a.test/x?page=2&sort=name');
  });

  it('masks headers by name and shape, keeping the scheme and cookie names', () => {
    expect(
      maskHeaders(
        [
          ['Authorization', `Bearer ${BEARER}`],
          ['Cookie', `sid=${BEARER}; theme=dark`],
          ['Host', 'a.test'],
          ['Idempotency-Key', 'k-123'],
        ],
        [],
      ),
    ).toEqual([
      ['Authorization', 'Bearer [redacted]'],
      // Every cookie's value, as in export; names kept.
      ['Cookie', 'sid=[redacted]; theme=[redacted]'],
      ['Host', 'a.test'],
      ['Idempotency-Key', 'k-123'],
    ]);
  });

  it('masks a message’s secrets and leaves plain words', () => {
    expect(maskText(`password=${PASSWORD} failed`, [])).toBe('password=[redacted] failed');
    expect(maskText('Not Found', [])).toBe('Not Found');
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
        kind: 'refused',
        code: 'ECONNRESET',
        message: `password=${PASSWORD}`,
        detail: `https://b.test/?api_key=${ACCESS}`,
      } as ExchangeSummary['failure'],
      grpcMessage: `token=${BEARER}`,
      closeReason: `password=${PASSWORD}`,
      handledBy: { plugin: 'pro', ruleId: 'r', label: `token=${BEARER}` },
      annotations: [{ plugin: 'pro', label: 'Spec', tone: 'warn', title: BEARER }],
    };
    const masked = maskSummary(s, covered());
    const text = JSON.stringify(masked);
    for (const secret of [ACCESS, BEARER, PASSWORD]) expect(text).not.toContain(secret);
    expect(masked.annotations).toEqual([{ plugin: 'pro', label: 'Spec', tone: 'warn' }]);
    expect(masked).toMatchObject({ id: 'a', host: 'a.test', status: 500, contentType: 'application/json' });
    // The same object each time, and the summary itself isn't changed.
    const masking = covered();
    expect(maskSummary(s, masking)).toBe(maskSummary(s, masking));
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
    expect(maskSummary(s, covered())).toEqual(s);
  });
});

/** Known values as the window has them, covered. */
function covered(values: string[] = [], version = 1): Masking {
  const known = new KnownValues();
  for (const v of values) known.add(v);
  return { known, version, covered: true, full: false };
}

describe('masking with the session’s known values', () => {
  // A token learned from Authorization elsewhere: no rule would find it by name here.
  const TOKEN = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
  const set = (): KnownValues[] => [covered([TOKEN]).known];

  it('hides a repeat standing alone, joined to other text, percent-encoded or +-spaced in a URL', () => {
    expect(maskUrl(`https://a.test/x/${TOKEN}/y`, set())).toBe('https://a.test/x/[redacted]/y');
    expect(maskUrl(`https://a.test/x?id=sess-${TOKEN}`, set())).toBe('https://a.test/x?id=sess-[redacted]');
    const spaced = 'Ab3 ' + 'Cd4Ef5Gh6Ij7Kl8';
    const withSpace = [covered([spaced]).known];
    expect(maskUrl(`/x?q=${spaced.replace(' ', '+')}`, withSpace)).toBe('/x?q=[redacted]');
    expect(maskUrl(`/x?q=${encodeURIComponent(spaced)}`, withSpace)).toBe('/x?q=[redacted]');
    expect(
      maskUrl(`/x/${TOKEN.slice(0, 4)}%${TOKEN.charCodeAt(4).toString(16)}${TOKEN.slice(5)}`, set()),
    ).toBe('/x/[redacted]');
  });

  it('hides a repeat in a header value, a header name, a trailer and a redirect', () => {
    expect(
      maskHeaders(
        [
          ['x-echo', `you sent ${TOKEN}`],
          [`x-${TOKEN}`, 'v'],
          ['location', `https://b.test/cb?state=${TOKEN}`],
        ],
        set(),
      ),
    ).toEqual([
      ['x-echo', 'you sent [redacted]'],
      ['x-[redacted]', 'v'],
      ['location', 'https://b.test/cb?state=[redacted]'],
    ]);
    expect(maskUrl(`https://b.test/next#${TOKEN}`, set())).toBe('https://b.test/next#[redacted]');
  });

  it('keeps a different value, and ordinary text, readable', () => {
    const other = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb4';
    expect(maskUrl(`https://a.test/x/${other}`, set())).toBe(`https://a.test/x/${other}`);
    expect(
      maskHeaders(
        [
          ['accept', 'text/html'],
          ['x-id', other],
        ],
        set(),
      ),
    ).toEqual([
      ['accept', 'text/html'],
      ['x-id', other],
    ]);
    expect(maskText(`not found: ${other}`, set())).toBe(`not found: ${other}`);
  });

  it('scans a message for a repeat standing alone (not joined, as in other text)', () => {
    expect(maskText(`upstream said ${TOKEN}`, set())).toBe('upstream said [redacted]');
    expect(maskText(`upstream said x${TOKEN}`, set())).toBe(`upstream said x${TOKEN}`);
  });

  it('never learns: a value found by a rule while masking isn’t hidden elsewhere afterwards', () => {
    const known = new KnownValues();
    const masking: Masking = { known, version: 1, covered: true, full: false };
    expect(maskHeaders([['authorization', `Bearer ${TOKEN}`]], [known])).toEqual([
      ['authorization', 'Bearer [redacted]'],
    ]);
    expect(maskUrl(`https://a.test/${TOKEN}`, [known])).toBe(`https://a.test/${TOKEN}`);
    const s = {
      id: 'n',
      method: 'GET',
      host: 'a.test',
      path: `/?token=${TOKEN}`,
      url: `https://a.test/?token=${TOKEN}`,
    };
    maskSummary(s as ExchangeSummary, masking);
    expect(known.size).toBe(0);
  });

  it('masks a summary with the set, and again when the version rises', () => {
    const s = {
      id: 'k',
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'a.test',
      path: `/x/${TOKEN}`,
      url: `https://a.test/x/${TOKEN}`,
      startedAt: 0,
      statusMessage: `ok ${TOKEN}`,
      annotations: [{ plugin: 'pro', label: `L ${TOKEN}`, tone: 'warn' }],
    } as ExchangeSummary;
    const before = covered([]);
    expect(maskSummary(s, before).path).toBe(`/x/${TOKEN}`);
    // The same set object, a value added and a new Masking: masked afresh.
    before.known.add(TOKEN);
    expect(maskSummary(s, before).path).toBe(`/x/${TOKEN}`);
    const after: Masking = { ...before, version: 2 };
    const masked = maskSummary(s, after);
    expect(masked).toMatchObject({
      path: '/x/[redacted]',
      url: 'https://a.test/x/[redacted]',
      statusMessage: 'ok [redacted]',
      host: 'a.test',
      method: 'GET',
    });
    expect(masked.annotations?.[0]?.label).toBe('L [redacted]');
  });

  it('shows "Checking…" for every masked field until covered', () => {
    const s = {
      id: 'c',
      method: 'POST',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'a.test',
      path: '/plain',
      url: 'https://a.test/plain',
      startedAt: 0,
      status: 502,
      statusMessage: 'Bad Gateway',
      contentType: 'text/plain',
      grpcMessage: 'm',
      closeReason: 'r',
      failure: { kind: 'refused', code: 'E', message: 'm', detail: 'd' },
      handledBy: { plugin: 'pro', ruleId: 'r', label: 'rule' },
      annotations: [{ plugin: 'pro', label: 'Spec', tone: 'warn', title: 't' }],
    } as ExchangeSummary;
    const masked = maskSummary(s, { ...covered(), covered: false });
    expect(masked).toMatchObject({
      url: CHECKING,
      path: CHECKING,
      host: CHECKING,
      method: CHECKING,
      statusMessage: CHECKING,
      contentType: CHECKING,
      grpcMessage: CHECKING,
      closeReason: CHECKING,
      failure: { kind: 'refused', code: CHECKING, message: CHECKING, detail: CHECKING },
      handledBy: { label: CHECKING },
      annotations: [{ label: CHECKING }],
      // Numbers aren't secret.
      status: 502,
    });
    expect(maskMessage('plain', { ...covered(), covered: false })).toBe(CHECKING);
    expect(maskMessage('plain', covered())).toBe('plain');
    // A row from before a restart: the same fields, as can't be checked.
    expect(staleSummary(s)).toMatchObject({ url: STALE, path: STALE, statusMessage: STALE, host: STALE });
  });

  it('hides a detail’s own token with its own values first, though the session set is full', () => {
    const full = new KnownValues();
    for (let i = 0; i < 10_001; i++) full.add(`Filler${i}Zx8Wv6Ut4Sr2Qp`);
    expect(full.full).toBe(true);
    const masking: Masking = { known: full, version: 1, covered: true, full: true };
    const s = {
      id: 'd',
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'a.test',
      path: `/me/${TOKEN}`,
      url: `https://a.test/me/${TOKEN}`,
      startedAt: 0,
    } as ExchangeSummary;
    // The list's row: its own token shows (a known limit while full).
    expect(maskSummary(s, masking).url).toBe(`https://a.test/me/${TOKEN}`);
    const own = ownValues({
      summary: s,
      requestHeaders: [['authorization', `Bearer ${TOKEN}`]],
      timing: {},
    } as unknown as Parameters<typeof ownValues>[0]);
    expect(maskSummaryWith(s, masking, own).url).toBe('https://a.test/me/[redacted]');
    expect(maskHeaders([['x-echo', TOKEN]], [own, full])).toEqual([['x-echo', '[redacted]']]);
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
