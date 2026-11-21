/**
 * Putting masked pages together for the window (src/backend/mask-streams.ts): what the worker
 * answered, in place, and anything it didn't account for hidden.
 */
import { describe, expect, it } from 'vitest';
import { assembleEvents, assembleMessages, MESSAGE_NOT_CHECKED } from '../src/backend/mask-streams';
import { EVENT_FAILED } from '../src/backend/mask-body';
import type { SseEventsView, WebSocketMessages } from '../src/shared/api';

const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const b64 = (t: string) => Buffer.from(t).toString('base64');
const meta = (index: number) => ({ index, fromClient: false, isBinary: false, time: index, size: 10 });
const page: WebSocketMessages = {
  messages: [
    { ...meta(0), base64: b64(`a ${SECRET}`) },
    { ...meta(1), base64: b64('plain') },
  ],
  dropped: 0,
  total: 2,
};
const ok = (bytes: string, text: string) => ({
  bytes: Buffer.from(bytes),
  text,
  ranges: [] as Array<[number, number]>,
});

describe('assembleMessages', () => {
  it('takes each message’s answer, in place, and says so when the list is full', () => {
    const out = assembleMessages(page, {
      messages: [ok('a ****', 'a [redacted]'), { hidden: 'nope' }],
      full: true,
      lost: false,
    });
    expect(out.messages[0]).toMatchObject({
      index: 0,
      base64: b64('a ****'),
      masked: { text: 'a [redacted]', full: true },
    });
    expect(out.messages[1]).toMatchObject({ index: 1, base64: '', masked: { hidden: 'nope' } });
  });

  it('hides every message when checking failed, or nothing came back', () => {
    for (const answer of [{ failed: 'took too long' }, undefined] as const) {
      const out = assembleMessages(page, answer);
      expect(out.messages.every((m) => m.base64 === '' && m.masked && 'hidden' in m.masked)).toBe(true);
    }
    expect(assembleMessages(page, { failed: 'took too long' }).messages[0]!.masked).toEqual({
      hidden: 'took too long',
    });
  });

  it('hides every message when the answer has too few or too many', () => {
    for (const messages of [[ok('x', 'x')], [ok('x', 'x'), ok('y', 'y'), ok('z', 'z')]]) {
      const out = assembleMessages(page, { messages, full: false, lost: false });
      expect(out.messages.map((m) => m.masked)).toEqual([
        { hidden: MESSAGE_NOT_CHECKED },
        { hidden: MESSAGE_NOT_CHECKED },
      ]);
    }
  });

  it('hides a message whose answer isn’t the right shape', () => {
    const out = assembleMessages(page, {
      messages: [
        { bytes: 'not bytes', ranges: [] } as never,
        { bytes: Buffer.from('p'), ranges: 'no' } as never,
      ],
      full: false,
      lost: false,
    });
    expect(out.messages.map((m) => [m.base64, m.masked])).toEqual([
      ['', { hidden: MESSAGE_NOT_CHECKED }],
      ['', { hidden: MESSAGE_NOT_CHECKED }],
    ]);
  });
});

describe('assembleEvents', () => {
  const view: SseEventsView = {
    serial: 1,
    total: 2,
    receiving: false,
    items: [
      { kind: 'event', index: 1, type: 'm', data: `x ${SECRET}` },
      { kind: 'comment', index: 2, text: SECRET },
    ],
    problem: `stopped at password=${SECRET}`,
  };
  const sweep = (t: string) => t.replace(SECRET, '[redacted]');

  it('takes the masked items, sweeps the note, and says so when the list is full', () => {
    const items = [
      { kind: 'event' as const, index: 1, type: 'm', data: 'x [redacted]' },
      { kind: 'comment' as const, index: 2, text: '[redacted]' },
    ];
    const out = assembleEvents(view, { items, full: true, lost: false }, sweep);
    expect(out).toMatchObject({ items, problem: 'stopped at password=[redacted]', full: true });
  });

  it('marks every item when checking failed, nothing came back, or the items don’t match', () => {
    const wrong: Array<Parameters<typeof assembleEvents>[1]> = [
      { failed: 'no' },
      undefined,
      { items: [view.items[0]!], full: false, lost: false },
      { items: [view.items[1]!, view.items[0]!], full: false, lost: false },
      // The same kinds, in the wrong places.
      {
        items: [
          { ...view.items[0]!, index: 7 },
          { ...view.items[1]!, index: 8 },
        ] as never,
        full: false,
        lost: false,
      },
    ];
    for (const answer of wrong) {
      const out = assembleEvents(view, answer, sweep);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out.items).toEqual([
        { kind: 'event', index: 1, type: '[redacted]', data: EVENT_FAILED },
        { kind: 'comment', index: 2, text: EVENT_FAILED },
      ]);
      expect(out.full).toBeUndefined();
    }
  });
});
