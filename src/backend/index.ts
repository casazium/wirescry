/**
 * Entry point for the backend, run by the main process as an Electron utility process.
 * It waits for a `start` message with its settings, then reports back the ports it's using.
 */
import type { BackendMessage, BackendStartMessage } from '../shared/ipc';
import { startBackend, type RunningBackend } from './backend';

const parentPort = process.parentPort;
let backend: RunningBackend | undefined;

const post = (message: BackendMessage): void => parentPort.postMessage(message);

parentPort.on('message', async ({ data }: { data: BackendStartMessage }) => {
  if (data?.type !== 'start' || backend) return;
  try {
    backend = await startBackend({
      dataDir: data.dataDir,
      token: data.token,
      allowedOrigins: data.allowedOrigins,
    });
    post({ type: 'ready', apiPort: backend.apiPort, proxyPort: backend.proxyPort });
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

const shutdown = async (): Promise<void> => {
  await backend?.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
