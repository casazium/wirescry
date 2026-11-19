/**
 * Searching one stored body (src/backend/body-search.ts): decoding, case, chunk boundaries, the
 * limit, what counts as partly searched, bodies that fail to decode or go away, and stopping.
 */
import { randomBytes } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { encodeBuffer } from 'http-encoding';
import { describe, expect, it } from 'vitest';
import type { StoredRange } from '../src/backend/body-store';
import { searchBody, type BodySource } from '../src/backend/body-search';
import { foldText } from '../src/shared/query';

const MB = 1024 * 1024;

interface FakeOptions {
  encoding?: string;
  /** Bytes that arrived, if more than were kept. */
  size?: number;
  receiving?: boolean;
  /** Return undefined (gone) from this read on, counting from 0. */
  goneAtRead?: number;
  /** Change the serial from this read on. */
  replacedAtRead?: number;
}

function fake(bytes: Uint8Array, options: FakeOptions = {}): BodySource & { reads: number } {
  const source = {
    reads: 0,
    encoding: options.encoding,
    async read(start: number, max: number): Promise<StoredRange | undefined> {
      const index = source.reads++;
      if (options.goneAtRead !== undefined && index >= options.goneAtRead) return undefined;
      return {
        bytes: bytes.subarray(start, Math.min(bytes.length, start + max)),
        stored: bytes.length,
        size: options.size ?? bytes.length,
        receiving: options.receiving ?? false,
        incomplete: false,
        serial: options.replacedAtRead !== undefined && index >= options.replacedAtRead ? 2 : 1,
      };
    },
  };
  return source;
}

const noTick = async (): Promise<void> => undefined;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const find = async (source: BodySource, ...needles: string[]) =>
  searchBody(
    source,
    needles.map((n) => foldText(n)),
    noTick,
  );
const foundIn = async (source: BodySource, ...needles: string[]) => [
  ...(await find(source, ...needles)).found,
];

describe('searchBody', () => {
  it('finds text in a plain body, ignoring case, and not text that isn’t there', async () => {
    const body = text('{"error":"User Not Found","code":404}');
    expect(await foundIn(fake(body), 'user not found')).toEqual(['user not found']);
    expect(await foundIn(fake(body), 'USER NOT FOUND')).toEqual(['user not found']);
    expect(await foundIn(fake(body), 'user not here')).toEqual([]);
    expect((await find(fake(body), 'user not here')).partial).toBe(false);
  });

  it('folds non-ASCII case, including İ and final sigma', async () => {
    expect(await foundIn(fake(text('ZÜRICH and ÉTÉ')), 'zürich', 'été')).toEqual(['zürich', 'été']);
    // İ lowercases to two UTF-16 units; the needle is folded the same way.
    expect(await foundIn(fake(text('İSTANBUL')), 'İstanbul')).toEqual(['i̇stanbul']);
    // A word ending in Σ folds to σ, as the needle's Σ does mid-word.
    expect(await foundIn(fake(text('ΟΔΟΣ 5')), 'οδοσ')).toEqual(['οδοσ']);
    expect(await foundIn(fake(text('οδος')), 'ΟΔΟΣ')).toEqual(['οδοσ']);
  });

  it('decodes gzip, deflate, br, zstd and a chain before searching', async () => {
    const plain = Buffer.from(JSON.stringify({ items: Array(200).fill('needle-in-compressed') }));
    for (const encoding of ['gzip', 'deflate', 'br', 'zstd'] as const) {
      const encoded = encoding === 'zstd' ? zstdCompressSync(plain) : await encodeBuffer(plain, encoding);
      expect({ encoding, found: await foundIn(fake(encoded, { encoding }), 'needle-in-compressed') }).toEqual(
        {
          encoding,
          found: ['needle-in-compressed'],
        },
      );
    }
    const chained = await encodeBuffer(await encodeBuffer(plain, 'gzip'), 'br');
    expect(await foundIn(fake(chained, { encoding: 'gzip, br' }), 'needle-in-compressed')).toEqual([
      'needle-in-compressed',
    ]);
  });

  it('finds text only decoding shows: a long repeat compression never stores as it is', async () => {
    const plain = Buffer.from('ab'.repeat(50_000));
    const needle = 'ab'.repeat(200);
    for (const encoding of ['gzip', 'deflate', 'br'] as const) {
      const encoded = await encodeBuffer(plain, encoding);
      expect(encoded.toString('latin1')).not.toContain(needle);
      expect(await foundIn(fake(encoded), needle)).toEqual([]);
      expect(await foundIn(fake(encoded, { encoding }), needle)).toEqual([needle]);
    }
  });

  it('finds a match across a 1 MB piece boundary', async () => {
    const body = Buffer.alloc(2 * MB, 'x');
    body.write('ACROSS-THE-BOUNDARY', MB - 6);
    const source = fake(body);
    expect(await foundIn(source, 'across-the-boundary')).toEqual(['across-the-boundary']);
    expect(source.reads).toBeGreaterThan(1);
  });

  it('finds a match with only its last character in the next piece', async () => {
    const needle = 'last-char-over';
    const body = Buffer.alloc(2 * MB, 'x');
    body.write(needle, MB - (needle.length - 1));
    expect(await foundIn(fake(body), needle)).toEqual([needle]);
    // And only its first in the previous one.
    const other = Buffer.alloc(2 * MB, 'x');
    other.write(needle, MB - 1);
    expect(await foundIn(fake(other), needle)).toEqual([needle]);
  });

  it('finds a multi-byte character split between pieces', async () => {
    const body = Buffer.alloc(2 * MB, 'x');
    // "é" is two bytes; put its first byte last in the first piece.
    body.write('café-au-lait', MB - 4, 'utf8');
    expect(Buffer.from(body.subarray(MB - 1, MB + 1)).toString('utf8')).toBe('é');
    expect(await foundIn(fake(body), 'café-au-lait')).toEqual(['café-au-lait']);
  });

  it('finds a match across a decoded chunk boundary in a compressed body', async () => {
    const plain = Buffer.alloc(3 * MB, 'y');
    plain.write('needle-mid-stream', MB + 16 * 1024 - 5);
    const encoded = await encodeBuffer(plain, 'gzip');
    expect(await foundIn(fake(encoded, { encoding: 'gzip' }), 'needle-mid-stream')).toEqual([
      'needle-mid-stream',
    ]);
  });

  it('finds UTF-8 text inside a binary body, such as a protobuf string field', async () => {
    const proto = Buffer.from([0x0a, 0x0b, ...Buffer.from('hello-proto'), 0x10, 0x96, 0x01, 0xff, 0xfe]);
    expect(await foundIn(fake(proto), 'hello-proto')).toEqual(['hello-proto']);
    expect(await foundIn(fake(proto), 'goodbye')).toEqual([]);
  });

  it('searches several needles in one pass, and stops reading once all are found', async () => {
    const body = Buffer.alloc(8 * MB, 'z');
    body.write('first', 10);
    body.write('second', 100);
    const source = fake(body);
    expect(await foundIn(source, 'first', 'second', 'first')).toEqual(['first', 'second']);
    // The stream reads one piece ahead, no more.
    expect(source.reads).toBeLessThanOrEqual(2);
    // One missing: it reads to the end.
    const again = fake(body);
    expect(await foundIn(again, 'first', 'third')).toEqual(['first']);
    expect(again.reads).toBeGreaterThan(8);
  });

  it('searches at most the limit; partly searched only if not found', async () => {
    const body = Buffer.alloc(3 * MB, 'q');
    body.write('early', 0);
    body.write('late', 2 * MB + 5);
    const run = (needle: string) => searchBody(fake(body), [needle], noTick, MB);
    expect(await run('early')).toEqual({ found: new Set(['early']), partial: false });
    expect(await run('late')).toEqual({ found: new Set(), partial: true });
  });

  it('stops a decompression bomb at the limit, quickly, as partly searched', async () => {
    const bomb = await encodeBuffer(Buffer.alloc(256 * MB, 0), 'gzip');
    expect(bomb.length).toBeLessThan(MB);
    const started = performance.now();
    const result = await searchBody(fake(bomb, { encoding: 'gzip' }), ['not-there'], noTick);
    expect(result).toEqual({ found: new Set(), partial: true });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('says partly searched when Wirescry didn’t keep all of it, unless found', async () => {
    const body = text('kept part has this');
    expect(await find(fake(body, { size: 1000 * MB }), 'missing')).toEqual({
      found: new Set(),
      partial: true,
    });
    expect(await find(fake(body, { size: 1000 * MB }), 'has this')).toEqual({
      found: new Set(['has this']),
      partial: false,
    });
  });

  it('a finished body that fails to decode is searched as stored, and is partly searched if not found', async () => {
    const notGzip = text('definitely not gzip, but readable');
    expect(await find(fake(notGzip, { encoding: 'gzip' }), 'readable')).toEqual({
      found: new Set(['readable']),
      partial: false,
    });
    expect(await find(fake(notGzip, { encoding: 'gzip' }), 'elsewhere')).toEqual({
      found: new Set(),
      partial: true,
    });
  });

  it('a finished body that fails partway keeps what decoded before the failure', async () => {
    const plain = Buffer.from(`start-marker ${'p'.repeat(200_000)}`);
    const encoded = await encodeBuffer(plain, 'gzip');
    // Corrupt the end: decoding gets far, then fails.
    const broken = Buffer.from(encoded);
    broken.fill(0xff, broken.length - 200);
    const result = await find(fake(broken, { encoding: 'gzip' }), 'start-marker');
    expect(result.found).toEqual(new Set(['start-marker']));
    expect(result.partial).toBe(false);
  });

  it('an encoding Wirescry can’t undo is searched as stored, partly if not found', async () => {
    const body = text('raw readable bytes');
    expect(await find(fake(body, { encoding: 'x-made-up' }), 'readable')).toEqual({
      found: new Set(['readable']),
      partial: false,
    });
    expect((await find(fake(body, { encoding: 'x-made-up' }), 'other')).partial).toBe(true);
  });

  it('a compressed body still arriving is searched as far as it decodes, not as partly searched', async () => {
    const plain = Buffer.from(`so-far ${'s'.repeat(300_000)} not-yet`);
    const encoded = await encodeBuffer(plain, 'gzip');
    const cut = encoded.subarray(0, Math.floor(encoded.length / 2));
    expect(await find(fake(cut, { encoding: 'gzip', receiving: true }), 'so-far', 'not-yet')).toEqual({
      found: new Set(['so-far']),
      partial: false,
    });
  });

  it('a body that goes away while it’s read ends the search without an error', async () => {
    const body = Buffer.alloc(3 * MB, 'g');
    body.write('only-at-the-end', 3 * MB - 20);
    expect(await find(fake(body, { goneAtRead: 1 }), 'only-at-the-end')).toEqual({
      found: new Set(),
      partial: false,
    });
    // Replaced by another body: the new one's bytes aren't read as this one's.
    const replaced = fake(body, { replacedAtRead: 1 });
    expect(await find(replaced, 'only-at-the-end')).toEqual({ found: new Set(), partial: false });
    expect(replaced.reads).toBe(2);
  });

  it('an empty body or no needles reads nothing harmful', async () => {
    expect(await find(fake(new Uint8Array(0)), 'x')).toEqual({ found: new Set(), partial: false });
    const source = fake(text('abc'));
    expect(await searchBody(source, [], noTick)).toEqual({ found: new Set(), partial: false });
    expect(source.reads).toBe(0);
  });

  it('calls the tick between pieces, and stops with its error', async () => {
    const body = Buffer.alloc(4 * MB, 'w');
    let ticks = 0;
    await searchBody(fake(body), ['absent'], async () => {
      ticks++;
    });
    expect(ticks).toBeGreaterThanOrEqual(4);

    const stop = new Error('stopped');
    let calls = 0;
    await expect(
      searchBody(fake(body), ['absent'], async () => {
        if (++calls === 3) throw stop;
      }),
    ).rejects.toBe(stop);
  });

  it('stops with the tick’s error mid-decode too, not as a decoding failure', async () => {
    const encoded = await encodeBuffer(Buffer.alloc(8 * MB, 'e'), 'gzip');
    const stop = new Error('stopped mid-decode');
    let calls = 0;
    await expect(
      searchBody(fake(encoded, { encoding: 'gzip' }), ['absent'], async () => {
        if (++calls === 5) throw stop;
      }),
    ).rejects.toBe(stop);
  });

  describe('after code review', () => {
    it('an empty compressed body (a HEAD or 304 reply) isn’t partly searched', async () => {
      for (const encoding of ['gzip', 'deflate', 'br', 'zstd']) {
        expect({ encoding, result: await find(fake(new Uint8Array(0), { encoding }), 'x') }).toEqual({
          encoding,
          result: { found: new Set(), partial: false },
        });
      }
    });

    it('a compressed body gone or replaced while read isn’t partly searched', async () => {
      const encoded = await encodeBuffer(Buffer.from('z'.repeat(3 * MB)), 'gzip');
      expect(await find(fake(encoded, { encoding: 'gzip', goneAtRead: 0 }), 'x')).toEqual({
        found: new Set(),
        partial: false,
      });
      const big = await encodeBuffer(randomBytes(2 * MB), 'gzip');
      expect(big.length).toBeGreaterThan(MB);
      expect(await find(fake(big, { encoding: 'gzip', replacedAtRead: 1 }), 'not-there')).toEqual({
        found: new Set(),
        partial: false,
      });
    });

    it('a body replaced between the decoding pass and the stored-bytes pass isn’t read as this one', async () => {
      const notGzip = text('plainly not gzip at all');
      const source = fake(notGzip, { encoding: 'gzip', replacedAtRead: 1 });
      expect(await find(source, 'plainly')).toEqual({ found: new Set(), partial: false });
    });

    it('a corrupt chained encoding is searched as stored, without an unhandled error', async () => {
      const plain = text('labelled gzip and br, but plain');
      expect(await find(fake(plain, { encoding: 'gzip, br' }), 'but plain')).toEqual({
        found: new Set(['but plain']),
        partial: false,
      });
      expect((await find(fake(plain, { encoding: 'gzip, br' }), 'elsewhere')).partial).toBe(true);
    });

    it('decodes chains however the header spaces them, and skips identity', async () => {
      const plain = Buffer.from('ab'.repeat(20_000));
      const needle = 'ab'.repeat(300);
      const chained = await encodeBuffer(await encodeBuffer(plain, 'gzip'), 'br');
      for (const encoding of ['gzip, br', 'gzip,br', ' gzip , br ', 'GZIP, BR', 'identity, gzip, br']) {
        expect({ encoding, found: await foundIn(fake(chained, { encoding }), needle) }).toEqual({
          encoding,
          found: [needle],
        });
      }
      expect(await foundIn(fake(plain, { encoding: 'identity' }), needle)).toEqual([needle]);
    });

    it('a body of exactly the limit isn’t partly searched; one byte more is', async () => {
      const exact = Buffer.alloc(MB, 'e');
      expect(await searchBody(fake(exact), ['absent'], noTick, MB)).toEqual({
        found: new Set(),
        partial: false,
      });
      const over = Buffer.alloc(MB + 1, 'e');
      expect(await searchBody(fake(over), ['absent'], noTick, MB)).toEqual({
        found: new Set(),
        partial: true,
      });
      // The last byte inside the limit is searched.
      const edge = Buffer.alloc(MB, 'e');
      edge.write('end', MB - 3);
      expect(await searchBody(fake(edge), ['end'], noTick, MB)).toEqual({
        found: new Set(['end']),
        partial: false,
      });
    });

    it('the limit applies to the stored-bytes pass too', async () => {
      const notGzip = Buffer.alloc(3 * MB, 'n');
      notGzip.write('far-away', 2 * MB);
      expect(await searchBody(fake(notGzip, { encoding: 'gzip' }), ['far-away'], noTick, MB)).toEqual({
        found: new Set(),
        partial: true,
      });
    });

    it('stops with whatever the tick throws, even undefined, without searching the stored bytes', async () => {
      const encoded = await encodeBuffer(Buffer.alloc(4 * MB, 'u'), 'gzip');
      const source = fake(encoded, { encoding: 'gzip' });
      let calls = 0;
      await expect(
        searchBody(source, ['absent'], async () => {
          if (++calls === 2) throw undefined;
        }),
      ).rejects.toBeUndefined();
      const readsWhenStopped = source.reads;
      // No second pass started.
      await new Promise((resolve) => setImmediate(resolve));
      expect(source.reads).toBe(readsWhenStopped);
    });
  });

  it('a body replaced before its first read isn’t read as the one expected', async () => {
    // The search expects serial 1; the store already holds a newer body (2).
    const source = { ...fake(text('the newer body')), serial: 1 };
    const original = source.read.bind(source);
    source.read = async (start, max) => {
      const range = await original(start, max);
      return range && { ...range, serial: 2 };
    };
    const report = { gone: false, final: false };
    expect(await searchBody(source, ['newer'], noTick, undefined, report)).toEqual({
      found: new Set(),
      partial: false,
    });
    expect(report.gone).toBe(true);
  });
});
