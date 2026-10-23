import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as mockttp from 'mockttp';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import type { ProxyStatus, ServerMessage } from '../src/shared/api';
import { apiClient, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** A plugin that mocks one hostname, echoes calls and remembers its host. */
function fakePlugin(name = 'fake'): BackendPlugin & { host?: BackendPluginHost } {
  const plugin: BackendPlugin & { host?: BackendPluginHost } = {
    name,
    async start(host) {
      plugin.host = host;
      await host.setProxyRules([
        {
          matchers: [new mockttp.matchers.HostnameMatcher('mocked.test')],
          steps: [new mockttp.requestSteps.FixedResponseStep(418, undefined, 'from the plugin')],
        },
      ]);
    },
    async handle(callName, args) {
      if (callName === 'fail') throw new Error('plugin said no');
      return { callName, args };
    },
  };
  return plugin;
}

describe('plugin host', () => {
  let dataDir: string;
  let backend: RunningBackend | undefined;

  const start = async (plugins: BackendPlugin[], pluginsEnabled = true): Promise<RunningBackend> => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-plugin-test-'));
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins,
      pluginsEnabled,
    });
    return backend;
  };

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  /** The latest status the backend has pushed, waiting for the first one if needed. */
  const statusOf = async (messages: ServerMessage[]): Promise<ProxyStatus> => {
    const latest = () =>
      (
        messages.filter((m) => m.type === 'hello' || m.type === 'status').at(-1) as
          { status: ProxyStatus } | undefined
      )?.status;
    await expect.poll(latest).toBeDefined();
    return latest()!;
  };

  it('applies plugin rules before pass-through, and keeps them across a proxy restart', async () => {
    const plugin = fakePlugin();
    const b = await start([plugin]);
    const mocked = await httpViaProxy(b.proxyPort, 'http://mocked.test/anything');
    expect(mocked).toMatchObject({ status: 418, body: 'from the plugin' });
    // The setup host still comes first.
    expect((await httpViaProxy(b.proxyPort, 'http://leverframe.internal/')).status).toBe(200);
    // Each plugin gets its own data folder.
    expect((await stat(plugin.host!.dataDir)).isDirectory()).toBe(true);
    expect(plugin.host!.dataDir).toBe(path.join(dataDir, 'plugins', 'fake'));

    const api = await apiClient(b.apiPort);
    await api.send({ command: 'setProxyPort', port: null }); // Restarts the proxy.
    expect((await httpViaProxy(b.proxyPort, 'http://mocked.test/again')).status).toBe(418);
    api.close();
  });

  it('replaces a plugin’s rules when it sets new ones', async () => {
    const plugin = fakePlugin();
    const b = await start([plugin]);
    await plugin.host!.setProxyRules([]);
    // No plugin rule now, so pass-through tries the real (nonexistent) host and fails.
    expect((await httpViaProxy(b.proxyPort, 'http://mocked.test/')).status).toBe(502);
  });

  it('routes calls to the plugin and events back to the UI', async () => {
    const plugin = fakePlugin();
    const b = await start([plugin]);
    const api = await apiClient(b.apiPort);
    expect((await statusOf(api.messages)).plugins).toEqual([{ name: 'fake', active: true }]);
    expect(await api.send({ command: 'plugin', plugin: 'fake', name: 'echo', args: { a: 1 } })).toEqual({
      callName: 'echo',
      args: { a: 1 },
    });
    await expect(api.send({ command: 'plugin', plugin: 'fake', name: 'fail' })).rejects.toThrow(
      'plugin said no',
    );
    await expect(api.send({ command: 'plugin', plugin: 'nope', name: 'x' })).rejects.toThrow(
      'No plugin called nope',
    );

    plugin.host!.emit('changed', { n: 2 });
    await expect
      .poll(() => api.messages.find((m) => m.type === 'plugin'))
      .toEqual({ type: 'plugin', plugin: 'fake', event: 'changed', data: { n: 2 } });
    api.close();
  });

  it('keeps plugins switched off when not allowed, with the reason', async () => {
    const plugin = fakePlugin();
    const b = await start([plugin], false);
    expect(plugin.host).toBeUndefined();
    const api = await apiClient(b.apiPort);
    expect((await statusOf(api.messages)).plugins).toEqual([
      { name: 'fake', active: false, reason: 'Pro needs a licence.' },
    ]);
    await expect(api.send({ command: 'plugin', plugin: 'fake', name: 'echo' })).rejects.toThrow(
      'Pro needs a licence.',
    );
    expect((await httpViaProxy(b.proxyPort, 'http://mocked.test/')).status).toBe(502);
    api.close();
  });

  it('isolates a plugin that fails to start', async () => {
    const broken: BackendPlugin = {
      name: 'broken',
      async start(host) {
        await host.setProxyRules([
          {
            matchers: [new mockttp.matchers.HostnameMatcher('mocked.test')],
            steps: [new mockttp.requestSteps.FixedResponseStep(418)],
          },
        ]);
        throw new Error('boom');
      },
      handle: async () => 'never',
    };
    const b = await start([broken, fakePlugin()]);
    const api = await apiClient(b.apiPort);
    expect((await statusOf(api.messages)).plugins).toEqual([
      { name: 'broken', active: false, reason: "Couldn't start: boom" },
      { name: 'fake', active: true },
    ]);
    await expect(api.send({ command: 'plugin', plugin: 'broken', name: 'x' })).rejects.toThrow(
      "Couldn't start",
    );
    // The working plugin's rule still applies; the broken one's was removed.
    expect((await httpViaProxy(b.proxyPort, 'http://mocked.test/')).body).toBe('from the plugin');
    api.close();
  });

  it('reports no plugins in the free build', async () => {
    const b = await start([]);
    const api = await apiClient(b.apiPort);
    expect((await statusOf(api.messages)).plugins).toEqual([]);
    api.close();
  });
});
