/**
 * Characters a model reads but a person doesn't see, written as visible escapes: for text sent to
 * AI agents, where captured traffic could hide instructions in them (Unicode tag characters,
 * bidi overrides, zero-width spaces, variation selectors used to carry bytes, line separators).
 */

/**
 * Hidden or unsafe to show raw: controls, format characters, surrogates, private use, unassigned
 * (so a character newer than this runtime's Unicode tables fails safe), noncharacters, line and
 * paragraph separators, and everything Unicode says renderers show as nothing. Tab and newline
 * are kept: plain text uses them, and JSON never holds them raw.
 */
export const INVISIBLE = /(?![\t\n])[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'gu');

/** One UTF-16 unit as JSON's escape, lowercase as `JSON.stringify` writes it. */
const escapeUnit = (unit: number): string => `\\u${unit.toString(16).padStart(4, '0')}`;

/**
 * `text` with each INVISIBLE character written as `\uXXXX` (past U+FFFF, its two surrogates).
 *
 * For the output of `JSON.stringify` without indentation, this is lossless: everything outside a
 * string is `{}[]:,`, a digit, `-+.eE` or a letter of `true`, `false` or `null`, none of which is
 * INVISIBLE; and inside a string a backslash is only ever followed by an ASCII character, so
 * a replaced character never falls inside an escape. `JSON.parse` gives back the same value, so
 * an agent that parses it gets the characters back; one reading it sees the escapes. In plain
 * text it isn't lossless: a literal `\u202e` and an escaped U+202E look alike.
 */
export function visible(text: string): string {
  return text.replace(INVISIBLE_ALL, (char) => {
    let out = escapeUnit(char.charCodeAt(0));
    if (char.length === 2) out += escapeUnit(char.charCodeAt(1));
    return out;
  });
}
