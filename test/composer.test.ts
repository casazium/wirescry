import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { validateComposerRequest } from '../src/backend/composer';
import type { BodyContent, ComposerRequest, ExchangeDetail } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const request = (overrides: Partial<ComposerRequest>): ComposerRequest => ({
  method: 'GET',
  url: 'https://example.com/',
  headers: [],
  body: '',
  ...overrides,
});

describe('validateComposerRequest', () => {
  it('cleans up the method and drops headers Wirescry sets itself', () => {
    const valid = validateComposerRequest(
      request({
        method: ' post ',
        headers: [
          ['Accept', 'application/json'],
          ['Content-Length', '3'],
          ['Host', 'other.example'],
          ['Connection', 'close'],
        ],
      }),
    );
    expect(valid.method).toBe('POST');
    expect(valid.headers).toEqual([['Accept', 'application/json']]);
  });

  it.each([
    [{ method: 'GE T' }, 'Enter a method'],
    [{ method: 'CONNECT' }, "can't send CONNECT"],
    [{ url: 'example.com/path' }, 'Enter a full URL'],
    [{ url: 'ftp://example.com/' }, 'Enter a full URL'],
    [{ url: 'https://user:pass@example.com/' }, 'Authorization header'],
    [{ headers: [['Bad Name', 'x']] }, "isn't a valid header name"],
    [{ headers: [['X-Emoji', 'hi 👋']] }, 'plain text'],
    [{ headers: [['X-Split', 'a\r\nInjected: yes']] }, 'plain text'],
    [{ body: 'x'.repeat(512 * 1024 + 1) }, 'at most 512 KB'],
  ] as const)('refuses %j', (overrides, message) => {
    expect(() => validateComposerRequest(request(overrides as Partial<ComposerRequest>))).toThrow(message);
  });

  it('refuses things that aren’t a request', () => {
    expect(() => validateComposerRequest(null)).toThrow();
    expect(() => validateComposerRequest({ method: 'GET', url: 'https://a.example/', headers: 'x' })).toThrow(
      'Headers must be a list',
    );
  });
});

describe('composer', () => {
  let dataDir: string;
  let secure: Mockttp;
  let plain: Mockttp;
  let backend: RunningBackend;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-composer-'));
    const upstreamCA = await generateCACertificate();
    secure = getLocal({ https: upstreamCA });
    plain = getLocal();
    await Promise.all([secure.start(), plain.start()]);
    for (const server of [secure, plain]) {
      await server.forPost('/echo').thenCallback(async (req) => ({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: req.method,
          host: req.headers.host,
          token: req.headers['x-token'],
          length: req.headers['content-length'],
          body: await req.body.getText(),
        }),
      }));
      await server.forGet('/slow').thenTimeout();
    }
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
    });
  });

  afterAll(async () => {
    await backend?.stop();
    await Promise.all([secure?.stop(), plain?.stop()]);
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['https', () => `https://localhost:${secure.port}`],
    ['http', () => `http://localhost:${plain.port}`],
  ])('sends over %s through the proxy, recorded and marked as composed', async (_name, origin) => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({
        method: 'POST',
        url: `${origin()}/echo?from=composer`,
        headers: [
          ['X-Token', 'abc'],
          ['Content-Type', 'application/json'],
        ],
        body: '{"hi":"é"}',
      }),
    });
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId && e.responseSize !== undefined))
      .toMatchObject({ composed: true, status: 201, method: 'POST', path: '/echo?from=composer' });
    const body = await api.send<BodyContent>({ command: 'getBody', exchangeId, side: 'response' });
    expect(JSON.parse(Buffer.from(body.base64, 'base64').toString())).toEqual({
      method: 'POST',
      host: new URL(origin()).host,
      token: 'abc',
      length: String(Buffer.byteLength('{"hi":"é"}')),
      body: '{"hi":"é"}',
    });
    api.close();
  });

  it('records a composed request while recording is paused, and nothing else', async () => {
    const api = await apiClient(backend.apiPort);
    await api.send({ command: 'setPaused', paused: true });
    try {
      const { exchangeId } = await api.send<{ exchangeId: string }>({
        command: 'composeSend',
        request: request({ method: 'POST', url: `http://localhost:${plain.port}/echo?paused=1` }),
      });
      await expect.poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.status).toBe(201);
      const detail = await api.send<ExchangeDetail>({ command: 'getExchange', exchangeId });
      expect(detail.summary.composed).toBe(true);
    } finally {
      await api.send({ command: 'setPaused', paused: false });
      api.close();
    }
  });

  it('cancels a request waiting for its response', async () => {
    const api = await apiClient(backend.apiPort);
    const { exchangeId } = await api.send<{ exchangeId: string }>({
      command: 'composeSend',
      request: request({ url: `https://localhost:${secure.port}/slow` }),
    });
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(true);
    await expect
      .poll(() => exchangesIn(api.messages).find((e) => e.id === exchangeId)?.failure)
      .toBeDefined();
    expect(await api.send({ command: 'composeCancel', exchangeId })).toBe(false);
    api.close();
  });

  it('answers a bad request with the reason', async () => {
    const api = await apiClient(backend.apiPort);
    await expect(
      api.send({ command: 'composeSend', request: request({ url: 'not a url' }) }),
    ).rejects.toThrow('Enter a full URL');
    api.close();
  });
});
