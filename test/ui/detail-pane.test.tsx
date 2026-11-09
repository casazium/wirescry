import { act, fireEvent, render, screen } from '@testing-library/react';
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

describe('DetailPane order and timing', () => {
  /** The pane's headings, in the order shown. */
  const headings = (): string[] =>
    [...document.querySelectorAll('aside h2, aside summary')].map((e) => e.textContent ?? '');
  const shown = async (props: Partial<Parameters<typeof DetailPane>[0]>, s = summary('o')) => {
    // With a response body, so its section shows.
    const withBody = { ...detail(s, 'm'), responseBody: { size: 10, stored: 10 } };
    const send = vi.fn((command: { command: string }) =>
      command.command === 'getExchange' ? Promise.resolve(withBody) : Promise.resolve(null),
    );
    await act(async () => {
      render(pane({ summary: s, send, ...props }));
    });
  };

  it('puts the response first, body then headers, when asked (as Compose does)', async () => {
    await shown({ responseFirst: true });
    const order = headings();
    const at = (name: string) => order.indexOf(name);
    expect(at('Overview')).toBe(0);
    expect(at('Response body')).toBe(1);
    expect(at('Response headers')).toBe(2);
    expect(at('Timing')).toBeGreaterThan(at('Response headers'));
    expect(at('Request headers')).toBeGreaterThan(at('Timing'));
  });

  it('keeps the request before the response otherwise (as Traffic does)', async () => {
    await shown({});
    const order = headings();
    const at = (name: string) => order.indexOf(name);
    expect(at('Timing')).toBeLessThan(at('Request headers'));
    expect(at('Request headers')).toBeLessThan(at('Response headers'));
    expect(at('Response headers')).toBeLessThan(at('Response body'));
  });

  it('says it waited for the server, unless a rule answered (a mock, a delay or a pause)', async () => {
    await shown({});
    expect(screen.getByText('Waiting for server')).toBeTruthy();
    expect(screen.queryByText('Waiting for response')).toBeNull();
  });

  it('says it waited for the response when a rule handled the request', async () => {
    await shown({}, summary('r', { handledBy: { plugin: 'pro', ruleId: 'x', label: 'Mock users' } }));
    expect(screen.getByText('Waiting for response')).toBeTruthy();
    expect(screen.queryByText('Waiting for server')).toBeNull();
  });
});

describe('DetailPane redirects', () => {
  const redirect = summary('old', { status: 302, statusMessage: 'Found', url: 'https://api.test/old' });
  const withLocation = (location: string): ExchangeDetail => ({
    ...detail(redirect, 'x'),
    responseHeaders: [['Location', location]],
  });
  const next = summary('new', { url: 'https://api.test/new', startedAt: 5 });

  it('links to the request that followed, and shows it when clicked', async () => {
    const onSelectExchange = vi.fn();
    const followingRequest = vi.fn((target: string) =>
      target === 'https://api.test/new' ? next : undefined,
    );
    render(
      pane({
        summary: redirect,
        send: vi.fn(async () => withLocation('/new')),
        followingRequest,
        onSelectExchange,
      }),
    );
    await act(async () => undefined);
    // Location is resolved against the request's URL before it's looked up.
    expect(followingRequest).toHaveBeenCalledWith('https://api.test/new');
    const link = screen.getByRole('button', { name: 'https://api.test/new' });
    expect(link.closest('dd')?.previousElementSibling?.textContent).toBe('Redirects to');
    fireEvent.click(link);
    expect(onSelectExchange).toHaveBeenCalledWith('new');
  });

  it('shows where it points, without a link, when no request followed it', async () => {
    render(
      pane({
        summary: redirect,
        send: vi.fn(async () => withLocation('https://elsewhere.test/x')),
        followingRequest: () => undefined,
        onSelectExchange: vi.fn(),
      }),
    );
    await act(async () => undefined);
    expect(document.querySelector('dd.redirect')?.textContent).toBe('https://elsewhere.test/x');
    expect(document.querySelector('dd.redirect')?.previousElementSibling?.textContent).toBe('Redirects to');
    expect(screen.queryByRole('button', { name: 'https://elsewhere.test/x' })).toBeNull();
  });

  it('shows where it points, without a link, where it can’t show another request (Compose)', async () => {
    render(
      pane({
        summary: redirect,
        send: vi.fn(async () => withLocation('/new')),
        followingRequest: () => next,
      }),
    );
    await act(async () => undefined);
    expect(document.querySelector('dd.redirect')?.textContent).toBe('https://api.test/new');
    expect(document.querySelector('dd.redirect')?.previousElementSibling?.textContent).toBe('Redirects to');
    expect(screen.queryByRole('button', { name: 'https://api.test/new' })).toBeNull();
  });

  it('says nothing for a response that isn’t a redirect, even with a Location', async () => {
    const created = summary('made', { status: 201 });
    render(
      pane({
        summary: created,
        send: vi.fn(async () => ({ ...detail(created, 'x'), responseHeaders: [['Location', '/items/7']] })),
        followingRequest: () => next,
        onSelectExchange: vi.fn(),
      }),
    );
    await act(async () => undefined);
    expect(screen.queryByText('Redirects to')).toBeNull();
  });
});
