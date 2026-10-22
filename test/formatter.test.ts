import { afterEach, describe, expect, it } from 'vitest';
import { formatCode } from '../src/backend/format-worker.mjs';
import { Formatter, MAX_FORMAT_INPUT } from '../src/backend/formatter';

describe('formatCode', () => {
  it('formats minified JavaScript', () => {
    expect(formatCode('js', 'function a(b){if(b){return 1}return 2}')).toBe(
      'function a(b) {\n  if (b) {\n    return 1\n  }\n  return 2\n}',
    );
  });

  it('formats CSS', () => {
    expect(formatCode('css', 'a{color:red;margin:0}b{x:y}')).toBe(
      'a {\n  color: red;\n  margin: 0\n}\n\nb {\n  x: y\n}',
    );
  });

  it('formats HTML', () => {
    expect(formatCode('html', '<div><p>Hi</p><ul><li>a</li></ul></div>')).toBe(
      '<div>\n  <p>Hi</p>\n  <ul>\n    <li>a</li>\n  </ul>\n</div>',
    );
  });

  it('formats XML, keeping short text on one line', () => {
    expect(formatCode('xml', '<a><b>1</b><c/></a>')).toBe('<a>\n  <b>1</b>\n  <c/>\n</a>');
  });

  it("copes with JavaScript that isn't valid", () => {
    expect(() => formatCode('js', 'function (( {')).not.toThrow();
  });

  it('repairs slightly broken XML, and throws on text that is not XML at all', () => {
    expect(formatCode('xml', '<a><b></a>')).toBe('<a>\n  <b></b>\n</a>');
    expect(() => formatCode('xml', 'not xml at all')).toThrow('Failed to parse XML');
  });
});

describe('Formatter', () => {
  let formatter: Formatter | undefined;
  afterEach(async () => {
    await formatter?.close();
  });

  it('formats in a worker thread', async () => {
    formatter = new Formatter();
    expect(await formatter.format('js', 'a();b()')).toBe('a();\nb()');
    expect(await formatter.format('css', 'a{b:c}')).toBe('a {\n  b: c\n}');
  });

  it('reports errors from the worker', async () => {
    formatter = new Formatter();
    await expect(formatter.format('xml', 'not xml at all')).rejects.toThrow('Failed to parse XML');
  });

  it('refuses input over the size limit', async () => {
    formatter = new Formatter();
    await expect(formatter.format('js', 'x'.repeat(MAX_FORMAT_INPUT + 1))).rejects.toThrow('too large');
  });

  it('stops a job that takes too long, then works again', async () => {
    formatter = new Formatter(1);
    const slow = 'function f(){' + 'a=1;'.repeat(200_000) + '}';
    await expect(formatter.format('js', slow)).rejects.toThrow('took too long');
    (formatter as unknown as { timeoutMs: number }).timeoutMs = 10_000;
    expect(await formatter.format('js', 'a();b()')).toBe('a();\nb()');
  });
});
