/**
 * Putting a masked page of WebSocket messages or Server-Sent Events together for the window, from
 * the backend's own page and the mask worker's answer (src/backend/masker.ts). Fails closed: a
 * message or item the answer doesn't account for, as expected, isn't shown.
 */
import type { SseEventsView, WebSocketMessages } from '../shared/api';
import { failedItem } from './mask-body';
import type { EventsAnswer, MessagesAnswer } from './masker';

type Message = WebSocketMessages['messages'][number];

export const MESSAGE_NOT_CHECKED = 'Couldn’t check this message for secrets.';

const hide = (m: Message, why: string): Message => ({ ...m, base64: '', masked: { hidden: why } });

/** A page of messages as shown: each of ours, with the answer for it in the same place. */
export function assembleMessages(
  page: WebSocketMessages,
  answer: MessagesAnswer | undefined,
): WebSocketMessages {
  const ok = answer && !('failed' in answer) && answer.messages.length === page.messages.length;
  const why = answer && 'failed' in answer ? answer.failed : MESSAGE_NOT_CHECKED;
  const full = answer && !('failed' in answer) && answer.full;
  return {
    ...page,
    messages: page.messages.map((m, i) => {
      if (!ok) return hide(m, why);
      const one = answer.messages[i];
      if (!one) return hide(m, MESSAGE_NOT_CHECKED);
      if ('hidden' in one) return hide(m, typeof one.hidden === 'string' ? one.hidden : MESSAGE_NOT_CHECKED);
      if (!(one.bytes instanceof Uint8Array) || !Array.isArray(one.ranges))
        return hide(m, MESSAGE_NOT_CHECKED);
      return {
        ...m,
        base64: Buffer.from(one.bytes).toString('base64'),
        masked: {
          ...(typeof one.text === 'string' ? { text: one.text } : {}),
          ranges: one.ranges,
          ...(one.binary ? { binary: true as const } : {}),
          ...(full ? { full: true as const } : {}),
        },
      };
    }),
  };
}

/**
 * A page of events as shown: the answer's items when it has one for each of ours, else each of
 * ours saying it couldn't be checked. `sweep` masks Wirescry's own note about the stream.
 */
export function assembleEvents(
  view: SseEventsView,
  answer: EventsAnswer | undefined,
  sweep: (text: string) => string,
): SseEventsView {
  const problem = view.problem === undefined ? {} : { problem: sweep(view.problem) };
  const ok =
    answer &&
    !('failed' in answer) &&
    answer.items.length === view.items.length &&
    answer.items.every(
      (item, i) => item?.index === view.items[i]!.index && item.kind === view.items[i]!.kind,
    );
  if (!ok) return { ...view, items: view.items.map(failedItem), ...problem };
  return { ...view, items: answer.items, ...problem, ...(answer.full ? { full: true as const } : {}) };
}
