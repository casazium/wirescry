/**
 * Entry point for the backend, run by the main process as an Electron utility process.
 * It waits for a `start` message with its settings, then reports back the ports it's using.
 */
import type { BackendMessage, MainToBackendMessage } from '../shared/ipc';
import { backendPlugins } from '@wirescry/pro/backend';
import { startBackend, type RunningBackend } from './backend';
import { ipcEncryptor } from './secure-store';
import { selfCheck } from './self-check';

const parentPort = process.parentPort;
let backend: RunningBackend | undefined;
let starting = false;

const post = (message: BackendMessage): void => parentPort.postMessage(message);

// Plugins' secure stores are encrypted by the main process, which has safeStorage.
const encryptor = ipcEncryptor(post);

parentPort.on('message', async ({ data }: { data: MainToBackendMessage }) => {
  if (data?.type === 'crypto-result') {
    encryptor.receive(data);
    return;
  }
  if (data?.type === 'har') {
    const { id } = data;
    const job = !backend
      ? Promise.reject(new Error("Wirescry's backend is still starting."))
      : data.op === 'export'
        ? backend.exportHar(data.file, data.exchangeIds)
        : backend.importHar(data.file, data.name);
    job.then(
      (value) => post({ type: 'har-result', id, ok: true, value }),
      (error: unknown) =>
        post({
          type: 'har-result',
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }
  if (data?.type === 'shutdown') {
    void shutdown();
    return;
  }
  if (data?.type !== 'start' || starting) return;
  starting = true;
  try {
    backend = await startBackend({
      dataDir: data.dataDir,
      token: data.token,
      allowedOrigins: data.allowedOrigins,
      plugins: backendPlugins,
      pluginsEnabled: data.pluginsEnabled,
      // Only asked with a plugin built in, so the free build never touches the keychain.
      encryptor:
        backendPlugins.length > 0 && (await encryptor.available().catch(() => false)) ? encryptor : undefined,
      app: data.app,
    });
    post({
      type: 'ready',
      apiPort: backend.apiPort,
      proxyPort: backend.proxyPort,
      plugins: backend.pluginStatuses(),
      ...(data.selfCheck ? { selfCheck: await selfCheck() } : {}),
    });
  } catch (error) {
    post({ type: 'error', message: (error as Error).stack ?? String(error) });
    process.exit(1);
  }
});

// Report crashes on stderr, which the main process writes to the log, then exit so the
// supervisor restarts the backend.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.stack ?? error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', (reason as Error)?.stack ?? reason);
});

let stopping: Promise<void> | undefined;
async function shutdown(): Promise<void> {
  stopping ??= (async () => {
    await backend?.stop().catch(() => undefined);
    process.exit(0);
  })();
  return stopping;
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
