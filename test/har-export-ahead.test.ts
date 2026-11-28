/**
 * Redacted HAR export learns every entry before it writes any (security review 2, F10): a value
 * bare in an early entry's body is hidden when only a later entry's body names it, and in a
 * request body when only the response names it. Real backend, real redaction worker.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const LATER = 'hunter2' + 'Correct9Horse';
const OWN = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const FRAME = 'fr4me' + 'T0k3nQw7Er9Ty';
const MANY = Array.from({ length: 1_500 }, (_, i) =>
  createHash('sha256').update(`pw${i}`).digest('base64url').slice(0, 18),
);

describe('Redacted export learns every entry first', () => {
  let dir: string;
  let backend: RunningBackend;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-har-ahead-'));
    backend = await startBackend({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
    });
    const at = (n: number) => new Date(Date.parse('2026-11-20T12:00:00.000Z') + n * 1000).toISOString();
    const text = (body: string) => ({ mimeType: 'text/plain', text: body });
    const json = (body: unknown) => ({ mimeType: 'application/json', text: JSON.stringify(body) });
    const entries = [
      {
        // Bare in its response body; only the next entry names it.
        startedDateTime: at(0),
        request: { method: 'GET', url: 'https://example.com/early', headers: [] },
        response: { status: 200, content: text(`note ${LATER}`) },
      },
      {
        startedDateTime: at(1),
        request: {
          method: 'POST',
          url: 'https://example.com/login',
          headers: [],
          postData: json({ password: LATER }),
        },
        response: { status: 204 },
      },
      {
        // Bare in its request body; only its own response names it.
        startedDateTime: at(2),
        request: {
          method: 'POST',
          url: 'https://example.com/own',
          headers: [],
          postData: text(`note ${OWN}`),
        },
        response: { status: 200, content: json({ access_token: OWN }) },
      },
      {
        startedDateTime: at(3),
        request: { method: 'GET', url: 'https://example.com/plain', headers: [] },
        response: { status: 200, content: text('nothing secret here at all') },
      },
      {
        // More passwords than an entry may hand on to others (HAND_BACK_SHARE).
        startedDateTime: at(5),
        request: { method: 'GET', url: 'https://example.com/many', headers: [] },
        response: { status: 200, content: json(MANY.map((password) => ({ password }))) },
      },
      {
        // One of the passwords past that limit, bare.
        startedDateTime: at(6),
        request: { method: 'GET', url: 'https://example.com/past', headers: [] },
        response: { status: 200, content: text(`note ${MANY.at(-1)}`) },
      },
      {
        // Bare in its first message; only the second names it.
        startedDateTime: at(4),
        _resourceType: 'websocket',
        request: { method: 'GET', url: 'wss://example.com/socket', headers: [] },
        response: { status: 101, statusText: 'Switching Protocols' },
        _webSocketMessages: [
          { type: 'receive', time: 1, opcode: 1, data: `note ${FRAME}` },
          { type: 'receive', time: 2, opcode: 1, data: JSON.stringify({ password: FRAME }) },
        ],
      },
    ];
    const source = path.join(dir, 'source.har');
    await writeFile(source, JSON.stringify({ log: { entries } }));
    const api = await apiClient(backend.apiPort);
    await backend.importHar(source);
    await vi.waitFor(() => expect(exchangesIn(api.messages)).toHaveLength(entries.length));
    for (const e of exchangesIn(api.messages)) ids[new URL(e.url).pathname.slice(1)] = e.id;
    api.close();
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const order = ['early', 'login', 'own', 'plain', 'socket'];
  // MANY's entries are exported only by the test about them.
  const exported = async (name: string, redact: boolean, which = order) => {
    const file = path.join(dir, name);
    const result = await backend.exportHar(
      file,
      which.map((k) => ids[k]!),
      { redact },
    );
    return { result, text: await readFile(file, 'utf8') };
  };

  it('hides a value in an entry written before the one that names it', async () => {
    const { result, text } = await exported('ahead.har', true);
    for (const secret of [LATER, OWN, FRAME]) expect(text.includes(secret), secret).toBe(false);
    const entries = JSON.parse(text).log.entries as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(entries[0]!.response.content.text).toMatch(/^note \S+$/);
    expect(entries[2]!.request.postData.text).toMatch(/^note \S+$/);
    expect(entries[4]!._webSocketMessages[0].data).toMatch(/^note \S+$/);
    // Text nothing names is written as it is.
    expect(entries[3]!.response.content.text).toBe('nothing secret here at all');
    expect(result.count).toBe(5);
    expect(result.redaction).toMatchObject({ dropped: 0, leftOut: 0, full: false });
  });

  it('hides it whatever the order, and alone with the entry that names it', async () => {
    const reversed = await exported('reversed.har', true, [...order].reverse());
    for (const secret of [LATER, OWN, FRAME]) expect(reversed.text.includes(secret), secret).toBe(false);
    const pair = await exported('pair.har', true, ['early', 'login']);
    expect(pair.text.includes(LATER)).toBe(false);
  });

  it('counts each value once, as found when written', async () => {
    const once = await exported('once.har', true);
    const again = await exported('again.har', true);
    // The same export twice: the same counts, not doubled by learning.
    expect(again.result.redaction).toEqual(once.result.redaction);
    // Each of the four entries that hold a secret is counted.
    expect(once.result.redaction!.requests).toBe(4);
  });

  it('writes an entry the same whatever comes before it', async () => {
    const after = await exported('after.har', true, ['many', 'past']);
    const before = await exported('before.har', true, ['past', 'many']);
    const past = (text: string) =>
      JSON.parse(text).log.entries.find((e: { request: { url: string } }) => e.request.url.endsWith('/past'))
        .response.content.text as string;
    expect(past(after.text)).toBe(past(before.text));
    // Past what one entry may hand on, the export says some may have been missed.
    expect(after.result.redaction!.full).toBe(true);
    expect(before.result.redaction!.full).toBe(true);
  });

  it('a value only an entry outside the export names is shown, as before', async () => {
    const alone = await exported('alone.har', true, ['early']);
    expect(alone.text).toContain(`note ${LATER}`);
  });

  it('without redaction, writes everything as captured', async () => {
    const { text } = await exported('plain.har', false);
    for (const secret of [LATER, OWN, FRAME]) expect(text.includes(secret), secret).toBe(true);
  });
});
