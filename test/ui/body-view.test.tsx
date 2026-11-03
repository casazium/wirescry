import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BodyView } from '../../src/renderer/src/BodyView';
import type { BodyContent } from '../../src/shared/api';

const content = (text: string, contentType: string, extra: Partial<BodyContent> = {}): BodyContent => ({
  base64: Buffer.from(text).toString('base64'),
  size: text.length,
  contentType,
  truncated: false,
  ...extra,
});
const noFormat = async () => ({ ok: false as const, reason: 'not needed' });
let copied: string | undefined;

beforeEach(() => {
  copied = undefined;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void (copied = text) },
  });
});

describe('BodyView', () => {
  it('copies what’s shown: formatted JSON, the raw text, or the hex dump', async () => {
    render(<BodyView content={content('{"a":1}', 'application/json')} format={noFormat} />);
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(copied).toBe('{\n  "a": 1\n}');
    fireEvent.click(screen.getByText('Text'));
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(copied).toBe('{"a":1}');
    fireEvent.click(screen.getByText('Hex'));
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(copied).toMatch(/^00000000/);
    expect(screen.getByText('Hex').getAttribute('aria-pressed')).toBe('true');
  });

  it('copies the formatted code the backend made', async () => {
    const format = vi.fn(async () => ({
      ok: true as const,
      language: 'html' as const,
      text: '<p>\n  x\n</p>',
    }));
    render(<BodyView content={content('<p>x</p>', 'text/html')} format={format} />);
    await act(async () => undefined);
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(copied).toBe('<p>\n  x\n</p>');
  });

  it('says when it copied only the part Wirescry holds', async () => {
    render(<BodyView content={content('abc', 'text/plain', { truncated: true })} format={noFormat} />);
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(screen.getByRole('status').textContent).toMatch(/Copied the first/);
  });

  it('offers Save only when it can save, and reports the result', async () => {
    const view = render(<BodyView content={content('x', 'text/plain')} format={noFormat} />);
    expect(screen.queryByText('Save…')).toBeNull();
    view.unmount();
    const onSave = vi.fn(async () => 'Saved x.txt (1 B)');
    render(<BodyView content={content('x', 'text/plain')} format={noFormat} onSave={onSave} />);
    await act(async () => fireEvent.click(screen.getByText('Save…')));
    expect(screen.getByRole('status').textContent).toBe('Saved x.txt (1 B)');
  });
});
