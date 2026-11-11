/**
 * Server-Sent Events (text/event-stream), parsed as the WHATWG HTML spec's "event stream
 * interpretation" says, a piece of text at a time: lines end with CR, LF or CRLF (a CR at the
 * end of one piece and an LF at the start of the next are one ending), a leading BOM is dropped
 * by the caller's decoder, and an event that hasn't ended with a blank line isn't given yet.
 */

/** Whether a response is an event stream. */
export function isEventStream(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
}

/** One item in an event stream, in the order it came. */
export type SseItem =
  | {
      kind: 'event';
      index: number;
      /** The `event:` field, or "message". */
      type: string;
      data: string;
      /** The last event ID once this event was given, if any. */
      id?: string;
      /** True if `data` was cut to MAX_SSE_DATA characters. */
      cut?: true;
    }
  | { kind: 'comment'; index: number; text: string }
  | { kind: 'retry'; index: number; ms: number };

/** Characters of an event's data kept; the rest is counted, not kept. */
export const MAX_SSE_DATA = 64 * 1024;
/** Characters of a line held; the rest of a longer one is dropped. */
const MAX_LINE = MAX_SSE_DATA + 1024;

/** Feed it text with push(); it returns the items each piece completed. */
export class SseParser {
  private line = '';
  /** The previous piece ended with a CR: an LF starting this one is part of that line ending. */
  private afterCr = false;
  private data: string[] = [];
  private dataLength = 0;
  private dataCut = false;
  private type = '';
  private lastId: string | undefined;
  private next = 1;

  push(text: string): SseItem[] {
    // Nothing new (a piece that decompressed to nothing, say): a CR it ended on still waits for an LF.
    if (text === '') return [];
    const items: SseItem[] = [];
    let start = 0;
    if (this.afterCr && text.startsWith('\n')) start = 1;
    this.afterCr = false;
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.addToLine(text.slice(start, i));
      this.endLine(items);
      if (c === 13) {
        if (i + 1 === text.length) this.afterCr = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
    }
    this.addToLine(text.slice(start));
    return items;
  }

  private addToLine(part: string): void {
    if (part.length === 0) return;
    // Held only up to a limit: the data kept from a line is less than this anyway.
    const room = MAX_LINE - this.line.length;
    if (room > 0) this.line += part.slice(0, room);
  }

  private endLine(items: SseItem[]): void {
    const line = this.line;
    this.line = '';
    if (line === '') {
      this.dispatch(items);
      return;
    }
    if (line.startsWith(':')) {
      items.push({ kind: 'comment', index: this.next++, text: line.slice(1).replace(/^ /, '') });
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.type = value;
        break;
      case 'data': {
        const room = MAX_SSE_DATA - this.dataLength;
        if (room <= 0) {
          this.dataCut = true;
        } else {
          const kept = value.length > room ? value.slice(0, room) : value;
          if (kept.length < value.length) this.dataCut = true;
          this.data.push(kept);
          this.dataLength += kept.length + 1;
        }
        break;
      }
      case 'id':
        // An ID with NUL in it is ignored.
        if (!value.includes('\0')) this.lastId = value;
        break;
      case 'retry':
        // Only digits count.
        if (/^\d+$/.test(value)) items.push({ kind: 'retry', index: this.next++, ms: Number(value) });
        break;
      default:
        // Other fields are ignored.
        break;
    }
  }

  private dispatch(items: SseItem[]): void {
    const hadData = this.data.length > 0;
    const data = this.data.join('\n');
    const type = this.type;
    const cut = this.dataCut;
    this.data = [];
    this.dataLength = 0;
    this.dataCut = false;
    this.type = '';
    if (!hadData) return;
    items.push({
      kind: 'event',
      index: this.next++,
      type: type || 'message',
      data,
      ...(this.lastId !== undefined && this.lastId !== '' ? { id: this.lastId } : {}),
      ...(cut ? { cut: true as const } : {}),
    });
  }
}

/** The events of a whole stream at once (an event not ended with a blank line left out). */
export function parseSse(text: string): SseItem[] {
  return new SseParser().push(text.replace(/^\uFEFF/, ''));
}
