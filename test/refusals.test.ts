/** The counter of refused connections (src/backend/refusals.ts): taking off what was shown. */
import { describe, expect, it } from 'vitest';
import { MAX_REFUSED_HOSTS, Refusals } from '../src/backend/refusals';

describe('Refusals.subtract', () => {
  it('takes off what was seen, keeping what came since', () => {
    const refusals = new Refusals();
    refusals.add('c', 'a.test');
    refusals.add('c', 'a.test');
    const seen = refusals.of('c')!;
    refusals.add('c', 'a.test');
    refusals.add('c', 'b.test');
    refusals.subtract('c', seen);
    expect(refusals.of('c')).toEqual({
      count: 2,
      hosts: [
        { host: 'a.test', count: 1 },
        { host: 'b.test', count: 1 },
      ],
    });
  });

  it('leaves nothing once all of it was seen, as if cleared', () => {
    const refusals = new Refusals();
    refusals.add('c', 'a.test');
    refusals.subtract('c', refusals.of('c')!);
    expect(refusals.of('c')).toBeUndefined();
  });

  it('never goes below nothing, and leaves other sources alone', () => {
    const refusals = new Refusals();
    refusals.add('c', 'a.test');
    refusals.add('d', 'a.test');
    refusals.subtract('c', { count: 5, hosts: [{ host: 'a.test', count: 5 }] });
    refusals.subtract('missing', { count: 1, hosts: [] });
    expect(refusals.of('c')).toBeUndefined();
    expect(refusals.of('d')).toEqual({ count: 1, hosts: [{ host: 'a.test', count: 1 }] });
  });

  it('says when hosts weren’t kept, until that’s been seen', () => {
    const refusals = new Refusals();
    for (let i = 0; i <= MAX_REFUSED_HOSTS; i += 1) refusals.add('c', `h${i}.test`);
    const seen = refusals.of('c')!;
    expect(seen.moreHosts).toBe(true);
    expect(seen.hosts).toHaveLength(MAX_REFUSED_HOSTS);
    refusals.add('c', 'h0.test');
    refusals.subtract('c', seen);
    expect(refusals.of('c')).toEqual({ count: 1, hosts: [{ host: 'h0.test', count: 1 }] });
  });

  it('isn’t “more hosts” at exactly the number kept', () => {
    const refusals = new Refusals();
    for (let i = 0; i < MAX_REFUSED_HOSTS; i += 1) refusals.add('c', `h${i}.test`);
    expect(refusals.of('c')!.moreHosts).toBeUndefined();
  });
});
