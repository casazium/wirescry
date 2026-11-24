/**
 * DetailPane with View › Hide Secrets on, rendered on its own: late answers, old connections,
 * and the stream views' errors and notes.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExchangeDetail, WebSocketMessages } from '../../src/shared/api';
import { DetailPane } from '../../src/renderer/src/DetailPane';
import { KnownSecrets, SecretsHidden, type Masking } from '../../src/renderer/src/secrets';
import { KnownValues } from '../../src/shared/redact-body';
import { deferred, detail, summary } from './fixtures';

const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const b64 = (t: string) => Buffer.from(t).toString('base64');
type Props = Parameters<typeof DetailPane>[0];
/** Known values as the window has them: covered, with these values. */
const masking = (values: string[] = [], covered = true, full = false): Masking => {
  const known = new KnownValues();
  for (const v of values) known.add(v);
  return { known, version: 1, covered, full };
};
const COVERED = masking();
const pane = (
  hidden: boolean,
  props: Partial<Props> & Pick<Props, 'summary' | 'send'>,
  known: Masking = COVERED,
) => (
  <SecretsHidden.Provider value={hidden}>
    <KnownSecrets.Provider value={known}>
      <DetailPane onClose={() => undefined} actions={[]} stale={false} {...props} />
    </KnownSecrets.Provider>
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

describe('DetailPane with known values', () => {
  // A token learned from Authorization: no rule finds it by name in the URL or x-echo.
  const TOKEN = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
  const s = summary('k', { url: `https://api.test/u/${TOKEN}/x`, path: `/u/${TOKEN}/x`, status: 302 });
  const full: ExchangeDetail = {
    ...detail(s, 'm'),
    requestHeaders: [
      ['authorization', `Bearer ${TOKEN}`],
      ['accept', 'text/html'],
    ],
    responseHeaders: [
      ['x-echo', `you sent ${TOKEN}`],
      ['location', `https://api.test/cb?state=${TOKEN}`],
      ['x-plain', 'hello-world'],
    ],
    responseTrailers: [['x-trailer', `t-${TOKEN}`]],
  };
  const send = vi.fn(async (command: { command: string }) =>
    command.command === 'getExchange' ? full : null,
  );
  const everything = (): string => {
    const parts = [document.body.textContent ?? ''];
    for (const el of document.body.querySelectorAll('*')) for (const a of el.attributes) parts.push(a.value);
    return parts.join('\n');
  };

  it('hides a repeat in the URL, a header, a trailer and the redirect; keeps ordinary values', async () => {
    render(pane(true, { summary: s, send }, masking([TOKEN])));
    await settle();
    expect(everything()).not.toContain(TOKEN);
    expect(screen.getByText('you sent [redacted]')).toBeTruthy();
    expect(screen.getByText('t-[redacted]')).toBeTruthy();
    // In the Location header and as where it redirects to.
    expect(screen.getAllByText('https://api.test/cb?state=[redacted]')).toHaveLength(2);
    expect(document.querySelector('.redirect')?.textContent).toBe('https://api.test/cb?state=[redacted]');
    expect(document.querySelector('.detail-url')?.textContent).toBe('https://api.test/u/[redacted]/x');
    expect(screen.getByText('hello-world')).toBeTruthy();
    expect(screen.getByText('text/html')).toBeTruthy();
  });

  it('shows them with the switch off', async () => {
    render(pane(false, { summary: s, send }, masking([TOKEN])));
    await settle();
    expect(everything()).toContain(TOKEN);
  });

  it('hides its own token first, though the session’s set is full and lacks it', async () => {
    const filler = Array.from({ length: 10_001 }, (_, i) => `Filler${i}Zx8Wv6Ut4Sr2Qp`);
    const session = masking(filler, true, true);
    expect(session.known.full).toBe(true);
    render(pane(true, { summary: s, send }, session));
    await settle();
    expect(everything()).not.toContain(TOKEN);
    expect(screen.getByText('you sent [redacted]')).toBeTruthy();
  });

  it('shows "Hiding secrets…" for the URL and header values until covered, and disables Copy URL', async () => {
    const view = render(pane(true, { summary: s, send }, masking([], false)));
    await settle();
    expect(everything()).not.toContain(TOKEN);
    expect(document.querySelector('.detail-url')?.textContent).toBe('Hiding secrets…');
    // Header names stay; values don't.
    expect(screen.getByText('x-plain')).toBeTruthy();
    expect(screen.queryByText('hello-world')).toBeNull();
    const copy = screen.getByRole('button', { name: 'Copy URL' }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(copy.title).toBe('Checking for secrets…');
    view.rerender(pane(true, { summary: s, send }, masking([TOKEN])));
    await settle();
    expect(document.querySelector('.detail-url')?.textContent).toBe('https://api.test/u/[redacted]/x');
    expect((screen.getByRole('button', { name: 'Copy URL' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('hello-world')).toBeTruthy();
  });

  it('shows a request from before a restart as can’t be checked, even with what it had loaded', async () => {
    const view = render(pane(true, { summary: s, send }, masking([TOKEN])));
    await settle();
    view.rerender(pane(true, { summary: s, send, stale: true }, masking([TOKEN])));
    await settle();
    expect(document.querySelector('.detail-url')?.textContent).toBe(
      'Can’t be checked for secrets: the proxy restarted',
    );
    expect(screen.queryByText('hello-world')).toBeNull();
    expect((screen.getByRole('button', { name: 'Copy URL' }) as HTMLButtonElement).disabled).toBe(true);
    expect(everything()).not.toContain(TOKEN);
  });

  it('masks a body’s load error with the known values, or "Checking…" until covered', async () => {
    const withBody = { ...full, responseBody: { size: 5, stored: 5 } };
    const failing = vi.fn(async (command: { command: string }) => {
      if (command.command === 'getExchange') return withBody;
      if (command.command === 'getBody') throw new Error(`upstream said ${TOKEN}`);
      return null;
    });
    const sized = { ...s, responseSize: 5 };
    const view = render(pane(true, { summary: sized, send: failing }, masking([TOKEN])));
    await settle();
    expect(screen.getByText('upstream said [redacted]')).toBeTruthy();
    view.rerender(pane(true, { summary: sized, send: failing }, masking([], false)));
    await settle();
    expect(screen.queryByText(/upstream said/)).toBeNull();
    expect(everything()).not.toContain(TOKEN);
  });

  it('doesn’t decode a gRPC -bin value it holds back', async () => {
    const grpc = summary('g', { grpc: true, contentType: 'application/grpc' });
    const bin: ExchangeDetail = { ...detail(grpc, 'm'), requestHeaders: [['x-data-bin', 'AAEC']] };
    const view = render(pane(true, { summary: grpc, send: vi.fn(async () => bin) }, masking([], false)));
    await settle();
    expect(document.querySelector('.decoded')).toBeNull();
    view.rerender(pane(true, { summary: grpc, send: vi.fn(async () => bin) }, masking()));
    await settle();
    expect(document.querySelector('.decoded')?.textContent).toContain('00 01 02');
  });
});
