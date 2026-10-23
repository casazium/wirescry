import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as mockttp from 'mockttp';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BackendPlugin, BackendPluginHost } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { ProxyStatus, ServerMessage } from '../src/shared/api';
import { apiClient, httpViaProxy, TOKEN, UI_ORIGIN } from './helpers';

/** A plugin that mocks one hostname, echoes calls and remembers its host. */
function fakePlugin(name = 'fake'): BackendPlugin & { host?: BackendPluginHost } {
  const plugin: BackendPlugin & { host?: BackendPluginHost } = {
    name,
    apiVersion: PLUGIN_API_VERSION,
    async start(host) {
      plugin.host = host;
      await host.setProxyRules([
        {
          id: 'teapot',
          label: 'Teapot',
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

  const start = async (
    plugins: BackendPlugin[],
    pluginsEnabled = true,
    pluginStartTimeoutMs?: number,
  ): Promise<RunningBackend> => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-plugin-test-'));
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins,
      pluginsEnabled,
      pluginStartTimeoutMs,
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
      apiVersion: PLUGIN_API_VERSION,
      async start(host) {
        await host.setProxyRules([
          {
            id: 'r',
            label: 'r',
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

  it('marks requests a plugin rule handled', async () => {
    const b = await start([fakePlugin()]);
    const api = await apiClient(b.apiPort);
    await httpViaProxy(b.proxyPort, 'http://mocked.test/x');
    await expect
      .poll(
        () =>
          api.messages
            .flatMap((m) => (m.type === 'exchanges' ? m.exchanges : []))
            .find((e) => e.status === 418)?.handledBy,
      )
      .toEqual({ plugin: 'fake', ruleId: 'teapot', label: 'Teapot' });
    api.close();
  });

  it('describes a request a rule closed without answering', async () => {
    const plugin: BackendPlugin = {
      name: 'closer',
      apiVersion: PLUGIN_API_VERSION,
      async start(host) {
        await host.setProxyRules([
          {
            id: 'c',
            label: 'Drop it',
            matchers: [new mockttp.matchers.HostnameMatcher('mocked.test')],
            steps: [new mockttp.requestSteps.CloseConnectionStep()],
          },
        ]);
      },
      handle: async () => undefined,
    };
    const b = await start([plugin]);
    const api = await apiClient(b.apiPort);
    await httpViaProxy(b.proxyPort, 'http://mocked.test/').catch(() => undefined);
    await expect
      .poll(
        () =>
          api.messages.flatMap((m) => (m.type === 'exchanges' ? m.exchanges : [])).find((e) => e.failure)
            ?.failure,
      )
      .toMatchObject({ kind: 'rule', message: expect.stringContaining('Drop it') });
    api.close();
  });

  it("ignores a plugin rule's priority, so the setup page always comes first", async () => {
    const greedy: BackendPlugin = {
      name: 'greedy',
      apiVersion: PLUGIN_API_VERSION,
      async start(host) {
        await host.setProxyRules([
          {
            id: 'all',
            label: 'all',
            priority: 100,
            matchers: [new mockttp.matchers.WildcardMatcher()],
            steps: [new mockttp.requestSteps.FixedResponseStep(418)],
          } as Parameters<BackendPluginHost['setProxyRules']>[0][number],
        ]);
      },
      handle: async () => undefined,
    };
    const b = await start([greedy]);
    expect((await httpViaProxy(b.proxyPort, 'http://leverframe.internal/')).status).toBe(200);
    expect((await httpViaProxy(b.proxyPort, 'http://other.test/')).status).toBe(418);
  });

  it('refuses plugins with a bad name or another API version', async () => {
    const b = await start([
      { ...fakePlugin('Bad Name') },
      { ...fakePlugin('old'), apiVersion: PLUGIN_API_VERSION + 1 },
      fakePlugin('fake'),
      fakePlugin('fake'),
    ]);
    const api = await apiClient(b.apiPort);
    const plugins = (await statusOf(api.messages)).plugins;
    expect(plugins.map((p) => [p.name, p.active])).toEqual([
      ['Bad Name', false],
      ['old', false],
      ['fake', true],
      ['fake', false],
    ]);
    expect(plugins[1]!.reason).toContain('plugin API version');
    api.close();
  });

  it('fails a plugin that takes too long to start, and refuses calls until it has started', async () => {
    let release!: () => void;
    let slowHost: BackendPluginHost | undefined;
    const slow: BackendPlugin = {
      name: 'slow',
      apiVersion: PLUGIN_API_VERSION,
      start: (host) => {
        slowHost = host;
        return new Promise<void>((resolve) => (release = resolve));
      },
      handle: async () => 'ok',
    };
    const starting = start([slow], true, 300);
    // The API is up before plugins have started; calls are refused meanwhile.
    await expect.poll(() => slowHost).toBeDefined();
    const b = await starting;
    const api = await apiClient(b.apiPort);
    const status = (await statusOf(api.messages)).plugins[0]!;
    expect(status.active).toBe(false);
    expect(status.reason).toContain("didn't finish starting");
    // Starting late doesn't revive it, and it can't add rules any more.
    release();
    await slowHost!.setProxyRules([
      {
        id: 'x',
        label: 'x',
        matchers: [new mockttp.matchers.HostnameMatcher('mocked.test')],
        steps: [new mockttp.requestSteps.FixedResponseStep(418)],
      },
    ]);
    expect((await httpViaProxy(b.proxyPort, 'http://mocked.test/')).status).toBe(502);
    await expect(api.send({ command: 'plugin', plugin: 'slow', name: 'x' })).rejects.toThrow("didn't finish");
    api.close();
  });

  it('survives a plugin whose stop throws', async () => {
    const plugin = {
      ...fakePlugin(),
      stop: () => {
        throw new Error('nope');
      },
    };
    await start([plugin]);
    await backend!.stop();
    backend = undefined;
  });
});
