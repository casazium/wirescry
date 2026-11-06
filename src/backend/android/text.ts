/** Text from a device or the ADB server: untrusted, so cleaned before it's shown. */

const MAX_LABEL = 100;

/** Device-supplied text made safe to show: printable, single-line, capped. */
export function cleanText(text: string | undefined, max = MAX_LABEL): string | undefined {
  const cleaned = text
    ?.replace(/[\t\n\r\f\v]/g, ' ')
    // eslint-disable-next-line no-control-regex -- control, zero-width and bidi characters, removed on purpose
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? [...cleaned].slice(0, max).join('') : undefined;
}
