import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin } from '../src/plugin-api/backend';
import type { ExchangeSummary } from '../src/shared/api';
import { apiClient, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/**
 * Runs the real Pro module inside the real backend. Pro is private, so this only runs
 * when WIRESCRY_PRO_DIR points at a wirescry-pro checkout.
 */
const proDir = process.env.WIRESCRY_PRO_DIR;

describe.skipIf(!proDir)('Pro in the backend', () => {
  let dataDir: string;
  let backend: RunningBackend | undefined;

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('mocks matching requests and marks them with the rule', async () => {
    setFlagsFromString('--enable-experimental-regexp-engine'); // As src/backend/index.ts does.
    const { backendPlugins } = (await import(path.resolve(proDir!, 'src/backend/index.ts'))) as {
      backendPlugins: BackendPlugin[];
    };
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-pro-int-'));
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: backendPlugins,
      pluginsEnabled: true,
    });
    const api = await apiClient(backend.apiPort);
    await expect
      .poll(
        async () =>
          (await api
            .send({ command: 'plugin', plugin: 'pro', name: 'rules.list' })
            .catch(() => undefined)) !== undefined,
      )
      .toBe(true);

    await api.send({
      command: 'plugin',
      plugin: 'pro',
      name: 'rules.create',
      args: {
        rule: {
          id: 'r1',
          name: 'Users mock',
          enabled: true,
          match: { host: '*.mocked.test', path: '/users/*' },
          action: { type: 'mock', status: 200, headers: [['content-type', 'application/json']], body: '[]' },
        },
      },
    });
    const result = await httpViaProxy(backend.proxyPort, 'http://api.mocked.test/users/42?x=1');
    expect(result).toMatchObject({ status: 200, body: '[]' });
    // Another path passes through (and fails, as the host doesn't exist).
    expect((await httpViaProxy(backend.proxyPort, 'http://api.mocked.test/orders')).status).toBe(502);

    const summaries = (): ExchangeSummary[] =>
      api.messages.flatMap((m) => (m.type === 'exchanges' ? m.exchanges : []));
    await expect
      .poll(() => summaries().find((e) => e.path.startsWith('/users'))?.handledBy)
      .toEqual({ plugin: 'pro', ruleId: 'r1', label: 'Users mock' });
    api.close();
  });
});
