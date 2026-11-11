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
    expect(protocolLine()).toBe('HTTP/2 (https://), between the client and Wirescry');
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
    expect(protocolLine()).toBe('HTTP/2 (https://)');
  });

  it('says the HTTP version, then the URL’s scheme, not the scheme twice', async () => {
    const plain = summary('h', { protocol: 'http', httpVersion: '1.1', url: 'http://api.test/h' });
    render(pane({ summary: plain, send: vi.fn(async () => detail(plain, 'm')) }));
    await act(async () => undefined);
    expect(protocolLine()).toBe('HTTP/1.1 (http://)');
  });

  it('says an imported request’s HTTP version is unknown when its file didn’t say', async () => {
    const imported = summary('i', { httpVersion: '', imported: true });
    render(pane({ summary: imported, send: vi.fn(async () => detail(imported, 'm')) }));
    await act(async () => undefined);
    expect(protocolLine()).toBe('HTTP version unknown (https://)');
  });

  it('doesn’t call an https:// URL sent in plain text encrypted (BusyBox wget’s)', async () => {
    const wget = summary('w', { protocol: 'https', httpVersion: '1.1', url: 'https://api.test/w' });
    render(pane({ summary: wget, send: vi.fn(async () => detail(wget, 'm')) }));
    await act(async () => undefined);
    expect(protocolLine()).toBe('HTTP/1.1 (https://)');
    expect(protocolLine()).not.toMatch(/encrypt/i);
  });
});

/** The Overview's Protocol value. */
const protocolLine = () =>
  [...document.querySelectorAll('.facts dt')].find((dt) => dt.textContent === 'Protocol')?.nextElementSibling
    ?.textContent;

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

  /** Shows an exchange with trailers on both sides (as a gRPC call has on the response). */
  const shownWithTrailers = async (props: Partial<Parameters<typeof DetailPane>[0]>) => {
    const s = summary('t');
    const withTrailers: ExchangeDetail = {
      ...detail(s, 'm'),
      requestBody: { size: 5, stored: 5 },
      responseBody: { size: 10, stored: 10 },
      requestTrailers: [['x-checksum', 'abc']],
      responseTrailers: [
        ['grpc-status', '5'],
        ['grpc-message', 'not found'],
      ],
    };
    const send = vi.fn((command: { command: string }) =>
      command.command === 'getExchange' ? Promise.resolve(withTrailers) : Promise.resolve(null),
    );
    await act(async () => {
      render(pane({ summary: s, send, ...props }));
    });
  };

  it('shows trailers after the body they follow, on each side', async () => {
    await shownWithTrailers({});
    const order = headings();
    const at = (name: string) => order.indexOf(name);
    expect(at('Request body')).toBeGreaterThan(at('Request headers'));
    expect(at('Request trailers')).toBe(at('Request body') + 1);
    expect(at('Response headers')).toBeGreaterThan(at('Request trailers'));
    expect(at('Response trailers')).toBe(at('Response body') + 1);
    expect(screen.getByText('grpc-status')).toBeTruthy();
    expect(screen.getByText('not found')).toBeTruthy();
    expect(screen.getByText('x-checksum')).toBeTruthy();
  });

  it('keeps response trailers last when the response comes first (as Compose does)', async () => {
    await shownWithTrailers({ responseFirst: true });
    const order = headings();
    const at = (name: string) => order.indexOf(name);
    expect(at('Response body')).toBe(1);
    expect(at('Response headers')).toBe(2);
    expect(at('Response trailers')).toBe(3);
  });

  it('shows no trailer sections when there were none', async () => {
    await shown({});
    expect(headings()).not.toContain('Response trailers');
    expect(headings()).not.toContain('Request trailers');
  });

  it("shows a gRPC call's status, code and message in the overview", async () => {
    await shown(
      {},
      summary('g', {
        grpc: true,
        grpcStatus: 5,
        grpcMessage: 'order 42 not found',
        contentType: 'application/grpc',
      }),
    );
    expect(screen.getByText('gRPC status')).toBeTruthy();
    expect(screen.getByText('NOT_FOUND (5): order 42 not found')).toBeTruthy();
  });

  /** Shows an exchange with these request headers and response trailers. */
  const shownWith = async (s: ReturnType<typeof summary>, extra: Partial<ExchangeDetail>) => {
    const full: ExchangeDetail = { ...detail(s, 'm'), ...extra };
    const send = vi.fn((command: { command: string }) =>
      command.command === 'getExchange' ? Promise.resolve(full) : Promise.resolve(null),
    );
    await act(async () => {
      render(pane({ summary: s, send }));
    });
  };

  it("shows a gRPC call's deadline, and its binary metadata decoded", async () => {
    await shownWith(summary('g', { grpc: true, grpcStatus: 5 }), {
      requestHeaders: [
        ['grpc-timeout', '1500m'],
        ['trace-bin', 'AQID'],
      ],
      responseTrailers: [
        ['grpc-status', '5'],
        ['grpc-status-details-bin', 'CAU'],
      ],
    });
    expect(screen.getByText('Deadline')).toBeTruthy();
    expect(screen.getByText('1.5 s')).toBeTruthy();
    // Labeled for screen readers, which would otherwise read the bytes straight after the base64.
    const decoded = [...document.querySelectorAll('.decoded')].map((e) => e.textContent);
    expect(decoded).toEqual(['Decoded: 01 02 03', 'Decoded: 08 05']);
  });

  it("decodes nothing, and shows no deadline, for a request that isn't gRPC", async () => {
    await shownWith(summary('r'), {
      requestHeaders: [
        ['grpc-timeout', '5S'],
        ['x-thing-bin', 'AQID'],
      ],
    });
    expect(screen.queryByText('Deadline')).toBeNull();
    expect(document.querySelector('.decoded')).toBeNull();
    expect(screen.getByText('AQID')).toBeTruthy();
  });

  it('shows a value that isn’t base64 as it is, and no deadline for a bad timeout', async () => {
    await shownWith(summary('g2', { grpc: true }), {
      requestHeaders: [
        ['grpc-timeout', 'soon'],
        ['trace-bin', 'not base64!'],
        // Padding atob refuses: must not break the pane.
        ['bad-padding-bin', 'QQ='],
      ],
    });
    expect(screen.queryByText('Deadline')).toBeNull();
    expect(screen.getByText('not base64!')).toBeTruthy();
    expect(screen.getByText('QQ=')).toBeTruthy();
    expect(document.querySelector('.decoded')).toBeNull();
  });

  it('shows a gRPC call its client canceled as canceled, not as a failure', async () => {
    await shown(
      {},
      summary('c', {
        grpc: true,
        contentType: 'application/grpc',
        failure: { ...describeFailure('CLIENT_CLOSED', 'api.test'), partial: true },
      }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Canceled by the client')).toBeTruthy();
    expect(
      screen.getByText(
        'The client canceled the call. The server had started responding; below is what arrived before then.',
      ),
    ).toBeTruthy();
  });

  it('shows a gRPC call whose deadline passed as a failure, saying so', async () => {
    await shown(
      {},
      summary('d', {
        grpc: true,
        grpcDeadlineExceeded: true,
        failure: { ...describeFailure('CLIENT_CLOSED', 'api.test'), message: 'The client gave up at 5 s.' },
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('The client gave up at 5 s.');
    expect(screen.getByText('Deadline passed')).toBeTruthy();
    expect(screen.queryByText('Canceled by the client')).toBeNull();
  });

  it('still shows another request the client closed as a failure', async () => {
    await shown({}, summary('p', { failure: describeFailure('CLIENT_CLOSED', 'api.test') }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Failed (CLIENT_CLOSED)')).toBeTruthy();
    expect(screen.queryByText('Canceled by the client')).toBeNull();
  });

  it('shows no gRPC status for other requests, or before the call has one', async () => {
    await shown({});
    expect(screen.queryByText('gRPC status')).toBeNull();
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
