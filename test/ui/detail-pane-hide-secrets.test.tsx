/**
 * DetailPane with View › Hide Secrets on, rendered on its own: late answers, old connections,
 * and the stream views' errors and notes.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocketMessages } from '../../src/shared/api';
import { DetailPane } from '../../src/renderer/src/DetailPane';
import { SecretsHidden } from '../../src/renderer/src/secrets';
import { deferred, detail, summary } from './fixtures';

const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const b64 = (t: string) => Buffer.from(t).toString('base64');
type Props = Parameters<typeof DetailPane>[0];
const pane = (hidden: boolean, props: Partial<Props> & Pick<Props, 'summary' | 'send'>) => (
  <SecretsHidden.Provider value={hidden}>
    <DetailPane onClose={() => undefined} actions={[]} stale={false} {...props} />
  </SecretsHidden.Provider>
);
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => undefined);
};
const socket = summary('w', { websocket: true, messageCount: 1, responseSize: undefined, status: 101 });
const realPage: WebSocketMessages = {
  messages: [
    { index: 0, fromClient: false, isBinary: false, time: 0, size: 20, base64: b64(`hi ${SECRET}`) },
  ],
  dropped: 0,
  total: 1,
};
const maskedPage: WebSocketMessages = {
  messages: [
    {
      index: 0,
      fromClient: false,
      isBinary: false,
      time: 0,
      size: 20,
      base64: b64(`hi ${'*'.repeat(SECRET.length)}`),
      masked: { text: 'hi [redacted]', ranges: [[3, 3 + SECRET.length]] },
    },
  ],
  dropped: 0,
  total: 1,
};

describe('DetailPane with Hide Secrets on', () => {
  it('never shows a real page of messages that arrives after the switch was turned on', async () => {
    const slowReal = deferred<WebSocketMessages>();
    const send = vi.fn((command: { command: string; mask?: boolean }) => {
      if (command.command === 'getExchange') return Promise.resolve(detail(socket, 'm'));
      if (command.command === 'getWebSocketMessages')
        return command.mask ? Promise.resolve(maskedPage) : slowReal.promise;
      return Promise.resolve(null);
    });
    const view = render(pane(false, { summary: socket, send }));
    await settle();
    view.rerender(pane(true, { summary: socket, send }));
    await settle();
    expect(screen.getByText('hi [redacted]')).toBeTruthy();
    // The real page, asked for before, turns up now.
    await act(async () => slowReal.resolve(realPage));
    await settle();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByText('hi [redacted]')).toBeTruthy();
  });

  it('says an old connection’s messages can’t be checked, and asks for nothing', async () => {
    const send = vi.fn(async () => null);
    render(pane(true, { summary: socket, send, stale: true }));
    await settle();
    expect(
      screen.getByText(/Can’t be checked for secrets: the proxy that had these messages restarted/),
    ).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('shows an old connection’s messages as before with the switch off', async () => {
    const send = vi.fn(async () => null);
    render(pane(false, { summary: socket, send, stale: true }));
    await settle();
    expect(screen.queryByText(/Can’t be checked for secrets/)).toBeNull();
  });

  it('masks an event stream’s error, and notes a full list of values', async () => {
    const stream = summary('s', { contentType: 'text/event-stream', responseSize: undefined });
    let fail = true;
    const send = vi.fn(async (command: { command: string }) => {
      if (command.command === 'getExchange') return { ...detail(stream, 'm'), responseBody: undefined };
      if (command.command === 'getSseEvents') {
        if (fail) throw new Error(`failed: password=${SECRET}`);
        return {
          serial: 1,
          total: 1,
          receiving: false,
          items: [{ kind: 'comment', index: 1, text: 'hi' }],
          full: true,
        };
      }
      return null;
    });
    const view = render(pane(true, { summary: stream, send }));
    await settle();
    expect(screen.getByText('failed: password=[redacted]')).toBeTruthy();
    fail = false;
    view.rerender(pane(true, { summary: { ...stream, responseSize: 5 }, send }));
    await settle();
    expect(screen.getByText(/Some values seen earlier may not be hidden/)).toBeTruthy();
  });
});
