/** Decoding form bodies, for the Fields view and HAR's postData.params (src/shared/form-fields.ts). */
import { describe, expect, it } from 'vitest';
import { fieldsText, formFields, type FormField } from '../src/shared/form-fields';

/** The fields as [name, value] pairs. */
const pairs = (fields: FormField[]) => fields.map(({ name, value }) => [name, value]);

describe('formFields', () => {
  it('decodes names and values as a browser encodes them', () => {
    const fields = formFields(
      'name=Ada+Lovelace&email=ada%40example.com&note=1%2B1%3D2&city=S%C3%A3o%20Paulo',
    );
    expect(fields).toEqual([
      { name: 'name', value: 'Ada Lovelace' },
      { name: 'email', value: 'ada@example.com' },
      { name: 'note', value: '1+1=2' },
      { name: 'city', value: 'São Paulo' },
    ]);
  });

  it('keeps a textarea’s line breaks and spacing', () => {
    expect(pairs(formFields('message=Line+one%0D%0A++indented%0D%0A'))).toEqual([
      ['message', 'Line one\r\n  indented\r\n'],
    ]);
  });

  it('keeps repeats in order, a value with "=" whole, and a field with no "=" as empty', () => {
    expect(pairs(formFields('tag=a&tag=b&token=x=y=z&remember&tag=c'))).toEqual([
      ['tag', 'a'],
      ['tag', 'b'],
      ['token', 'x=y=z'],
      ['remember', ''],
      ['tag', 'c'],
    ]);
  });

  it('keeps a leading "?" as part of the first name, and an empty name or value', () => {
    expect(pairs(formFields('?q=1&=orphan&blank='))).toEqual([
      ['?q', '1'],
      ['', 'orphan'],
      ['blank', ''],
    ]);
  });

  it('skips empty pieces, and has no fields for an empty body', () => {
    expect(pairs(formFields('&&a=1&&'))).toEqual([['a', '1']]);
    expect(formFields('')).toEqual([]);
    expect(formFields('&')).toEqual([]);
  });

  it('leaves an escape that isn’t one as it was written, decoding the rest of the field', () => {
    // Not marked as written: those fields decode fine around the stray "%".
    expect(formFields('a=100%&b=%zz&c=50%25+off&d=%4&e=100%+%C3%A9')).toEqual([
      { name: 'a', value: '100%' },
      { name: 'b', value: '%zz' },
      { name: 'c', value: '50% off' },
      { name: 'd', value: '%4' },
      { name: 'e', value: '100% é' },
    ]);
  });

  it('keeps a field whose escapes aren’t UTF-8 as written, and marks it, not "�"', () => {
    // A page in windows-1252 sends "café=été" this way.
    expect(formFields('caf%E9=%E9t%E9&ok=yes&n=%C3')).toEqual([
      { name: 'caf%E9', value: '%E9t%E9', asWritten: true },
      { name: 'ok', value: 'yes' },
      { name: 'n', value: '%C3', asWritten: true },
    ]);
  });
});

describe('fieldsText', () => {
  it('puts one field on each line, as name: value', () => {
    expect(
      fieldsText([
        { name: 'name', value: 'Ada Lovelace' },
        { name: 'remember', value: '' },
      ]),
    ).toBe('name: Ada Lovelace\nremember: ');
    expect(fieldsText([])).toBe('');
  });
});
