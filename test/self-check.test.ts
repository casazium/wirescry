/**
 * The backend's start-up self-check (src/backend/self-check.ts), which the packaged self-test
 * runs on every build. Tests run the backend with its launch flags, so here it should find
 * nothing; with each part broken, it should say which.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  describe('the packaged Java agent', () => {
    const resources = async (names: string[]) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry resources-'));
      await mkdir(path.join(dir, 'java-agent'));
      for (const name of names) await writeFile(path.join(dir, 'java-agent', name), '');
      return dir;
    };
    const selfCheck = async (dir: string) => (await import('../src/backend/self-check')).selfCheck(dir);

    it('finds nothing wrong when the app’s resources hold its three jars', async () => {
      const dir = await resources([
        'wirescry-agent.jar',
        'wirescry-agent-impl.jar',
        'wirescry-agent-weaver.jar',
      ]);
      expect(await selfCheck(dir)).toEqual([]);
      await rm(dir, { recursive: true });
    });

    it('says so when one is missing, even with a development build to fall back on', async () => {
      const dir = await resources(['wirescry-agent.jar', 'wirescry-agent-impl.jar']);
      expect(await selfCheck(dir)).toEqual([
        `the Java agent's jars aren't in ${path.join(dir, 'java-agent')}`,
      ]);
      await rm(dir, { recursive: true });
    });
  });
});
