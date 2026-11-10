/**
 * The backend's start-up self-check (src/backend/self-check.ts), which the packaged self-test
 * runs on every build. Tests run the backend with its launch flags, so here it should find
 * nothing; with each part broken, it should say which.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/backend/formatter');
  vi.doUnmock('../src/backend/body-content');
  vi.resetModules();
});

const check = async () => (await import('../src/backend/self-check')).selfCheck();

describe('selfCheck', () => {
  it('finds nothing wrong when the backend has its V8 flags', async () => {
    expect(await check()).toEqual([]);
  });

  it('says so when HTML formatting gives the wrong text, or fails', async () => {
    vi.doMock('../src/backend/formatter', () => ({
      Formatter: class {
        format = async () => '<div><p>x</p></div>';
        close = vi.fn(async () => undefined);
      },
    }));
    expect(await check()).toEqual(['formatting HTML gave "<div><p>x</p></div>"']);
    vi.resetModules();
    const close = vi.fn(async () => undefined);
    vi.doMock('../src/backend/formatter', () => ({
      Formatter: class {
        format = async () => {
          throw new Error('worker died');
        };
        close = close;
      },
    }));
    expect(await check()).toEqual(['formatting HTML failed: worker died']);
    // The formatter's worker is closed either way.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('says so when a gzip body doesn’t decode', async () => {
    vi.doMock('../src/backend/body-content', () => ({
      toBodyContent: async () => ({ base64: Buffer.from('garbled').toString('base64') }),
    }));
    expect(await check()).toEqual(['decoding a gzip body gave "garbled"']);
  });
});
