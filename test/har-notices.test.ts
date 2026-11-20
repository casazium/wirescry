import { describe, expect, it } from 'vitest';
import { exportNotice, importNotice } from '../src/renderer/src/har-notices';

const none = { values: 0, requests: 0, dropped: 0, notScanned: 0, leftOut: 0, full: false };

describe('exportNotice', () => {
  it('says how many places were redacted, one or many', () => {
    expect(exportNotice({ name: 'a.har', count: 2, redaction: { ...none, values: 1, requests: 1 } }, 0)).toBe(
      'Exported 2 requests to a.har, with secrets redacted in 1 place. Redaction is best effort for bodies: check before sharing.',
    );
    expect(
      exportNotice({ name: 'a.har', count: 1, redaction: { ...none, values: 1234, requests: 1 } }, 0),
    ).toBe(
      'Exported 1 request to a.har, with secrets redacted in 1,234 places. Redaction is best effort for bodies: check before sharing.',
    );
  });

  it('says when no secrets were found, still best effort', () => {
    expect(exportNotice({ name: 'a.har', count: 3, redaction: none }, 0)).toBe(
      'Exported 3 requests to a.har. No secrets were found. Redaction is best effort for bodies: check before sharing.',
    );
  });

  it('adds what was left out or not checked, in the singular and plural, and only when there is some', () => {
    const one = exportNotice(
      { name: 'a.har', count: 1, redaction: { ...none, dropped: 1, leftOut: 1, notScanned: 1 } },
      0,
    );
    expect(one).toContain('1 request was left out: it couldn’t be redacted.');
    expect(one).toContain('1 body or message was left out: it couldn’t be redacted safely.');
    expect(one).toContain('1 body or message wasn’t checked: binary or still encoded.');
    const many = exportNotice(
      { name: 'a.har', count: 1, redaction: { ...none, dropped: 2, leftOut: 3, notScanned: 4 } },
      0,
    );
    expect(many).toContain('2 requests were left out: they couldn’t be redacted.');
    expect(many).toContain('3 bodies or messages were left out: they couldn’t be redacted safely.');
    expect(many).toContain('4 bodies or messages weren’t checked: binary or still encoded.');
    const clean = exportNotice({ name: 'a.har', count: 1, redaction: none }, 0);
    expect(clean).not.toMatch(/left out|checked|missed/);
    expect(exportNotice({ name: 'a.har', count: 1, redaction: { ...none, full: true } }, 0)).toContain(
      'Some secrets may have been missed: there were too many to keep track of.',
    );
  });

  it('says plainly when secrets weren’t redacted', () => {
    expect(exportNotice({ name: 'a.har', count: 1 }, 0)).toBe(
      'Exported 1 request to a.har. Secrets weren’t redacted.',
    );
  });

  it('says how many weren’t included after a restart, either way', () => {
    expect(exportNotice({ name: 'a.har', count: 1 }, 1)).toBe(
      'Exported 1 request to a.har. Secrets weren’t redacted. 1 from before the proxy restarted wasn’t included: its details were lost.',
    );
    expect(exportNotice({ name: 'a.har', count: 1, redaction: none }, 2)).toMatch(
      /check before sharing\. 2 from before the proxy restarted weren’t included: their details were lost\.$/,
    );
  });
});

describe('importNotice', () => {
  it('adds the redacted note only for a redacted file', () => {
    expect(importNotice({ name: 'x.har', imported: 1 })).toBe('Imported 1 request from x.har.');
    expect(importNotice({ name: 'x.har', imported: 1, redacted: false })).toBe(
      'Imported 1 request from x.har.',
    );
    expect(
      importNotice({
        name: 'x.har',
        imported: 3,
        skipped: 1,
        problems: ['Entry 2: bad.'],
        removed: 2,
        redacted: true,
      }),
    ).toBe(
      'Imported 3 requests from x.har. Skipped 1: Entry 2: bad. To make room, the oldest 2 requests left the list. This file’s secrets were redacted, so resending its requests won’t sign in.',
    );
  });
});
