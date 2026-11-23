/**
 * A plugin MCP tool's result, made safe to give an agent. The result is masked as one JSON body, by
 * the same rules as a captured one, so a value is judged by its key and its neighbors (`password`,
 * a `{ name: 'authorization', value }` pair). Each string also gets the text rules, and each key is
 * masked. Values the plugin marked (McpLeaf) stand in that body as placeholders and are masked by
 * what they are: a header value by its name, a body by its type. A placeholder the JSON rules hid
 * sat under a secret's name, so that value is hidden whole.
 */
import { randomInt } from 'node:crypto';
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

/** Puts one value together from its node in the masked JSON and the other masked fields. */
type Built = (node: unknown, masked: readonly string[]) => unknown;

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
  // Not guessable, so a string in the result can't be the same as a placeholder.
  const salt = randomInt(1e12);

  /** The value as it goes into the JSON, and how to build it from what comes back. */
  const walk = (value: unknown, depth: number): { json: unknown; build: Built } => {
    if (++nodes > MAX_NODES) throw new ResultError('The result is too large.');
    if (depth > MAX_DEPTH) throw new ResultError('The result nests too deeply.');
    if (value === null || typeof value === 'boolean') return { json: value, build: () => value };
    if (typeof value === 'number') {
      // JSON has no NaN or Infinity.
      if (!Number.isFinite(value)) return { json: null, build: () => null };
      // A PIN or a code can be a number: hidden, it comes back as text.
      return { json: value, build: (node) => (typeof node === 'number' ? value : HIDDEN) };
    }
    if (typeof value === 'string') {
      const at = add({ kind: 'text', value });
      return {
        json: value,
        build: (node, m) => {
          if (typeof node !== 'string') return HIDDEN;
          if (node === value) return m[at];
          // Each pass found something: unless they agree, neither result has everything hidden.
          return m[at] === value || m[at] === node ? node : HIDDEN;
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
        const items: Array<{ json: unknown; build: Built }> = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          // As JSON.stringify: undefined (or a hole) in a list is null.
          if (item === undefined) {
            nodes++;
            items.push({ json: null, build: () => null });
          } else items.push(walk(item, depth + 1));
        }
        return {
          json: items.map((item) => item.json),
          build: (node, m) =>
            Array.isArray(node) && node.length === items.length
              ? items.map((item, i) => item.build(node[i], m))
              : HIDDEN,
        };
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new ResultError('The result isn’t plain JSON.');
      const record = value as Record<string, unknown>;
      const leaf = asLeaf(record);
      if (leaf) {
        const at = leaf.map(add);
        // Each its own: a value learned under a secret's name mustn't hide the others.
        const placeholder = `wirescryMarkedValue${salt}x${placeholders++}`;
        return {
          json: placeholder,
          build: (node, m) => {
            if (node !== placeholder) return HIDDEN;
            return leaf[0]!.kind === 'host' ? { name: m[at[0]!], value: m[at[1]!] } : m[at[0]!];
          },
        };
      }
      // As JSON.stringify: a key whose value is undefined is left out.
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .map((key) => ({ key, keyAt: add({ kind: 'text', value: key }), ...walk(record[key], depth + 1) }));
      // No prototype, so a key called __proto__ is kept like any other.
      const json = Object.create(null) as Record<string, unknown>;
      for (const entry of entries) json[entry.key] = entry.json;
      return {
        json,
        build: (node, m) => {
          if (!(node instanceof Pairs) || node.values.length !== entries.length) return HIDDEN;
          const out = Object.create(null) as Record<string, unknown>;
          entries.forEach((entry, i) => {
            let key = m[entry.keyAt]!;
            // Two keys masked alike stay apart.
            for (let n = 2; Object.hasOwn(out, key); n++) key = `${m[entry.keyAt]} (${n})`;
            out[key] = entry.build(node.values[i], m);
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
  return { fields, build: (m) => top.build(readMasked(m[0]!), m) };
}
