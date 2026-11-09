import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  describe('a form body', () => {
    const FORM = 'name=Ada+Lovelace&email=ada%40example.com&tag=a&tag=b&remember';
    /** The rows of the Fields table, as [name, value]. */
    const rows = () =>
      [...document.querySelectorAll('.form-fields tr')].map((row) => [
        row.querySelector('th')?.textContent,
        row.querySelector('td')?.textContent,
      ]);

    it('shows its fields first, decoded, and copies them one per line', async () => {
      render(<BodyView content={content(FORM, 'application/x-www-form-urlencoded')} format={noFormat} />);
      expect(screen.getByText('Fields').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual([
        'Text',
        'Hex',
      ]);
      expect(rows()).toEqual([
        ['name', 'Ada Lovelace'],
        ['email', 'ada@example.com'],
        ['tag', 'a'],
        ['tag', 'b'],
        ['remember', ''],
      ]);
      await act(async () => fireEvent.click(screen.getByText('Copy')));
      expect(copied).toBe('name: Ada Lovelace\nemail: ada@example.com\ntag: a\ntag: b\nremember: ');
      // The body as sent is one click away, and copies as sent.
      fireEvent.click(screen.getByText('Text'));
      expect(document.querySelector('pre.code')?.textContent).toBe(FORM);
      expect(rows()).toEqual([]);
      await act(async () => fireEvent.click(screen.getByText('Copy')));
      expect(copied).toBe(FORM);
    });

    it('is recognized with a charset, in any case', () => {
      render(
        <BodyView
          content={content('a=1', 'Application/X-WWW-Form-URLEncoded; charset=UTF-8')}
          format={noFormat}
        />,
      );
      expect(screen.getByText('Fields').getAttribute('aria-pressed')).toBe('true');
      expect(rows()).toEqual([['a', '1']]);
    });

    it('says when there are no fields', () => {
      render(<BodyView content={content('&', 'application/x-www-form-urlencoded')} format={noFormat} />);
      expect(screen.getByText('No fields.')).toBeTruthy();
      expect(rows()).toEqual([]);
    });

    it('still shows the fields of a body it holds only the first part of', () => {
      render(
        <BodyView
          content={content('a=1&b=12', 'application/x-www-form-urlencoded', {
            truncated: true,
            size: 100_000,
          })}
          format={noFormat}
        />,
      );
      expect(screen.getByText(/^Showing the first/)).toBeTruthy();
      expect(rows()).toEqual([
        ['a', '1'],
        ['b', '12'],
      ]);
    });

    it('keeps a value’s line breaks and spacing', () => {
      render(
        <BodyView
          content={content('message=one%0Atwo++three', 'application/x-www-form-urlencoded')}
          format={noFormat}
        />,
      );
      const cell = document.querySelector('.form-fields td')!;
      expect(cell.textContent).toBe('one\ntwo  three');
      // With the app's stylesheet, as it applies in the window: the headers table it reuses sets
      // white-space too, and a less specific rule lost to it.
      const style = document.createElement('style');
      style.textContent = readFileSync(
        path.join(import.meta.dirname, '../../src/renderer/src/styles.css'),
        'utf8',
      );
      document.head.append(style);
      try {
        expect(getComputedStyle(cell).whiteSpace).toBe('pre-wrap');
        // A header value elsewhere still wraps as before.
        const headers = document.createElement('table');
        headers.className = 'headers';
        headers.innerHTML = '<tbody><tr><th>a</th><td>b</td></tr></tbody>';
        document.body.append(headers);
        expect(getComputedStyle(headers.querySelector('td')!).whiteSpace).toBe('normal');
        headers.remove();
      } finally {
        style.remove();
      }
    });

    it('shows up to 1,000 rows, and says how many more there are, but copies them all', async () => {
      const many = Array.from({ length: 1_502 }, (_, i) => `f${i}=${i}`).join('&');
      render(<BodyView content={content(many, 'application/x-www-form-urlencoded')} format={noFormat} />);
      expect(rows()).toHaveLength(1_000);
      expect(rows().at(-1)).toEqual(['f999', '999']);
      expect(screen.getByText('And 502 more fields. Copy copies them all.')).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByText('Copy')));
      expect(copied!.split('\n')).toHaveLength(1_502);
      expect(copied!.endsWith('f1501: 1501')).toBe(true);
    });

    it('shows exactly 1,000 rows with no note, and says “field” for one more', () => {
      const form = (n: number) => Array.from({ length: n }, (_, i) => `f${i}=${i}`).join('&');
      const view = render(
        <BodyView content={content(form(1_000), 'application/x-www-form-urlencoded')} format={noFormat} />,
      );
      expect(rows()).toHaveLength(1_000);
      expect(screen.queryByText(/^And \d/)).toBeNull();
      view.unmount();
      render(
        <BodyView content={content(form(1_001), 'application/x-www-form-urlencoded')} format={noFormat} />,
      );
      expect(screen.getByText('And 1 more field. Copy copies them all.')).toBeTruthy();
    });

    it('says when some fields aren’t UTF-8, and shows those as written', () => {
      render(
        <BodyView
          content={content('caf%E9=%E9t%E9&ok=yes', 'application/x-www-form-urlencoded')}
          format={noFormat}
        />,
      );
      expect(screen.getByText("Some fields aren't UTF-8, so they're shown as written.")).toBeTruthy();
      expect(rows()).toEqual([
        ['caf%E9', '%E9t%E9'],
        ['ok', 'yes'],
      ]);
    });

    it('doesn’t say so when every field is UTF-8', () => {
      render(<BodyView content={content('ok=yes', 'application/x-www-form-urlencoded')} format={noFormat} />);
      expect(screen.queryByText(/UTF-8/)).toBeNull();
    });

    it('shows JSON or XML labeled as a form as what it is, not as one mangled field', () => {
      const view = render(
        <BodyView
          content={content('{"user":"a+b","n":"50%"}', 'application/x-www-form-urlencoded')}
          format={noFormat}
        />,
      );
      expect(screen.queryByText('Fields')).toBeNull();
      expect(document.querySelector('pre.code')?.textContent).toBe('{\n  "user": "a+b",\n  "n": "50%"\n}');
      view.unmount();
      render(
        <BodyView content={content('  <a>x+y</a>', 'application/x-www-form-urlencoded')} format={noFormat} />,
      );
      expect(screen.queryByText('Fields')).toBeNull();
      expect(document.querySelector('pre.code')?.textContent).toBe('  <a>x+y</a>');
    });
  });

  it('has no Fields view for other bodies, or for a form body that isn’t text', () => {
    const view = render(<BodyView content={content('a=1&b=2', 'text/plain')} format={noFormat} />);
    expect(screen.queryByText('Fields')).toBeNull();
    expect(screen.getByText('Text').getAttribute('aria-pressed')).toBe('true');
    view.unmount();
    render(
      <BodyView
        content={{
          base64: Buffer.from([0xff, 0xfe, 0x00, 0x80]).toString('base64'),
          size: 4,
          contentType: 'application/x-www-form-urlencoded',
          truncated: false,
        }}
        format={noFormat}
      />,
    );
    expect(screen.queryByText('Fields')).toBeNull();
    // Not text, so only its hex dump.
    expect(document.querySelector('pre.code.hex')?.textContent).toMatch(/^00000000 /);
  });
});
