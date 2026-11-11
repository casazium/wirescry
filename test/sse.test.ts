/**
 * Parsing Server-Sent Events (src/shared/sse.ts), as the WHATWG HTML spec's event stream
 * interpretation says, including text that arrives in pieces split anywhere.
 */
import { describe, expect, it } from 'vitest';
import { isEventStream, MAX_SSE_DATA, parseSse, SseParser, type SseItem } from '../src/shared/sse';

/** Feeds the text in the given pieces, collecting what each completes. */
const inPieces = (...pieces: string[]): SseItem[] => {
  const parser = new SseParser();
  return pieces.flatMap((p) => parser.push(p));
};
const events = (items: SseItem[]) => items.filter((i) => i.kind === 'event');

describe('parsing an event stream', () => {
  it('gives an event at each blank line, with its type, data and id', () => {
    expect(parseSse('event: price\ndata: 42\nid: 7\n\ndata: plain\n\n')).toEqual([
      { kind: 'event', index: 1, type: 'price', data: '42', id: '7' },
      // The last event ID carries on to later events.
      { kind: 'event', index: 2, type: 'message', data: 'plain', id: '7' },
    ]);
  });

  it('joins data lines with line feeds, and keeps an event whose data is empty', () => {
    expect(parseSse('data: one\ndata:two\ndata\n\ndata:\n\n')).toEqual([
      { kind: 'event', index: 1, type: 'message', data: 'one\ntwo\n' },
      { kind: 'event', index: 2, type: 'message', data: '' },
    ]);
  });

  it('takes CR, LF and CRLF as line endings, even split across pieces', () => {
    const want = [
      { kind: 'event', index: 1, type: 'message', data: 'a' },
      { kind: 'event', index: 2, type: 'message', data: 'b' },
    ];
    expect(parseSse('data: a\r\rdata: b\r\r')).toEqual(want);
    expect(parseSse('data: a\r\n\r\ndata: b\r\n\r\n')).toEqual(want);
    // A CR ending one piece and an LF starting the next are one line ending, not two.
    expect(inPieces('data: a\r', '\ndata: b\r', '\n\r', '\n')).toEqual([
      { kind: 'event', index: 1, type: 'message', data: 'a\nb' },
    ]);
    expect(inPieces('da', 'ta: ', 'a\n', '\n', 'data: b', '\n\n')).toEqual(want);
    // An empty piece between them (one that decompressed to nothing, say) changes nothing.
    expect(inPieces('data: a\r', '', '\ndata: b\r\n\r\n')).toEqual([
      { kind: 'event', index: 1, type: 'message', data: 'a\nb' },
    ]);
  });

  it('shows comments and retry times as such', () => {
    expect(parseSse(': keep-alive\nretry: 3000\n:\n')).toEqual([
      { kind: 'comment', index: 1, text: 'keep-alive' },
      { kind: 'retry', index: 2, ms: 3000 },
      { kind: 'comment', index: 3, text: '' },
    ]);
  });

  it('drops one leading BOM from a whole stream', () => {
    expect(parseSse('\uFEFFdata: x\n\n')).toEqual([{ kind: 'event', index: 1, type: 'message', data: 'x' }]);
  });

  it('knows an event stream by its content type', () => {
    expect(isEventStream('text/event-stream')).toBe(true);
    expect(isEventStream('Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(isEventStream('text/plain')).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });
});

describe('parsing an event stream, by the rules for what is ignored', () => {
  it('doesn’t give an event that hasn’t ended with a blank line', () => {
    expect(parseSse('data: done\n\ndata: not yet\n')).toEqual([
      { kind: 'event', index: 1, type: 'message', data: 'done' },
    ]);
    expect(parseSse('data: no ending at all')).toEqual([]);
  });

  it('ignores an id with NUL in it, a retry that isn’t digits, and fields it doesn’t know', () => {
    const items = parseSse('id: 1\n\nid: a\u0000b\ndata: x\n\nretry: 10s\nretry:\nfoo: bar\ndata: y\n\n');
    expect(items).toEqual([
      { kind: 'event', index: 1, type: 'message', data: 'x', id: '1' },
      { kind: 'event', index: 2, type: 'message', data: 'y', id: '1' },
    ]);
  });

  it('gives no event for blank lines with no data, nor for an event type alone', () => {
    expect(parseSse('\n\n\nevent: lonely\n\n')).toEqual([]);
  });

  it('keeps the first 64 KB of an event’s data, and says it was cut', () => {
    const long = 'x'.repeat(MAX_SSE_DATA + 500);
    const [event] = events(parseSse(`data: ${long}\ndata: more\n\n`));
    expect(event).toMatchObject({ kind: 'event', cut: true });
    expect((event as { data: string }).data.length).toBe(MAX_SSE_DATA);
    // A long line arriving in many pieces is held only up to its limit.
    const parser = new SseParser();
    parser.push('data: ');
    for (let i = 0; i < 100; i++) parser.push('y'.repeat(10_000));
    const [cut] = parser.push('\n\n');
    expect(cut).toMatchObject({ kind: 'event', cut: true });
    expect((cut as { data: string }).data.length).toBe(MAX_SSE_DATA);
  });
});
