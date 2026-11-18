/**
 * Stopping searches in the backend (src/backend/backend.ts, search.ts): by name with
 * cancelMatch, by reusing a name, past the limit on named searches, by Clear, by the window's
 * connection closing, and by the backend stopping. A large HAR import makes each search long
 * enough to interrupt.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { MAX_NAMED_SEARCHES, MAX_SEARCH_ID_LENGTH } from '../src/backend/search';
import { apiClient, TOKEN, UI_ORIGIN } from './helpers';

/** Exchanges, each with many long headers, so a search over all of them takes a while. */
const ENTRIES = 4000;

async function bigHar(file: string): Promise<void> {
  const headers = Array.from({ length: 40 }, (_, i) => ({ name: `x-filler-${i}`, value: 'v'.repeat(300) }));
  const entry = (i: number) => ({
    startedDateTime: '2026-11-18T00:00:00.000Z',
    time: 1,
    request: {
      method: 'GET',
      url: `https://big.test/${i}`,
      httpVersion: 'HTTP/1.1',
      headers: [...headers, { name: 'x-n', value: String(i) }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers,
      cookies: [],
      content: { size: 0, mimeType: 'text/plain' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 1, receive: 0 },
  });
  await writeFile(
    file,
    JSON.stringify({
      log: {
        version: '1.2',
        creator: { name: 'test', version: '1' },
        entries: Array.from({ length: ENTRIES }, (_, i) => entry(i)),
      },
    }),
  );
}

describe('stopping searches', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let harFile: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-cancel-test-'));
    harFile = path.join(dataDir, 'big.har');
    await bigHar(harFile);
    backend = await startBackend({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });
    expect(await backend.importHar(harFile)).toMatchObject({ imported: ENTRIES });
  }, 60_000);

  afterAll(async () => {
    await backend?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * A search that finds nothing, slowly: each negated term passes, so all of them read every
   * header of every exchange, and the last finds nothing.
   */
  const SLOW = `${Array.from({ length: 60 }, (_, i) => `-header~absent-${i}`).join(' ')} header~not-anywhere`;

  it('a full search over the import takes long enough to interrupt, and finds what it should', async () => {
    const api = await apiClient(backend.apiPort);
    const started = performance.now();
    const reply = await api.send<{ ids: string[] }>({
      command: 'matchExchanges',
      query: 'reqheader.x-n=3999',
    });
    expect(reply.ids).toHaveLength(1);
    // Several 8 ms slices at least: otherwise the tests below couldn't land mid-search.
    expect(performance.now() - started).toBeGreaterThan(20);
    // And the slow search takes far longer than a poll's interval.
    const slowStart = performance.now();
    expect(await api.send({ command: 'matchExchanges', query: SLOW })).toEqual({ ids: [] });
    expect(performance.now() - slowStart).toBeGreaterThan(300);
    api.close();
  });

  it('cancelMatch stops a named search, whose reply is the error "Canceled"', async () => {
    const api = await apiClient(backend.apiPort);
    const search = api.send({ command: 'matchExchanges', query: SLOW, searchId: 'one' });
    const cancel = api.send({ command: 'cancelMatch', searchId: 'one' });
    await expect(search).rejects.toThrow('Canceled');
    await expect(cancel).resolves.toBeUndefined();
    expect(backend.searchesRunning()).toBe(0);
    api.close();
  });

  it('a search given a name in use replaces the earlier one', async () => {
    const api = await apiClient(backend.apiPort);
    const first = api.send({ command: 'matchExchanges', query: SLOW, searchId: 'same' });
    const second = api.send<{ ids: string[] }>({
      command: 'matchExchanges',
      query: 'reqheader.x-n=7',
      searchId: 'same',
    });
    await expect(first).rejects.toThrow('Canceled');
    expect((await second).ids).toHaveLength(1);
    api.close();
  });

  it('past the limit on named searches, the oldest is canceled', async () => {
    const api = await apiClient(backend.apiPort);
    const replies = Array.from({ length: MAX_NAMED_SEARCHES + 1 }, (_, i) =>
      api.send({ command: 'matchExchanges', query: SLOW, searchId: `n${i}` }).then(
        () => 'done',
        (error: Error) => error.message,
      ),
    );
    // The oldest goes when the 33rd arrives; the other 32 are all still running.
    expect(await replies[0]).toBe('Canceled');
    expect(backend.searchesRunning()).toBe(MAX_NAMED_SEARCHES);
    for (let i = 1; i <= MAX_NAMED_SEARCHES; i++)
      await api.send({ command: 'cancelMatch', searchId: `n${i}` });
    expect(new Set(await Promise.all(replies))).toEqual(new Set(['Canceled']));
    expect(backend.searchesRunning()).toBe(0);
    api.close();
  });

  it('cancelMatch for a name not running is harmless; an unnamed search can’t be canceled by name', async () => {
    const api = await apiClient(backend.apiPort);
    await expect(api.send({ command: 'cancelMatch', searchId: 'never-started' })).resolves.toBeUndefined();
    const unnamed = api.send<{ ids: string[] }>({ command: 'matchExchanges', query: 'reqheader.x-n=12' });
    await api.send({ command: 'cancelMatch', searchId: 'undefined' });
    expect((await unnamed).ids).toHaveLength(1);
    api.close();
  });

  it('refuses names that aren’t short text', async () => {
    const api = await apiClient(backend.apiPort);
    const bad = ['', 'x'.repeat(MAX_SEARCH_ID_LENGTH + 1), 42, null];
    for (const searchId of bad) {
      await expect(api.send({ command: 'cancelMatch', searchId } as never)).rejects.toThrow(
        'searchId must be text',
      );
      await expect(
        api.send({ command: 'matchExchanges', query: 'header~x', ids: [], searchId } as never),
      ).rejects.toThrow('searchId must be text');
    }
    await expect(
      api.send({
        command: 'matchExchanges',
        query: 'header~x',
        ids: [],
        searchId: 'x'.repeat(MAX_SEARCH_ID_LENGTH),
      }),
    ).resolves.toEqual({ ids: [] });
    api.close();
  });

  it('a window closing stops its searches, not another window’s', async () => {
    const leaving = await apiClient(backend.apiPort);
    const staying = await apiClient(backend.apiPort);
    void leaving.send({ command: 'matchExchanges', query: SLOW }).catch(() => undefined);
    const kept = staying.send<{ ids: string[] }>({ command: 'matchExchanges', query: SLOW });
    await expect.poll(() => backend.searchesRunning()).toBe(2);
    leaving.close();
    await expect.poll(() => backend.searchesRunning()).toBe(1);
    expect((await kept).ids).toEqual([]);
    expect(backend.searchesRunning()).toBe(0);
    staying.close();
  });

  it('a search only a window has can be canceled by that name from another window too', async () => {
    // Names are the backend's, not per window: the UI makes them unique.
    const a = await apiClient(backend.apiPort);
    const b = await apiClient(backend.apiPort);
    const search = a.send({ command: 'matchExchanges', query: SLOW, searchId: 'shared' });
    await b.send({ command: 'cancelMatch', searchId: 'shared' });
    await expect(search).rejects.toThrow('Canceled');
    a.close();
    b.close();
  });

  // Last: Clear empties the store, and stop ends the backend.
  it('Clear stops a running search, which answers with nothing rather than an error', async () => {
    const api = await apiClient(backend.apiPort);
    // Slow, and matching every exchange, so it has matches in hand when Clear comes: a search
    // left to finish would answer with them.
    const everyOne = `${Array.from({ length: 60 }, (_, i) => `-header~absent-${i}`).join(' ')} header.x-n=*`;
    const search = api.send<{ ids: string[] }>({
      command: 'matchExchanges',
      query: everyOne,
      searchId: 'clear-me',
    });
    await expect.poll(() => backend.searchesRunning()).toBe(1);
    await api.send({ command: 'clear' });
    await expect(search).resolves.toEqual({ ids: [] });
    expect(backend.searchesRunning()).toBe(0);
    api.close();
  });

  // Stopping closes every window's connection (before the body store closes), which stops its
  // searches.
  it('stopping the backend stops a running search', async () => {
    expect(await backend.importHar(harFile)).toMatchObject({ imported: ENTRIES });
    const api = await apiClient(backend.apiPort);
    const search = api.send({ command: 'matchExchanges', query: SLOW }).then(
      () => 'answered',
      (error: Error) => error.message,
    );
    await expect.poll(() => backend.searchesRunning()).toBe(1);
    const stopping = backend.stop();
    // Either it answered (nothing) before the socket closed, or the socket closed first.
    expect(['answered', 'Disconnected', 'Socket closed']).toContain(
      await Promise.race([search, stopping.then(() => 'answered')]),
    );
    await stopping;
    expect(backend.searchesRunning()).toBe(0);
    backend = undefined as never;
  });
});
