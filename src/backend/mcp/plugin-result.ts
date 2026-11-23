/**
 * A plugin MCP tool's result, made safe to give an agent. The result is masked as one JSON body, by
 * the same rules as a captured one, so a value is judged by its key and its neighbors (`password`,
 * a `{ name: 'authorization', value }` pair). Each string also gets the text rules, and each key is
 * masked. Marked text (McpLeaf) is read as the plain string it is. Other marked values stand in that
 * body as placeholders and are masked by what they are: a header value by its name, a body by its
 * type. A placeholder the JSON rules hid sat under a secret's name, so that value is hidden whole.
 * Marking never weakens a value: a second JSON field holds the real values, so its rules see the same
 * names and pairs as an unmarked result and teach the same values. It's used only to hide: what it
 * changed is hidden, and its text is never given.
 */
import { randomInt } from 'node:crypto';
import { isPairNameKey } from '../../shared/redact-body';
import type { MaskField } from '../mask-body';

/** How deep a result may nest. */
export const MAX_DEPTH = 32;
/** How many values (strings, numbers, objects…) a result may hold. */
export const MAX_NODES = 20_000;
/** How many characters of strings a result may hold before masking. */
export const MAX_STRING_CHARS = 1_000_000;
/** The key that marks a value. Distinctive, as captured data often has a field called `mask`. */
export const LEAF_KEY = 'wirescryMask';

/** Why a result can't be given: said to the agent. */
export class ResultError extends Error {}

const BAD_LEAF = 'The result has a marked value Wirescry can’t read.';

const LEAF_FIELDS: Record<string, { required: readonly string[]; optional?: string }> = {
  header: { required: ['name', 'value'] },
  body: { required: ['text'], optional: 'contentType' },
  url: { required: ['value'] },
  text: { required: ['value'] },
};

/**
 * The fields of a marked value; undefined for an object that has no mark. One that has a mark but
 * isn't exactly a leaf is refused: read as an ordinary object, it would get weaker rules.
 */
function asLeaf(value: Record<string, unknown>): MaskField[] | undefined {
  if (!Object.hasOwn(value, LEAF_KEY)) return undefined;
  const kind = value[LEAF_KEY];
  if (typeof kind !== 'string' || !Object.hasOwn(LEAF_FIELDS, kind)) throw new ResultError(BAD_LEAF);
  const { required, optional } = LEAF_FIELDS[kind]!;
  // As JSON: a key whose value is undefined isn't there.
  const keys = Object.keys(value).filter((key) => key !== LEAF_KEY && value[key] !== undefined);
  const allowed = optional ? [...required, optional] : required;
  if (
    !required.every((key) => typeof value[key] === 'string') ||
    !keys.every((key) => allowed.includes(key) && typeof value[key] === 'string')
  ) {
    throw new ResultError(BAD_LEAF);
  }
  switch (kind) {
    case 'header':
      // The name is shown too: masked as a host is, for known values only.
      return [
        { kind: 'host', value: value.name as string },
        { kind: 'header', name: value.name as string, value: value.value as string },
      ];
    case 'body':
      return [
        {
          kind: 'body',
          contentType: (value.contentType as string | undefined) ?? 'text/plain',
          value: value.text as string,
        },
      ];
    case 'url':
      return [{ kind: 'url', value: value.value as string }];
    default:
      return [{ kind: 'text', value: value.value as string }];
  }
}

/** What the JSON rules put in place of a value they hid whole. */
const HIDDEN = '[redacted]';

/** An object as read back from masked JSON: masking can make two keys alike, so not a Map. */
class Pairs {
  constructor(readonly values: unknown[]) {}
}

/**
 * Masked JSON read back with every object's values in order, keys dropped (they're masked apart).
 * JSON.parse won't do: it merges keys masked alike, and moves keys that look like numbers.
 */
function readMasked(text: string): unknown {
  let at = 0;
  const STRING = /"(?:[^"\\]|\\.)*"/y;
  const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const fail = (): never => {
    throw new ResultError('Couldn’t check this for secrets. Try again.');
  };
  const token = (pattern: RegExp): string => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return fail();
    at = pattern.lastIndex;
    return match[0];
  };
  const value = (): unknown => {
    const char = text[at];
    if (char === '"') {
      const raw = token(STRING);
      try {
        return JSON.parse(raw) as string;
      } catch {
        return fail();
      }
    }
    if (char === '[' || char === '{') {
      const close = char === '[' ? ']' : '}';
      const items: unknown[] = [];
      at++;
      if (text[at] === close) at++;
      else {
        for (;;) {
          if (char === '{') {
            token(STRING);
            if (text[at++] !== ':') fail();
          }
          items.push(value());
          const next = text[at++];
          if (next === close) break;
          if (next !== ',') fail();
        }
      }
      return char === '[' ? items : new Pairs(items);
    }
    const raw = token(SCALAR);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fail();
    }
  };
  const result = value();
  if (at !== text.length) fail();
  return result;
}

/** Puts one value together from its nodes in the two masked JSONs and the other masked fields. */
type Built = (node: unknown, real: unknown, masked: readonly string[]) => unknown;

/** A value as it goes into each JSON, and how to rebuild it. */
interface Walked {
  json: unknown;
  real: unknown;
  build: Built;
}

/** A number in lowercase letters only: the rules never learn such a word as a known value. */
function letters(n: number): string {
  return [...n.toString(16)].map((digit) => 'abcdefghijklmnop'[parseInt(digit, 16)]).join('');
}

/**
 * Whether every piece `shown` keeps is also kept by `seen`, in order: so `shown` hides at least what
 * `seen` hides. Each piece is searched for with a prefix table (KMP) from where the last one ended,
 * so hostile text stays linear on the backend's main thread.
 */
export function keptWithin(shown: string, seen: string): boolean {
  const parts = seen.split(HIDDEN);
  let part = 0;
  let from = 0;
  for (const piece of shown.split(HIDDEN)) {
    if (piece === '') continue;
    const table = new Int32Array(piece.length);
    for (let i = 1, k = 0; i < piece.length; i++) {
      while (k > 0 && piece[i] !== piece[k]) k = table[k - 1]!;
      if (piece[i] === piece[k]) k++;
      table[i] = k;
    }
    let found = false;
    for (; part < parts.length && !found; part += found ? 0 : 1, from = found ? from : 0) {
      const text = parts[part]!;
      for (let i = from, k = 0; i < text.length; i++) {
        while (k > 0 && text[i] !== piece[k]) k = table[k - 1]!;
        if (text[i] === piece[k]) k++;
        if (k === piece.length) {
          from = i + 1;
          found = true;
          break;
        }
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * A marked value's masked text. `seen` is what the JSON rules made of its real text: its own kind's
 * text is given only if it hides at least as much, so a decoy its rules did find can't vouch for a
 * secret only the JSON rules found.
 */
function leafText(real: string, shown: string, seen: unknown): string {
  if (seen === real) return shown;
  if (typeof seen !== 'string' || shown === real) return HIDDEN;
  return keptWithin(shown, seen) ? shown : HIDDEN;
}

/**
 * The fields to mask, the first being the whole result as JSON, and how to build the masked result
 * from them. Throws ResultError for a result that isn't plain JSON or is too big, and `build` does
 * for masked JSON it can't read.
 */
export function collectResult(result: unknown): {
  fields: MaskField[];
  build: (masked: readonly string[]) => unknown;
} {
  // The first is filled in at the end.
  const fields: MaskField[] = [{ kind: 'text', value: '' }];
  let nodes = 0;
  let chars = 0;
  const add = (field: MaskField): number => {
    chars += field.value.length;
    if (field.kind === 'header') chars += field.name.length;
    if (field.kind === 'body') chars += field.contentType.length;
    if (chars > MAX_STRING_CHARS) throw new ResultError('The result is too large.');
    fields.push(field);
    return fields.length - 1;
  };
  const seen = new Set<object>();
  let placeholders = 0;
  let marked = false;
  // Not guessable, so a string in the result can't be the same as a placeholder.
  const salt = letters(randomInt(1e12));

  /** The value as it goes into the JSON, and how to build it from what comes back. */
  const walk = (value: unknown, depth: number, nameSlot = false): Walked => {
    if (++nodes > MAX_NODES) throw new ResultError('The result is too large.');
    if (depth > MAX_DEPTH) throw new ResultError('The result nests too deeply.');
    if (value === null || typeof value === 'boolean') return { json: value, real: value, build: () => value };
    if (typeof value === 'number') {
      // JSON has no NaN or Infinity.
      if (!Number.isFinite(value)) return { json: null, real: null, build: () => null };
      // A PIN or a code can be a number: hidden, it comes back as text.
      return {
        json: value,
        real: value,
        build: (node, real) => (typeof node === 'number' && typeof real === 'number' ? value : HIDDEN),
      };
    }
    if (typeof value === 'string') {
      const at = add({ kind: 'text', value });
      return {
        json: value,
        real: value,
        build: (node, real, m) => {
          if (typeof node !== 'string' || typeof real !== 'string') return HIDDEN;
          // Each pass may have found something: unless they agree, none has everything hidden.
          const found = [node, real, m[at]!].filter((text) => text !== value);
          if (found.length === 0) return value;
          return found.every((text) => text === found[0]) ? found[0] : HIDDEN;
        },
      };
    }
    if (typeof value !== 'object') throw new ResultError('The result isn’t plain JSON.');
    if (seen.has(value)) throw new ResultError('The result refers to itself.');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        // Before reading it: a sparse list can claim billions of items.
        if (nodes + value.length > MAX_NODES) throw new ResultError('The result is too large.');
        const items: Walked[] = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          // As JSON.stringify: undefined (or a hole) in a list is null.
          if (item === undefined) {
            nodes++;
            items.push({ json: null, real: null, build: () => null });
          } else items.push(walk(item, depth + 1, true));
        }
        return {
          json: items.map((item) => item.json),
          real: items.map((item) => item.real),
          build: (node, real, m) =>
            Array.isArray(node) &&
            node.length === items.length &&
            Array.isArray(real) &&
            real.length === items.length
              ? items.map((item, i) => item.build(node[i], real[i], m))
              : HIDDEN,
        };
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new ResultError('The result isn’t plain JSON.');
      const record = value as Record<string, unknown>;
      const leaf = asLeaf(record);
      if (leaf) {
        const first = leaf[0]!;
        if (first.kind === 'text') {
          // The same rules as a plain string, so read as one. This object's count covers it.
          nodes--;
          return walk(first.value, depth);
        }
        marked = true;
        const at = leaf.map(add);
        const main = leaf[leaf.length - 1]!;
        const text = main.value;
        // Each its own: a value learned under a secret's name mustn't hide the others.
        const placeholder = `wirescrymarkedvalue${salt}x${letters(placeholders++)}`;
        // A header's value is a value: where a pair's name could go, it goes in as the header it
        // is, so `vary: Cookie` can't pair with what's beside it. No such place is a secret's key.
        // Anywhere else it stays plain, so a secret's key teaches it.
        const isHeader = first.kind === 'host';
        const asObject = isHeader && nameSlot;
        return {
          json: placeholder,
          real: asObject ? { name: first.value, value: text } : text,
          build: (node, real, m) => {
            if (node !== placeholder) return HIDDEN;
            const seenText = asObject && real instanceof Pairs ? real.values[1] : real;
            const shown = leafText(text, m[at[at.length - 1]!]!, seenText);
            return isHeader ? { name: m[at[0]!], value: shown } : shown;
          },
        };
      }
      // As JSON.stringify: a key whose value is undefined is left out.
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .map((key) => ({
          key,
          keyAt: add({ kind: 'text', value: key }),
          ...walk(record[key], depth + 1, isPairNameKey(key)),
        }));
      // No prototype, so a key called __proto__ is kept like any other.
      const json = Object.create(null) as Record<string, unknown>;
      const real = Object.create(null) as Record<string, unknown>;
      for (const entry of entries) {
        json[entry.key] = entry.json;
        real[entry.key] = entry.real;
      }
      return {
        json,
        real,
        build: (node, realNode, m) => {
          if (
            !(node instanceof Pairs) ||
            node.values.length !== entries.length ||
            !(realNode instanceof Pairs) ||
            realNode.values.length !== entries.length
          ) {
            return HIDDEN;
          }
          const out = Object.create(null) as Record<string, unknown>;
          // The next number to try for each masked key, so thousands masked alike stay linear.
          const next = new Map<string, number>();
          entries.forEach((entry, i) => {
            const base = m[entry.keyAt]!;
            let key = base;
            if (Object.hasOwn(out, key)) {
              // Two keys masked alike stay apart.
              let n = next.get(base) ?? 2;
              do key = `${base} (${n++})`;
              while (Object.hasOwn(out, key));
              next.set(base, n);
            }
            out[key] = entry.build(node.values[i], realNode.values[i], m);
          });
          return out;
        },
      };
    } finally {
      seen.delete(value);
    }
  };

  const top = walk(result, 0);
  fields[0] = { kind: 'json', value: JSON.stringify(top.json) };
  // Only with a marked value is it any different from the first.
  const realAt = marked ? fields.push({ kind: 'json', value: JSON.stringify(top.real) }) - 1 : 0;
  return {
    fields,
    build: (m) => {
      const node = readMasked(m[0]!);
      return top.build(node, realAt === 0 ? node : readMasked(m[realAt]!), m);
    },
  };
}
