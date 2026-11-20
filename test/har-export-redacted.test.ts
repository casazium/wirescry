/**
 * Redacted HAR export end to end: real traffic through a real backend, with secrets planted
 * everywhere they can go, exported, and the file searched for them in every form.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import { REDACTED_LOG_COMMENT } from '../src/backend/har';
import { apiClient, exchangesIn, requestViaProxy, TOKEN, UI_ORIGIN } from './helpers';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const KEY = 'ak_' + 'Zx8Wv6Ut4Sr2Qp0n';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const PASSWORD = 'hunter2' + 'Correct9Horse';
const COOKIE = 'c00k1e' + 'S3ss10nV4lu3x';
const FRAME = 'fr4me' + 'T0k3nQw7Er9Ty';
const SECRETS = { KEY, BEARER, ACCESS, PASSWORD, COOKIE, FRAME };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every form a secret could take in a file: as written, percent-encoded, and in base64. */
function forms(secret: string): string[] {
  const b64 = Buffer.from(secret).toString('base64');
  return [
    secret,
    encodeURIComponent(secret),
    b64.slice(0, -2),
    Buffer.from(secret, 'utf16le').toString('base64'),
  ];
}

/** The file's text, plus every base64 field decoded (as Latin-1 and as UTF-16). */
function everything(text: string): string {
  const parts = [text];
  const har = JSON.parse(text) as Json;
  const decode = (b64: unknown): void => {
    if (typeof b64 !== 'string') return;
    const bytes = Buffer.from(b64, 'base64');
    parts.push(
      bytes.toString('latin1'),
      bytes.toString('utf16le'),
      (bytes.length % 2 === 0 ? Buffer.from(bytes).swap16() : bytes).toString('utf16le'),
    );
  };
  for (const entry of har.log.entries as Json[]) {
    if (entry.response?.content?.encoding === 'base64') decode(entry.response.content.text);
    if (entry.request?.postData?._encoding === 'base64') decode(entry.request.postData.text);
    for (const m of entry._webSocketMessages ?? []) decode(m.data);
  }
  return parts.join('\n');
}

function expectNoSecrets(text: string): void {
  const all = everything(text);
  for (const [name, secret] of Object.entries(SECRETS)) {
    for (const form of forms(secret)) expect(all.includes(form), `${name} as ${form}`).toBe(false);
  }
}

describe('Redacted HAR export', () => {
  let dir: string;
  let upstream: Mockttp;
  let upstreamCA: Awaited<ReturnType<typeof generateCACertificate>>;
  let backend: RunningBackend;
  let ca: string;
  let api: Awaited<ReturnType<typeof apiClient>>;
  const others: RunningBackend[] = [];
  let ids: string[];
  const BIG = 12 * 1024 * 1024;

  const start = async (name: string): Promise<{ backend: RunningBackend; ca: string }> => {
    const dataDir = path.join(dir, name);
    const started = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      app: { version: '9.9.9', releaseDate: new Date().toISOString() },
    });
    return { backend: started, ca: (await loadOrCreateCA(dataDir)).cert };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-har-redact-'));
    upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await upstream.start();
    await upstream
      .forGet('/api')
      .thenReply(200, JSON.stringify({ access_token: ACCESS, echo: BEARER, n: 1 }), {
        'content-type': 'application/json',
        'set-cookie': `sid=${COOKIE}; HttpOnly`,
      });
    await upstream
      .forPost('/login')
      .thenReply(302, '', { location: `https://app.example/home?code=${ACCESS}` });
    // Not text, with a secret seen elsewhere inside it: left out.
    await upstream
      .forGet('/blob')
      .thenReply(
        200,
        Buffer.concat([Buffer.from([0, 1, 0x32]), Buffer.from(BEARER), Buffer.from([0x32, 0xff])]),
        {
          'content-type': 'application/octet-stream',
        },
      );
    // Not text, nothing in it: kept, unchecked.
    await upstream.forGet('/png').thenReply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]), {
      'content-type': 'image/png',
    });
    await upstream.forGet('/big').thenReply(
      200,
      JSON.stringify({
        rows: Array.from({ length: BIG / 64 }, (_, i) => ({ id: i, token: ACCESS, pad: 'x'.repeat(20) })),
      }),
      { 'content-type': 'application/json' },
    );

    ({ backend, ca } = await start('main'));
  });

  /** The traffic, captured once, by the first test that needs it (expect.poll runs only in tests). */
  let captured: Promise<void> | undefined;
  const ready = (): Promise<void> => (captured ??= capture());
  const capture = async (): Promise<void> => {
    api = await apiClient(backend.apiPort);
    const base = `https://localhost:${upstream.port}`;
    await requestViaProxy(backend.proxyPort, `${base}/api?api_key=${KEY}`, ca, {
      headers: { authorization: `Bearer ${BEARER}`, cookie: `sid=${COOKIE}` },
    });
    await requestViaProxy(backend.proxyPort, `${base}/login`, ca, {
      method: 'POST',
      body: `user=ada&password=${encodeURIComponent(PASSWORD)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    await requestViaProxy(backend.proxyPort, `${base}/blob`, ca);
    await requestViaProxy(backend.proxyPort, `${base}/png`, ca);
    ids = [
      await api.completed(`/api?api_key=${KEY}`),
      await api.completed('/login'),
      await api.completed('/blob'),
      await api.completed('/png'),
    ];
    // A WebSocket, imported: a text frame, a base64 one, and binary frames with and without.
    const startedAt = Date.parse('2026-11-20T12:00:00.000Z');
    const wsFile = path.join(dir, 'ws-source.har');
    await writeFile(
      wsFile,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: new Date(startedAt).toISOString(),
              _resourceType: 'websocket',
              request: {
                method: 'GET',
                url: `wss://example.com/socket?access_token=${ACCESS}`,
                headers: [{ name: 'Authorization', value: `Bearer ${BEARER}` }],
              },
              response: { status: 101, statusText: 'Switching Protocols' },
              _webSocketMessages: [
                { type: 'send', time: startedAt / 1000, opcode: 1, data: JSON.stringify({ token: FRAME }) },
                { type: 'receive', time: startedAt / 1000 + 1, opcode: 1, data: `welcome ${BEARER}` },
                {
                  type: 'receive',
                  time: startedAt / 1000 + 2,
                  opcode: 2,
                  data: Buffer.concat([Buffer.from([7]), Buffer.from(BEARER)]).toString('base64'),
                },
                {
                  type: 'receive',
                  time: startedAt / 1000 + 3,
                  opcode: 2,
                  data: Buffer.from([1, 2, 3]).toString('base64'),
                },
              ],
            },
          ],
        },
      }),
    );
    await backend.importHar(wsFile);
    await expect.poll(() => exchangesIn(api.messages).filter((e) => e.imported).length).toBe(1);
    ids.push(exchangesIn(api.messages).find((e) => e.imported)!.id);
  };

  afterAll(async () => {
    api?.close();
    for (const b of [backend, ...others]) await b?.stop();
    await upstream?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes no secret in any form, and says what it did', async () => {
    await ready();
    const file = path.join(dir, 'redacted.har');
    const result = await backend.exportHar(file, ids);
    expect(result.count).toBe(5);
    expect(result.redaction).toMatchObject({ dropped: 0, leftOut: 2, full: false });
    expect(result.redaction!.values).toBeGreaterThanOrEqual(10);
    // The API call, the login and the socket: the blob and the png have none.
    expect(result.redaction!.requests).toBe(3);
    // The png, the blob, and two binary frames.
    expect(result.redaction!.notScanned).toBe(4);
    const text = await readFile(file, 'utf8');
    expectNoSecrets(text);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const har = JSON.parse(text) as Json;
    expect(har.log.comment).toBe(REDACTED_LOG_COMMENT);
    expect(har.log._wirescryRedacted).toBe(true);
    expect(har.log.creator).toEqual({ name: 'Wirescry', version: '9.9.9' });
    const [apiEntry, login, blob, png, socket] = har.log.entries as [Json, Json, Json, Json, Json];
    expect(apiEntry.request.url).toMatch(/\/api\?api_key=\[redacted\]$/);
    expect(apiEntry.request.queryString).toEqual([{ name: 'api_key', value: '[redacted]' }]);
    expect(JSON.parse(apiEntry.response.content.text)).toEqual({
      access_token: '[redacted]',
      echo: '[redacted]',
      n: 1,
    });
    expect(apiEntry._wirescryRedactions).toContainEqual({
      in: 'request.headers',
      name: 'authorization',
      count: 1,
    });
    expect(login.request.postData.params).toEqual([
      { name: 'user', value: 'ada' },
      { name: 'password', value: '[redacted]' },
    ]);
    expect(login.response.redirectURL).toBe('https://app.example/home?code=[redacted]');
    expect(blob.response.content.text).toBeUndefined();
    expect(blob.comment).toMatch(/response body was left out/);
    expect(Buffer.from(png.response.content.text, 'base64')).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]),
    );
    expect(socket._webSocketMessages.map((m: Json) => m.data)).toEqual([
      '{"token":"[redacted]"}',
      'welcome [redacted]',
      '',
      Buffer.from([1, 2, 3]).toString('base64'),
    ]);
  });

  it('without redaction, writes everything as captured', async () => {
    await ready();
    const file = path.join(dir, 'plain.har');
    expect(await backend.exportHar(file, ids, { redact: false })).toEqual({ count: 5 });
    const text = await readFile(file, 'utf8');
    for (const secret of [KEY, BEARER, ACCESS, COOKIE, FRAME]) expect(text).toContain(secret);
    const har = JSON.parse(text) as Json;
    expect(har.log.comment).toBeUndefined();
    expect(har.log._wirescryRedacted).toBeUndefined();
    expect(text).not.toContain('_wirescryRedactions');
  });

  it('imports a redacted file whole, and says it was redacted; an unredacted one doesn’t', async () => {
    await ready();
    const redacted = path.join(dir, 'to-import.har');
    const plain = path.join(dir, 'to-import-plain.har');
    await backend.exportHar(redacted, ids);
    await backend.exportHar(plain, ids, { redact: false });
    const { backend: second } = await start('importer');
    others.push(second);
    expect(await second.importHar(redacted)).toEqual({
      imported: 5,
      skipped: 0,
      problems: [],
      removed: 0,
      redacted: true,
    });
    expect(await second.importHar(plain)).toMatchObject({ imported: 5, skipped: 0, redacted: false });
    // And exported again, still nothing.
    const again = path.join(dir, 'again.har');
    const all = exchangesIn((await apiClient(second.apiPort)).messages).map((e) => e.id);
    await second.exportHar(again, all.slice(0, 5), { redact: false });
    expectNoSecrets(await readFile(again, 'utf8'));
  });

  it('runs two exports at once, each with its own worker', async () => {
    await ready();
    const a = path.join(dir, 'a.har');
    const b = path.join(dir, 'b.har');
    const [ra, rb] = await Promise.all([backend.exportHar(a, ids), backend.exportHar(b, [...ids].reverse())]);
    expect(ra.count).toBe(5);
    expect(rb.count).toBe(5);
    expect(ra.redaction).toEqual(rb.redaction);
    expectNoSecrets(await readFile(a, 'utf8'));
    expectNoSecrets(await readFile(b, 'utf8'));
  });

  it('stops when asked, and leaves no file', async () => {
    await ready();
    const file = path.join(dir, 'stopped.har');
    const stopper = new AbortController();
    stopper.abort();
    await expect(backend.exportHar(file, ids, { signal: stopper.signal })).rejects.toThrow(
      'The export was stopped.',
    );
    const later = new AbortController();
    const running = backend.exportHar(file, ids, { signal: later.signal });
    later.abort();
    await expect(running).rejects.toThrow('The export was stopped.');
    expect((await readdir(dir)).filter((f) => f.startsWith('stopped.har'))).toEqual([]);
    // Unredacted ones stop too.
    await expect(backend.exportHar(file, ids, { redact: false, signal: stopper.signal })).rejects.toThrow(
      'The export was stopped.',
    );
  });

  it('says so when none of the requests are there any more', async () => {
    await ready();
    await expect(backend.exportHar(path.join(dir, 'none.har'), ['gone'])).rejects.toThrow(
      'None of those requests are in the list any more.',
    );
  });

  it('keeps the proxy answering while a large body is redacted, and stops when the backend does', async () => {
    await ready();
    const { backend: busy, ca: busyCa } = await start('busy');
    others.push(busy);
    const busyApi = await apiClient(busy.apiPort);
    const base = `https://localhost:${upstream.port}`;
    await requestViaProxy(busy.proxyPort, `${base}/big`, busyCa);
    await requestViaProxy(busy.proxyPort, `${base}/big`, busyCa);
    let bigs: string[] = [];
    await expect
      .poll(() => {
        bigs = exchangesIn(busyApi.messages)
          .filter((e) => e.path === '/big' && e.responseSize !== undefined)
          .map((e) => e.id);
        return bigs.length;
      })
      .toBe(2);

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const file = path.join(dir, 'big.har');
    const exported = busy.exportHar(file, bigs);
    // Meanwhile, requests through the proxy are answered.
    let answered = 0;
    let done = false;
    void exported.finally(() => (done = true)).catch(() => undefined);
    while (!done) {
      const at = performance.now();
      const reply = await requestViaProxy(busy.proxyPort, `${base}/png`, busyCa);
      expect(reply.status).toBe(200);
      expect(performance.now() - at).toBeLessThan(2000);
      answered += 1;
    }
    const result = await exported;
    const took = performance.now() - started;
    delay.disable();
    expect(result.count).toBe(2);
    expectNoSecrets(await readFile(file, 'utf8'));
    expect(answered).toBeGreaterThan(0);
    // Redacting ~24 MB of JSON takes seconds; done in the backend's thread, the event loop
    // would stall for most of it.
    expect(took).toBeGreaterThan(1000);
    expect(delay.max / 1e6).toBeLessThan(Math.max(500, took / 4));

    // Stopping the backend stops an export it's running.
    const stopped = busy.exportHar(path.join(dir, 'big-stopped.har'), bigs);
    const failed = expect(stopped).rejects.toThrow('The export was stopped.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    busyApi.close();
    others.splice(others.indexOf(busy), 1);
    await busy.stop();
    await failed;
    expect((await readdir(dir)).filter((f) => f.startsWith('big-stopped'))).toEqual([]);
  }, 120_000);
});
