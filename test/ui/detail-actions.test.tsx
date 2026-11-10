/**
 * The details pane's actions and body notes (src/renderer/src/DetailPane.tsx): Copy URL, Copy
 * as curl, saving a body, and what it says about bodies cut short or that couldn't load.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BodyContent, BodyInfo, ExchangeDetail } from '../../src/shared/api';
import type { WirescryBridge } from '../../src/shared/ipc';
import { DetailPane } from '../../src/renderer/src/DetailPane';
import { detail, summary } from './fixtures';

const s = summary('a', { url: 'https://api.test/items?page=2', path: '/items', method: 'POST' });
const text = (value: string): BodyContent => ({
  base64: Buffer.from(value).toString('base64'),
  size: value.length,
  truncated: false,
});

/** A backend with this exchange, whose bodies are these (or fail with this message). */
function backend(
  options: {
    requestBody?: BodyInfo;
    responseBody?: BodyInfo;
    bodies?: Partial<Record<'request' | 'response', BodyContent | Error>>;
    headers?: Array<[string, string]>;
  } = {},
) {
  const d: ExchangeDetail = {
    ...detail(s, 'm'),
    ...(options.headers ? { requestHeaders: options.headers } : {}),
    ...(options.requestBody ? { requestBody: options.requestBody } : {}),
    ...(options.responseBody ? { responseBody: options.responseBody } : {}),
  };
  return vi.fn(async (command: { command: string; side?: 'request' | 'response' }) => {
    if (command.command === 'getExchange') return d;
    if (command.command === 'getBody') {
      const body = options.bodies?.[command.side!];
      if (body instanceof Error) throw body;
      return body ?? null;
    }
    return { ok: false, reason: 'not needed here' };
  });
}
const show = async (send: ReturnType<typeof backend>, stale = false) => {
  render(
    <DetailPane summary={s} send={send as never} onClose={() => undefined} actions={[]} stale={stale} />,
  );
  await act(async () => undefined);
  await act(async () => undefined);
};

let clipboard: ReturnType<typeof vi.fn>;
let saveBody: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
  saveBody = vi.fn(async () => ({}));
  window.wirescry = { saveBody } as unknown as WirescryBridge;
});
afterEach(() => vi.useRealTimers());

describe('Copy URL and Copy as curl', () => {
  it('copies the URL and says so for a moment', async () => {
    await show(backend());
    vi.useFakeTimers();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy URL' })));
    expect(clipboard).toHaveBeenCalledWith('https://api.test/items?page=2');
    expect(screen.getByText('Copied URL')).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(screen.queryByText('Copied URL')).toBeNull();
  });

  it('copies a curl command with the request body', async () => {
    await show(backend({ requestBody: { size: 7, stored: 7 }, bodies: { request: text('{"a":1}') } }));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy as curl' })));
    const command = clipboard.mock.calls[0]![0] as string;
    expect(command).toMatch(/^curl /);
    expect(command).toContain(`--data-raw '{"a":1}'`);
    expect(screen.getByText('Copied curl')).toBeTruthy();
  });

  it('says when the copy failed', async () => {
    await show(backend());
    clipboard.mockRejectedValueOnce(new Error('denied'));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy URL' })));
    expect(screen.getByText('Copy failed')).toBeTruthy();
    expect(screen.queryByText(/^Copied/)).toBeNull();
  });

  it('can’t copy as curl until the details have loaded', () => {
    render(
      <DetailPane
        summary={s}
        send={(() => new Promise(() => undefined)) as never}
        onClose={() => undefined}
        actions={[]}
        stale={false}
      />,
    );
    expect((screen.getByRole('button', { name: 'Copy as curl' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no curl for a WebSocket connection', async () => {
    render(
      <DetailPane
        summary={{ ...s, websocket: true, messageCount: 0 }}
        send={backend() as never}
        onClose={() => undefined}
        actions={[]}
        stale={false}
      />,
    );
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'Copy as curl' })).toBeNull();
  });
});

describe('a body’s notes', () => {
  it('says when the connection closed before the whole body arrived', async () => {
    await show(
      backend({
        responseBody: { size: 5, stored: 5, incomplete: true },
        bodies: { response: text('hello') },
      }),
    );
    expect(screen.getByText('The connection closed before the whole body arrived.')).toBeTruthy();
  });

  it('says how much of a large body Wirescry kept', async () => {
    await show(
      backend({
        responseBody: { size: 3 * 1024 * 1024, stored: 1024 * 1024 },
        bodies: { response: text('x') },
      }),
    );
    expect(screen.getByText('Wirescry kept the first 1.0 MB of this 3.0 MB body.')).toBeTruthy();
  });

  it('says nothing extra about a whole body', async () => {
    await show(backend({ responseBody: { size: 5, stored: 5 }, bodies: { response: text('hello') } }));
    expect(screen.queryByText(/kept the first/)).toBeNull();
    expect(screen.queryByText(/closed before/)).toBeNull();
  });

  it('says why a body couldn’t be loaded', async () => {
    await show(
      backend({
        responseBody: { size: 5, stored: 5 },
        bodies: { response: new Error('That body is gone.') },
      }),
    );
    expect(screen.getByText('That body is gone.')).toBeTruthy();
  });

  it('says No body when there’s none to show', async () => {
    await show(backend({ responseBody: { size: 5, stored: 5 }, bodies: {} }));
    expect(screen.getByText('No body')).toBeTruthy();
  });
});

describe('saving a body', () => {
  const save = async () => {
    await act(async () => void fireEvent.click(screen.getAllByRole('button', { name: 'Save…' }).at(-1)!));
  };

  it('asks for a file named for the URL and type, and says what was saved', async () => {
    await show(backend({ responseBody: { size: 5, stored: 5 }, bodies: { response: text('hello') } }));
    saveBody.mockResolvedValueOnce({ name: 'items.json', size: 2048 });
    await save();
    expect(saveBody).toHaveBeenCalledWith({
      exchangeId: 'a',
      side: 'response',
      name: expect.stringMatching(/^items/),
    });
    expect(screen.getByText('Saved items.json (2.0 KB)')).toBeTruthy();
  });

  it('says when it saved the body as stored, and why', async () => {
    await show(backend({ responseBody: { size: 5, stored: 5 }, bodies: { response: text('hello') } }));
    saveBody.mockResolvedValueOnce({ name: 'items.bin', size: 5, decodeError: 'the gzip data is damaged' });
    await save();
    expect(screen.getByText('Saved items.bin as stored: the gzip data is damaged')).toBeTruthy();
  });

  it('says nothing when the save is canceled', async () => {
    await show(backend({ responseBody: { size: 5, stored: 5 }, bodies: { response: text('hello') } }));
    await save();
    expect(screen.queryByText(/^Saved /)).toBeNull();
  });

  it('saves the request body too', async () => {
    await show(
      backend({
        requestBody: { size: 7, stored: 7 },
        bodies: { request: text('a,b') },
        // The response is JSON (the fixture's); the request's own type names its file.
        headers: [['Content-Type', 'text/csv']],
      }),
    );
    await act(async () => void fireEvent.click(screen.getAllByRole('button', { name: 'Save…' })[0]!));
    expect(saveBody).toHaveBeenCalledWith({
      exchangeId: 'a',
      side: 'request',
      name: expect.stringMatching(/\.csv$/),
    });
  });
});
