/**
 * How a redacted export handles entries the worker can't redact: fewer bodies, then left out;
 * and when it must fail instead. The worker client is scripted here; test/redactor.test.ts and
 * test/har-export-redacted.test.ts run the real one.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import { apiClient, exchangesIn, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Step = 'ok' | 'tooLarge' | 'dropped' | 'throw';

const script = vi.hoisted(() => ({
  /** What each redact call does, in order; then 'ok'. */
  steps: [] as Step[],
  /** What each learn call does, in order; then 'ok'. */
  learnSteps: [] as Array<'ok' | 'throw' | 'dropped'>,
  learnFull: false,
  onLearn: undefined as (() => void | Promise<void>) | undefined,
  calls: [] as Array<{ op: string; entry?: Json }>,
  closed: 0,
  full: false,
  onRedact: undefined as (() => void) | undefined,
}));

vi.mock('../src/backend/redactor', () => ({
  HarRedactor: class {
    async collect(parts: Json[]): Promise<void> {
      script.calls.push({ op: 'collect', entry: { parts } });
    }
    async learn(entry: Json): Promise<unknown> {
      script.calls.push({ op: 'learn', entry });
      await script.onLearn?.();
      const step = script.learnSteps.shift() ?? 'ok';
      if (step === 'throw') throw new Error('the redaction worker stopped');
      if (step === 'dropped') return { dropped: true };
      return { full: script.learnFull };
    }
    async redact(entry: Json): Promise<unknown> {
      script.calls.push({ op: 'redact', entry });
      script.onRedact?.();
      const step = script.steps.shift() ?? 'ok';
      if (step === 'throw') throw new Error('the redaction worker stopped');
      if (step === 'tooLarge') return { tooLarge: true };
      if (step === 'dropped') return { dropped: true };
      return { text: JSON.stringify(entry), values: 1, notScanned: 0, leftOut: 0, full: script.full, ms: 1 };
    }
    async close(): Promise<void> {
      script.closed += 1;
    }
  },
}));

const { startBackend } = await import('../src/backend/backend');

describe('Redacted export, when entries can’t be redacted', () => {
  let dir: string;
  let backend: RunningBackend;
  let ids: string[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-har-ladder-'));
    backend = await startBackend({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /** Three exchanges with both bodies, imported once. */
  const ready = async (): Promise<void> => {
    if (ids) return;
    const source = path.join(dir, 'source.har');
    const entry = (n: number) => ({
      startedDateTime: '2026-11-20T12:00:00.000Z',
      request: {
        method: 'POST',
        url: `https://example.com/${n}`,
        headers: [{ name: 'content-type', value: 'text/plain' }],
        postData: { mimeType: 'text/plain', text: `request ${n}` },
      },
      response: { status: 200, content: { mimeType: 'text/plain', text: `response ${n}` } },
    });
    await writeFile(source, JSON.stringify({ log: { entries: [entry(1), entry(2), entry(3)] } }));
    const api = await apiClient(backend.apiPort);
    await backend.importHar(source);
    await expect.poll(() => exchangesIn(api.messages).length).toBe(3);
    ids = exchangesIn(api.messages).map((e) => e.id);
    api.close();
  };

  beforeEach(() => {
    script.steps = [];
    script.learnSteps = [];
    script.calls = [];
    script.closed = 0;
  });

  const exported = async (file: string): Promise<Json[]> =>
    JSON.parse(await readFile(path.join(dir, file), 'utf8')).log.entries as Json[];
  const redacts = (): Json[] => script.calls.filter((c) => c.op === 'redact').map((c) => c.entry!);
  const learns = (): Json[] => script.calls.filter((c) => c.op === 'learn').map((c) => c.entry!);

  it('collects every entry’s URL and headers, then learns every entry, before redacting any', async () => {
    await ready();
    const result = await backend.exportHar(path.join(dir, 'ok.har'), ids);
    expect(result).toEqual({
      count: 3,
      redaction: { values: 3, requests: 3, dropped: 0, notScanned: 0, leftOut: 0, full: false },
    });
    expect(script.calls.map((c) => c.op)).toEqual([
      'collect',
      'learn',
      'learn',
      'learn',
      'redact',
      'redact',
      'redact',
    ]);
    // Learned with its bodies, as it's then written.
    expect(learns()[0]!.request.postData.text).toBe('request 1');
    expect(learns()[0]!.response.content.text).toBe('response 1');
    expect(redacts()[0]).toEqual(learns()[0]);
    const parts = script.calls[0]!.entry!.parts as Json[];
    expect(parts.map((p) => p.request.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);
    // Only the light part: no bodies.
    expect(JSON.stringify(parts)).not.toContain('request 1');
    expect(script.closed).toBe(1);
    // What the worker wrote is what the file holds.
    expect((await exported('ok.har')).map((e) => e.request.url)).toEqual(parts.map((p) => p.request.url));
  });

  it('too large: tries without the response body, then without both', async () => {
    await ready();
    script.steps = ['tooLarge', 'ok', 'tooLarge', 'tooLarge', 'ok'];
    const result = await backend.exportHar(path.join(dir, 'large.har'), ids);
    expect(result.count).toBe(3);
    // The bodies taken out are counted: one from the first entry, two from the second.
    expect(result.redaction!.leftOut).toBe(3);
    const tried = redacts();
    expect(tried).toHaveLength(6);
    expect(tried[0]!.response.content.text).toBe('response 1');
    expect(tried[1]!.response.content.text).toBeUndefined();
    expect(tried[1]!.request.postData.text).toBe('request 1');
    expect(tried[1]!.comment).toContain('The response body was too large to write, so it was left out.');
    expect(tried[4]!.request.postData).toBeUndefined();
    expect(tried[4]!.comment).toContain('The bodies were too large to write, so they were left out.');
  });

  it('a worker that fails: tries with fewer bodies, and says they couldn’t be redacted', async () => {
    await ready();
    script.steps = ['throw', 'throw', 'ok'];
    await backend.exportHar(path.join(dir, 'failing.har'), ids);
    const tried = redacts();
    expect(tried[1]!.comment).toContain("The response body couldn't be redacted, so it was left out.");
    expect(tried[2]!.comment).toContain("The bodies couldn't be redacted, so they were left out.");
  });

  it('leaves out an entry the worker drops, or that’s too large even without bodies, and counts it', async () => {
    await ready();
    script.steps = ['dropped', 'ok', 'tooLarge', 'tooLarge', 'tooLarge'];
    const result = await backend.exportHar(path.join(dir, 'dropped.har'), ids);
    expect(result).toEqual({
      count: 1,
      redaction: { values: 1, requests: 1, dropped: 2, notScanned: 0, leftOut: 0, full: false },
    });
    expect((await exported('dropped.har')).map((e) => e.request.url)).toEqual(['https://example.com/2']);
  });

  it('fails, and writes nothing, when none can be redacted', async () => {
    await ready();
    script.steps = ['dropped', 'dropped', 'dropped'];
    await expect(backend.exportHar(path.join(dir, 'none.har'), ids)).rejects.toThrow(
      'None of these requests could be redacted.',
    );
    expect((await readdir(dir)).filter((f) => f.startsWith('none.har'))).toEqual([]);
    expect(script.closed).toBe(1);
  });

  it('fails, and writes nothing, when the worker can’t redact even an entry without bodies', async () => {
    await ready();
    // The last try, without bodies, gets a second go before the export fails.
    script.steps = ['ok', 'throw', 'throw', 'throw', 'throw'];
    await expect(backend.exportHar(path.join(dir, 'broken.har'), ids)).rejects.toThrow(
      "Couldn't redact the requests: the redaction worker stopped",
    );
    expect((await readdir(dir)).filter((f) => f.startsWith('broken.har'))).toEqual([]);
    expect(script.closed).toBe(1);
  });

  it('gives the last try a second go, and goes on when it works', async () => {
    await ready();
    script.steps = ['throw', 'throw', 'throw', 'ok'];
    const result = await backend.exportHar(path.join(dir, 'retried.har'), ids);
    expect(result.count).toBe(3);
    expect(redacts()).toHaveLength(6);
    expect(result.redaction!.leftOut).toBe(2);
  });

  it('passes on that some secrets may have been missed', async () => {
    await ready();
    script.full = true;
    try {
      expect((await backend.exportHar(path.join(dir, 'full.har'), ids)).redaction!.full).toBe(true);
    } finally {
      script.full = false;
    }
  });

  it('stops between entries when asked', async () => {
    await ready();
    const stopper = new AbortController();
    script.onRedact = () => stopper.abort();
    try {
      await expect(
        backend.exportHar(path.join(dir, 'aborted.har'), ids, { signal: stopper.signal }),
      ).rejects.toThrow('The export was stopped.');
    } finally {
      script.onRedact = undefined;
    }
    expect(redacts()).toHaveLength(1);
    expect((await readdir(dir)).filter((f) => f.startsWith('aborted.har'))).toEqual([]);
  });

  it('an entry that can’t be learned with its bodies is written without them, never unchecked', async () => {
    await ready();
    // The first entry: not with both bodies; the second: not even with its request body.
    script.learnSteps = ['throw', 'ok', 'throw', 'throw', 'ok'];
    const result = await backend.exportHar(path.join(dir, 'unlearned.har'), ids);
    expect(result.count).toBe(3);
    expect(learns()).toHaveLength(6);
    const tried = redacts();
    // Writing starts where learning got to: step 0 isn't tried again for those two.
    expect(tried).toHaveLength(3);
    expect(tried[0]!.response.content.text).toBeUndefined();
    expect(tried[0]!.request.postData.text).toBe('request 1');
    expect(tried[0]!.comment).toContain("The response body couldn't be redacted, so it was left out.");
    expect(tried[1]!.request.postData).toBeUndefined();
    expect(tried[1]!.comment).toContain("The bodies couldn't be redacted, so they were left out.");
    expect(tried[2]!.response.content.text).toBe('response 3');
    expect(result.redaction!.leftOut).toBe(3);
  });

  it('an entry that can’t be learned even without bodies is written without them, or fails the export as before', async () => {
    await ready();
    script.learnSteps = ['throw', 'throw', 'throw'];
    const result = await backend.exportHar(path.join(dir, 'never-learned.har'), ids);
    expect(result.count).toBe(3);
    const tried = redacts();
    expect(tried).toHaveLength(3);
    expect(tried[0]!.request.postData).toBeUndefined();
    expect(tried[0]!.response.content.text).toBeUndefined();
    expect(tried[0]!.comment).toContain("The bodies couldn't be redacted, so they were left out.");
    expect(result.redaction!.leftOut).toBe(2);
    // And when writing can't either, even on its second go: the export fails, with no file.
    script.calls = [];
    script.learnSteps = ['throw', 'throw', 'throw'];
    script.steps = ['throw', 'throw'];
    await expect(backend.exportHar(path.join(dir, 'never-written.har'), ids)).rejects.toThrow(
      "Couldn't redact the requests: the redaction worker stopped",
    );
    expect((await readdir(dir)).filter((f) => f.startsWith('never-written.har'))).toEqual([]);
  });

  it('an entry learning drops is still tried when written, from the start', async () => {
    await ready();
    script.learnSteps = ['dropped'];
    script.steps = ['dropped'];
    const result = await backend.exportHar(path.join(dir, 'learn-dropped.har'), ids);
    expect(learns()).toHaveLength(3);
    expect(redacts()[0]!.response.content.text).toBe('response 1');
    expect(result.redaction!.dropped).toBe(1);
  });

  it('passes on that learning turned a value away', async () => {
    await ready();
    script.learnFull = true;
    try {
      expect((await backend.exportHar(path.join(dir, 'learn-full.har'), ids)).redaction!.full).toBe(true);
    } finally {
      script.learnFull = false;
    }
  });

  it('stops while learning when asked, and writes nothing', async () => {
    await ready();
    const stopper = new AbortController();
    script.onLearn = () => stopper.abort();
    script.learnSteps = ['throw'];
    try {
      await expect(
        backend.exportHar(path.join(dir, 'aborted-learning.har'), ids, { signal: stopper.signal }),
      ).rejects.toThrow('The export was stopped.');
    } finally {
      script.onLearn = undefined;
    }
    // Not taken for a run of failures: one try, then stopped.
    expect(learns()).toHaveLength(1);
    expect(redacts()).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.startsWith('aborted-learning.har'))).toEqual([]);
  });

  it('writes what learning saw: a body still arriving then stays out, though it’s done by the time it’s written', async () => {
    await ready();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first part');
      void finished.then(() => res.end(' and the rest'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const api = await apiClient(backend.apiPort);
    try {
      const answered = httpViaProxy(backend.proxyPort, `http://127.0.0.1:${port}/arriving`);
      let arriving: string | undefined;
      await vi.waitFor(() => {
        arriving = exchangesIn(api.messages).find((e) => e.path === '/arriving' && e.status === 200)?.id;
        expect(arriving).toBeDefined();
      });
      // While another exchange is learned, the body arrives in full.
      script.onLearn = async () => {
        finish();
        await answered;
        await api.completed('/arriving');
      };
      await backend.exportHar(path.join(dir, 'arriving.har'), [arriving!, ids[0]!]);
      expect(learns()).toHaveLength(1);
      const written = redacts()[0]!;
      expect(written.request.url).toContain('/arriving');
      expect(written.response.content.text).toBeUndefined();
      // Its note once: what learning noted isn't noted again.
      expect(written.comment.split('still arriving').length - 1).toBe(1);
    } finally {
      script.onLearn = undefined;
      finish();
      api.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('doesn’t learn an entry with no bodies or messages', async () => {
    await ready();
    const source = path.join(dir, 'bare.har');
    await writeFile(
      source,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: '2026-11-20T12:00:00.000Z',
              request: { method: 'GET', url: 'https://example.com/bare', headers: [] },
              response: { status: 204 },
            },
          ],
        },
      }),
    );
    const api = await apiClient(backend.apiPort);
    await backend.importHar(source);
    await expect.poll(() => exchangesIn(api.messages).some((e) => e.url.endsWith('/bare'))).toBe(true);
    const bare = exchangesIn(api.messages).find((e) => e.url.endsWith('/bare'))!.id;
    api.close();
    script.calls = [];
    await backend.exportHar(path.join(dir, 'bare-out.har'), [bare]);
    expect(script.calls.map((c) => c.op)).toEqual(['collect', 'redact']);
  });

  it('doesn’t use the worker at all without redaction', async () => {
    await ready();
    expect(await backend.exportHar(path.join(dir, 'plain.har'), ids, { redact: false })).toEqual({
      count: 3,
    });
    expect(script.calls).toEqual([]);
    expect(script.closed).toBe(0);
    expect((await exported('plain.har'))[0]!.response.content.text).toBe('response 1');
  });
});
