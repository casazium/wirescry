/**
 * Entry point for the backend, run by the main process as an Electron utility process.
 * It waits for a `start` message with its settings, then reports back the ports it's using.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { androidUndoneFile, type BackendMessage, type MainToBackendMessage } from '../shared/ipc';
import { backendPlugins } from '@wirescry/pro/backend';
import { startBackend, type RunningBackend } from './backend';
import { ipcEncryptor } from './secure-store';
import { selfCheck } from './self-check';

// Everything above (this bundle and Pro, compiled eagerly: see backend-v8-flags.json) has
// loaded by now. Logged with each startup step, as milliseconds since the process began.
const loadedAt = performance.now();
/** Set by the bundle's first line (see electron.vite.config.ts), before its imports run. */
const firstLineAt = (globalThis as { __wirescryBackendFirstLineAt?: number }).__wirescryBackendFirstLineAt;
/** Each step and when it finished, also sent with `ready`: the log can lag behind it. */
const startup: Array<[step: string, ms: number]> = [];
const mark = (step: string, at = performance.now()): void => {
  startup.push([step, Math.round(at)]);
  console.log(`Startup: ${step} at ${Math.round(at)} ms`);
};

const parentPort = process.parentPort;
let backend: RunningBackend | undefined;
let starting = false;
let dataDir: string | undefined;

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
        : data.op === 'body'
          ? backend.saveBody(data.file, data.exchangeId, data.side)
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
  if (data?.type === 'android-undo') {
    const { id } = data;
    const timeoutMs = Math.min(Math.max(Number(data.timeoutMs) || 0, 0), 10_000);
    void (backend?.stopAndroid(timeoutMs) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (data.markDone && dataDir) {
          const file = androidUndoneFile(dataDir, id);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, '');
        }
      })
      .catch(() => undefined)
      .then(() => post({ type: 'android-undone', id }));
    return;
  }
  if (data?.type !== 'start' || starting) return;
  starting = true;
  dataDir = data.dataDir;
  if (firstLineAt !== undefined) mark('first line of the backend ran', firstLineAt);
  mark('dependencies and Pro loaded', loadedAt);
  mark('start requested');
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
      notify: (title, body) => post({ type: 'notify', title, body }),
      // The self-test checks what loads: it has no business with the user's devices.
      android: data.selfCheck ? false : 'setting',
      onStartupStep: (name) => mark(`${name} done`),
    });
    const checked = data.selfCheck ? await selfCheck() : undefined;
    if (checked) mark('self-check done');
    post({
      type: 'ready',
      apiPort: backend.apiPort,
      proxyPort: backend.proxyPort,
      plugins: backend.pluginStatuses(),
      ...(checked ? { selfCheck: checked } : {}),
      startup,
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
