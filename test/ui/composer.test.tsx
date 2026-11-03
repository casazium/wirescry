import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerView } from '../../src/renderer/src/ComposerView';
import {
  draftFromExchange,
  draftToRequest,
  EMPTY_DRAFT,
  parseHeaders,
  requestToDraft,
  type ComposerDraft,
} from '../../src/renderer/src/composer-request';
import type { BodyContent, ComposerRequest, ExchangeDetail } from '../../src/shared/api';
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
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('reports edits', () => {
    const { onChange } = renderComposer(EMPTY_DRAFT);
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://b.example/' } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_DRAFT, url: 'https://b.example/' });
  });
});

describe('ComposerView shortcuts', () => {
  it('sends on Cmd/Ctrl+Enter from the body', () => {
    const { onSend } = renderComposer({ ...EMPTY_DRAFT, url: 'https://a.example/' });
    fireEvent.keyDown(screen.getByLabelText('Body'), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
