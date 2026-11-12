import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerView } from '../../src/renderer/src/ComposerView';
import { PluginErrorBoundary } from '../../src/renderer/src/PluginView';
import {
  canCancel,
  checkSendSize,
  forSending,
  runBeforeSend,
  sameDraft,
  draftFromExchange,
  draftToRequest,
  EMPTY_DRAFT,
  parseHeaders,
  requestToDraft,
  type ComposerDraft,
} from '../../src/renderer/src/composer-request';
import type { BodyContent, ComposerRequest, ExchangeDetail } from '../../src/shared/api';
import type { UiComposerExtension, UiPluginApi } from '../../src/plugin-api/ui';
import { summary } from './fixtures';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const body = (text: string, extra: Partial<BodyContent> = {}): BodyContent => ({
  base64: b64(text),
  size: text.length,
  truncated: false,
  ...extra,
});

describe('composer drafts', () => {
  it('parses headers, and names the line that has no colon', () => {
    expect(parseHeaders('Accept: */*\n\nX-Empty:\nX-Url: http://a/b')).toEqual({
      headers: [
        ['Accept', '*/*'],
        ['X-Empty', ''],
        ['X-Url', 'http://a/b'],
      ],
    });
    expect(parseHeaders('Accept: */*\nbroken')).toEqual({
      error: 'Header line 2 needs a colon, as in Name: value.',
    });
  });

  it('round-trips through a request for plugins', () => {
    const request: ComposerRequest = {
      method: 'POST',
      url: 'https://a.example/',
      headers: [['A', '1']],
      body: 'x',
    };
    expect(draftToRequest(requestToDraft(request))).toEqual(request);
  });

  it('copies a captured request without the headers Wirescry sets, and decoded', () => {
    const detail = {
      summary: summary('1'),
      requestHeaders: [
        [':method', 'POST'],
        ['host', 'api.example'],
        ['content-length', '12'],
        ['content-encoding', 'gzip'],
        ['content-type', 'application/json'],
      ],
      requestBody: { size: 12, stored: 12 },
    } as unknown as ExchangeDetail;
    const { draft, note } = draftFromExchange(
      summary('1', { method: 'POST', url: 'https://api.example/items' }),
      detail,
      body('{"a":1}', { decodedSize: 7 }),
    );
    expect(note).toBeUndefined();
    expect(draft).toEqual({
      method: 'POST',
      url: 'https://api.example/items',
      headersText: 'content-type: application/json',
      body: '{"a":1}',
    });
  });

  it.each([
    [body('', { base64: Buffer.from([0xff, 0x00, 0x01]).toString('base64') }), 'isn’t text'],
    [body('abc', { truncated: true }), 'too large'],
    [null, 'no longer stored'],
  ])('leaves out a body it can’t copy, and says why', (content, message) => {
    const detail = { requestHeaders: [], requestBody: { size: 3, stored: 3 } } as unknown as ExchangeDetail;
    const { draft, note } = draftFromExchange(summary('1'), detail, content);
    expect(draft.body).toBe('');
    expect(note).toContain(message);
  });
});

function renderComposer(draft: ComposerDraft, onSend = vi.fn(async () => undefined)) {
  const onChange = vi.fn();
  render(
    <ComposerView
      draft={draft}
      onChange={onChange}
      onDismissNote={() => {}}
      connected
      onSend={onSend}
      panels={[]}
    />,
  );
  return { onSend, onChange };
}

describe('ComposerView', () => {
  it('sends the parsed request', async () => {
    const { onSend } = renderComposer({
      method: 'post',
      url: ' https://api.example/items ',
      headersText: 'Content-Type: application/json',
      body: '{}',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.example/items',
      headers: [['Content-Type', 'application/json']],
      body: '{}',
    });
  });

  it.each([
    [{ url: 'api.example/items' }, 'Enter a full URL'],
    [{ url: 'https://a.example/', headersText: 'nope' }, 'needs a colon'],
  ])('refuses %j before sending', async (change, message) => {
    const { onSend } = renderComposer({ ...EMPTY_DRAFT, ...change });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows why a send failed, and can send again', async () => {
    const onSend = vi.fn(async () => Promise.reject(new Error('No value for {{token}}')));
    renderComposer({ ...EMPTY_DRAFT, url: 'https://a.example/' }, onSend);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No value for {{token}}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBeNull(),
    );
  });

  it('reports edits', () => {
    const { onChange } = renderComposer(EMPTY_DRAFT);
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://b.example/' } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_DRAFT, url: 'https://b.example/' });
  });
});

describe('ComposerView labels', () => {
  it('names the headers and body fields by their labels alone, whatever they hold', () => {
    renderComposer({ ...EMPTY_DRAFT, headersText: 'Accept: */*', body: '{"name": "doggie"}' });
    expect(screen.getByRole('textbox', { name: 'Headers' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Body' })).toBeTruthy();
  });
});

describe('ComposerView shortcuts', () => {
  it('sends on Cmd/Ctrl+Enter from the body', () => {
    const { onSend } = renderComposer({ ...EMPTY_DRAFT, url: 'https://a.example/' });
    fireEvent.keyDown(screen.getByLabelText('Body'), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

const base: ComposerRequest = { method: 'GET', url: 'https://a.example/', headers: [], body: '' };
const apiFor = (plugin: string) => ({ plugin }) as unknown as UiPluginApi;

describe('runBeforeSend', () => {
  it('runs plugins in order, each getting the last one’s result, and skips ones without the hook', async () => {
    const seen: string[] = [];
    const extensions: Array<{ plugin: string; extension: UiComposerExtension }> = [
      {
        plugin: 'one',
        extension: {
          beforeSend: (r, api) => {
            seen.push(`one:${(api as unknown as { plugin: string }).plugin}:${r.url}`);
            return { ...r, url: `${r.url}one` };
          },
        },
      },
      { plugin: 'none', extension: {} },
      {
        plugin: 'two',
        extension: {
          beforeSend: async (r) => {
            seen.push(`two:${r.url}`);
            return { ...r, headers: [['X-Two', '2']] };
          },
        },
      },
    ];
    expect(await runBeforeSend(extensions, base, apiFor)).toEqual({
      ...base,
      url: 'https://a.example/one',
      headers: [['X-Two', '2']],
    });
    expect(seen).toEqual(['one:one:https://a.example/', 'two:https://a.example/one']);
  });

  it('passes the request through unchanged with no plugins', async () => {
    expect(await runBeforeSend([], base, apiFor)).toBe(base);
  });

  it.each([
    [new Error('No value for {{token}}'), 'No value for {{token}}'],
    ['plain string', "It couldn't be sent: plain string"],
    [null, "It couldn't be sent: null"],
  ])('turns a thrown %j into a message, and stops', async (thrown, message) => {
    const later = vi.fn((r: ComposerRequest) => r);
    await expect(
      runBeforeSend(
        [
          {
            plugin: 'bad',
            extension: {
              beforeSend: () => {
                throw thrown;
              },
            },
          },
          { plugin: 'later', extension: { beforeSend: later } },
        ],
        base,
        apiFor,
      ),
    ).rejects.toThrow(message);
    expect(later).not.toHaveBeenCalled();
  });

  it('stops when a plugin returns no request', async () => {
    await expect(
      runBeforeSend(
        [{ plugin: 'bad', extension: { beforeSend: () => undefined as unknown as ComposerRequest } }],
        base,
        apiFor,
      ),
    ).rejects.toThrow('returned no request');
  });
});

describe('canCancel', () => {
  const pending = summary('s1', { status: undefined, durationMs: undefined, responseSize: undefined });
  it('allows cancel until the response has fully arrived', () => {
    expect(canCancel(pending, false, new Set())).toBe(true);
    // Headers are in, the body is still streaming.
    expect(canCancel({ ...pending, status: 200 }, false, new Set())).toBe(true);
  });
  it.each([
    ['nothing sent', undefined, false, new Set<string>()],
    ['finished', { ...pending, status: 200, durationMs: 5 }, false, new Set<string>()],
    ['failed', { ...pending, failure: { kind: 'client-closed' } }, false, new Set<string>()],
    ['from before a restart', pending, true, new Set<string>()],
    ['no longer cancellable', pending, false, new Set(['s1'])],
  ])('doesn’t when %s', (_name, s, stale, gone) => {
    expect(canCancel(s as never, stale, gone)).toBe(false);
  });
});

describe('send size and draft comparison', () => {
  it('refuses a request whose JSON is too large, even if the body is under 512 KB', () => {
    expect(() => checkSendSize({ ...base, body: 'x'.repeat(400 * 1024) })).not.toThrow();
    // Quotes double when escaped as JSON.
    expect(() => checkSendSize({ ...base, body: '"'.repeat(500 * 1024) })).toThrow('too large to send');
  });
  it('leaves out the text when a plugin gave the body as bytes', () => {
    const big = { ...base, body: 'x'.repeat(500 * 1024) };
    const bytes = { ...big, bodyBase64: Buffer.alloc(512 * 1024).toString('base64'), grpc: true };
    expect(() => checkSendSize(bytes)).toThrow('too large to send');
    expect(forSending(bytes)).toEqual({ ...bytes, body: '' });
    expect(() => checkSendSize(forSending(bytes))).not.toThrow();
    // Text alone is sent as it is.
    expect(forSending(big)).toBe(big);
  });
  it('compares every field', () => {
    expect(sameDraft(EMPTY_DRAFT, { ...EMPTY_DRAFT })).toBe(true);
    for (const field of ['method', 'url', 'headersText', 'body'] as const) {
      expect(sameDraft(EMPTY_DRAFT, { ...EMPTY_DRAFT, [field]: 'x' })).toBe(false);
    }
  });
});

describe('ComposerView states', () => {
  const ready = { ...EMPTY_DRAFT, url: 'https://a.example/' };
  const view = (props: Partial<React.ComponentProps<typeof ComposerView>>) => {
    const onSend = vi.fn(async () => undefined);
    render(
      <ComposerView
        draft={ready}
        onChange={() => {}}
        onDismissNote={() => {}}
        connected
        onSend={onSend}
        panels={[]}
        {...props}
      />,
    );
    return onSend;
  };

  it('shows Cancel instead of Send while a request is waiting, and ignores Cmd+Enter', () => {
    const onCancel = vi.fn();
    const onSend = view({ onCancel });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Body'), { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('can’t send while disconnected', () => {
    const onSend = view({ connected: false });
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(screen.getByLabelText('URL'), { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('ignores Enter without Cmd or Ctrl in the body', () => {
    const onSend = view({});
    fireEvent.keyDown(screen.getByLabelText('Body'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('refuses a body over 512 KB before sending', async () => {
    const onSend = view({ draft: { ...ready, body: 'x'.repeat(512 * 1024 + 1) } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('at most 512 KB');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows the note about what couldn’t be copied, with a way to dismiss it', () => {
    const onDismissNote = vi.fn();
    view({ note: 'The body isn’t text, so it was left out.', onDismissNote });
    expect(screen.getByText(/left out/).getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onDismissNote).toHaveBeenCalled();
  });

  it('shows the response it’s given, or a placeholder', () => {
    view({ response: <div>the detail pane</div> });
    expect(screen.getByText('the detail pane')).toBeTruthy();
    expect(screen.queryByText('The response shows here after you send.')).toBeNull();
  });

  it('keeps a crashing plugin panel from taking the composer down', () => {
    const Crash = (): React.JSX.Element => {
      throw new Error('panel broke');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    view({
      panels: [
        <PluginErrorBoundary key="p" label="Compose panel">
          <Crash />
        </PluginErrorBoundary>,
      ],
    });
    expect(screen.getByRole('alert').textContent).toContain('panel broke');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});
