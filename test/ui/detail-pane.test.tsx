import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExchangeDetail } from '../../src/shared/api';
import { DetailPane } from '../../src/renderer/src/DetailPane';
import { describeFailure } from '../../src/shared/failure';
import { deferred, detail, summary } from './fixtures';

const pane = (
  props: Partial<Parameters<typeof DetailPane>[0]> &
    Pick<Parameters<typeof DetailPane>[0], 'summary' | 'send'>,
) => <DetailPane onClose={() => undefined} actions={[]} stale={false} {...props} />;

describe('DetailPane', () => {
  it('shows the selected exchange’s details, even when an earlier reply arrives late', async () => {
    const a = summary('a');
    const b = summary('b');
    const replies = { a: deferred<ExchangeDetail>(), b: deferred<ExchangeDetail>() };
    const send = vi.fn((command: { command: string; exchangeId?: string }) =>
      command.command === 'getExchange'
        ? replies[command.exchangeId as 'a' | 'b'].promise
        : Promise.resolve(null),
    );
    const view = render(pane({ summary: a, send }));
    view.rerender(pane({ summary: b, send }));
    await act(async () => replies.b.resolve(detail(b, 'from-b')));
    expect(screen.getByText('from-b')).toBeTruthy();
    // A's reply turns up after B's: it mustn't replace what's shown.
    await act(async () => replies.a.resolve(detail(a, 'from-a')));
    expect(screen.queryByText('from-a')).toBeNull();
    expect(screen.getByText('from-b')).toBeTruthy();
  });

  it('never shows one exchange’s headers under another’s URL while the next loads', async () => {
    const a = summary('a');
    const b = summary('b');
    const slowB = deferred<ExchangeDetail>();
    const send = vi.fn((command: { command: string; exchangeId?: string }) =>
      command.command !== 'getExchange'
        ? Promise.resolve(null)
        : command.exchangeId === 'a'
          ? Promise.resolve(detail(a, 'from-a'))
          : slowB.promise,
    );
    const view = render(pane({ summary: a, send }));
    await act(async () => undefined);
    expect(screen.getByText('from-a')).toBeTruthy();
    view.rerender(pane({ summary: b, send }));
    expect(screen.getByText('https://api.test/b')).toBeTruthy();
    expect(screen.queryByText('from-a')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('asks nothing of the backend for an exchange from before a restart, and says why', async () => {
    const send = vi.fn(async () => null);
    render(pane({ summary: summary('old'), send, stale: true }));
    await act(async () => undefined);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText(/from before Wirescry’s proxy restarted/)).toBeTruthy();
    expect(screen.getByText('Lost when the proxy restarted.')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('lists the query and offers plugin actions', async () => {
    const run = vi.fn();
    const s = summary('q', { url: 'https://api.test/search?q=wire&page=2', path: '/search?q=wire&page=2' });
    render(
      pane({
        summary: s,
        send: vi.fn(async () => detail(s, 'x')),
        actions: [{ key: 'pro:mock', label: 'Mock…', run }],
      }),
    );
    await act(async () => undefined);
    expect(screen.getByText('Query')).toBeTruthy();
    expect(screen.getByText('wire')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    screen.getByText('Mock…').click();
    expect(run).toHaveBeenCalledOnce();
  });

  it('labels the reply Wirescry sent when the server never answered', async () => {
    const failed = summary('f', {
      status: 502,
      failure: describeFailure('ETIMEDOUT', 'api.test', 'AggregateError'),
    });
    const send = vi.fn((command: { command: string }) =>
      command.command === 'getExchange' ? Promise.resolve(detail(failed, 'm')) : Promise.resolve(null),
    );
    await act(async () => {
      render(pane({ summary: failed, send }));
    });
    expect(screen.getByText('Timed out connecting to api.test.')).toBeTruthy();
    expect(screen.queryByText('AggregateError')).toBeNull();
    expect(screen.getByText('Response headers (sent by Wirescry)')).toBeTruthy();
    expect(screen.getByText(/between the client and Wirescry/)).toBeTruthy();
  });

  it('doesn’t label a partial response as Wirescry’s', async () => {
    const partial = summary('p', {
      status: 200,
      failure: { ...describeFailure('ECONNRESET', 'api.test'), partial: true },
    });
    const send = vi.fn((command: { command: string }) =>
      command.command === 'getExchange' ? Promise.resolve(detail(partial, 'm')) : Promise.resolve(null),
    );
    await act(async () => {
      render(pane({ summary: partial, send }));
    });
    expect(screen.getByText('Response headers')).toBeTruthy();
  });
});

describe('DetailPane plugin sections', () => {
  it('shows plugins’ sections under their headings, and none when there are none', () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      pane({
        summary: summary('a'),
        send,
        sections: [{ key: 'pro:spec', label: 'API spec', content: <p>Matches the spec.</p> }],
      }),
    );
    expect(screen.getByText('API spec').tagName).toBe('SUMMARY');
    expect(screen.getByText('Matches the spec.')).toBeTruthy();
    view.rerender(pane({ summary: summary('a'), send }));
    expect(screen.queryByText('API spec')).toBeNull();
  });
});
