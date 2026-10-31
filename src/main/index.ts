import { copyFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import { IPC, type BackendState, type ExportResult } from '../shared/ipc';
import { APP_ORIGIN, handleAppProtocol, registerAppSchemeAsPrivileged } from './app-protocol';
import { BackendSupervisor, type SecureStorage } from './backend-supervisor';
import { FileLogger, type LogLevel } from './logger';
import { buildMenu } from './menu';
import { clearScratch, exportHar, importHar } from './har-files';
import { openTextFile, saveTextFile } from './text-files';
import { Updater } from './updater';

/**
 * `--wirescry-self-test=<file>`: start the backend without a window, write what loaded
 * to <file> as JSON, and quit. The release workflow runs packaged builds this way to
 * check that Pro's bytecode loads on each platform. Use a throwaway --user-data-dir.
 */
const selfTestFile = app.commandLine.getSwitchValue('wirescry-self-test');
// A self-test's log goes in its throwaway data folder, not the user's real log.
if (selfTestFile) app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));

// Errors and warnings from every part of the app go to one local file, for support and debugging.
const logger = new FileLogger(app.getPath('logs'));
for (const [method, level] of [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(...args);
    logger.write('main', level, format(...args));
  };
}
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
console.log(
  `Wirescry ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${os.release()} ${process.arch})`,
);

// Set by electron-vite while running `npm run dev`.
// Development-only behavior is decided when the app is built, not at run time:
// app.isPackaged is false whenever the shipped app.asar is run with a stock Electron.
const isDevBuild = import.meta.env.DEV;
const devServerUrl = isDevBuild ? process.env.ELECTRON_RENDERER_URL : undefined;
const uiOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;

const CSP = [
  "default-src 'self'",
  // Vite's dev server injects an inline script for hot reload.
  devServerUrl ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self' ws://127.0.0.1:*${devServerUrl ? ' ws://localhost:*' : ''}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

registerAppSchemeAsPrivileged();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | undefined;
/**
 * Plugins' secure stores are encrypted with the OS keychain, through safeStorage. Not on
 * Linux without a keyring, where safeStorage falls back to a fixed, built-in password.
 */
function secureStorage(): SecureStorage | undefined {
  // Decided without touching the keychain (which can ask for a password): macOS and
  // Windows always have one; on Linux, Electron says which store it picked. The async
  // API keeps a keychain prompt from freezing the app while it waits.
  if (
    process.platform === 'linux' &&
    ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())
  ) {
    return undefined;
  }
  return {
    encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
    decrypt: async (base64) => (await safeStorage.decryptStringAsync(Buffer.from(base64, 'base64'))).result,
  };
}

const backend = new BackendSupervisor({
  dataDir: app.getPath('userData'),
  app: { version: app.getVersion(), releaseDate: import.meta.env.WIRESCRY_RELEASE_DATE },
  secureStorage,
  allowedOrigins: [uiOrigin],
  // Plugins built into this copy (such as Pro) always start. Pro checks its own license,
  // in its own code: this file is open source, so a check here could simply be removed.
  pluginsEnabled: true,
  logger,
});
logger.addSecret(backend.token);
const updater = new Updater(logger, () => mainWindow);

function isFromOurUi(url: string): boolean {
  try {
    // Not URL.origin: Node returns "null" for custom schemes like wirescry://.
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}` === uiOrigin;
  } catch {
    return false;
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: 'Wirescry',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow = window;

  window.once('ready-to-show', () => window.show());

  // Renderer errors and warnings, including uncaught exceptions, go to the log too.
  window.webContents.on('console-message', (details) => {
    const level: LogLevel | undefined =
      details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : undefined;
    if (level)
      logger.write('renderer', level, `${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.write(
      'renderer',
      'error',
      `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`,
    );
  });
  window.on('unresponsive', () => logger.write('renderer', 'warn', 'Window stopped responding'));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  // The UI never navigates or opens windows. Send links to the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isFromOurUi(url)) event.preventDefault();
  });

  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function runSelfTest(file: string): void {
  const finish = async (result: object, code: number): Promise<void> => {
    try {
      await writeFile(file, JSON.stringify({ version: app.getVersion(), arch: process.arch, ...result }));
    } finally {
      backend.stop();
      // app.exit skips will-quit, where the log is normally closed.
      logger.close();
      app.exit(code);
    }
  };
  const timer = setTimeout(
    () => void finish({ error: 'The backend took over 2 minutes to start.' }, 2),
    120_000,
  );
  backend.on('state', (state) => {
    if (state.state === 'starting') return;
    clearTimeout(timer);
    if (state.state === 'ready') void finish({ plugins: backend.plugins }, 0);
    else void finish({ error: state.message }, 1);
  });
  backend.start();
}

app.whenReady().then(() => {
  if (selfTestFile) {
    runSelfTest(path.resolve(selfTestFile));
    return;
  }
  void clearScratch().catch(() => undefined);
  Menu.setApplicationMenu(
    buildMenu({
      devTools: isDevBuild,
      showLogFile: () => {
        logger.flush();
        shell.showItemInFolder(logger.file);
      },
      checkForUpdates: () => updater.checkNow(),
    }),
  );

  // The UI may write to the clipboard (copy URL, copy as curl) and nothing else: no camera, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' && isFromOurUi(wc.getURL()));
  });

  if (devServerUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
      });
    });
  } else {
    handleAppProtocol(path.join(__dirname, '../renderer'), CSP);
  }

  ipcMain.handle(IPC.getBackendState, (event): BackendState => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return backend.state;
  });
  ipcMain.handle(IPC.exportCertificate, async (event): Promise<ExportResult> => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    const options = {
      title: 'Save Wirescry certificate',
      defaultPath: path.join(app.getPath('downloads'), 'Wirescry CA.pem'),
      filters: [{ name: 'Certificate', extensions: ['pem', 'crt'] }],
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return {};
    // Only the public certificate. The private key never leaves the data folder.
    await copyFile(path.join(app.getPath('userData'), 'ca.pem'), result.filePath);
    return { path: result.filePath };
  });
  ipcMain.handle(IPC.saveTextFile, (event, request: unknown) => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return saveTextFile(mainWindow, request);
  });
  ipcMain.handle(IPC.exportHar, (event, request: unknown) => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return exportHar(mainWindow, backend, request);
  });
  ipcMain.handle(IPC.importHar, (event) => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return importHar(mainWindow, backend);
  });
  ipcMain.handle(IPC.openTextFile, (event, request: unknown) => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return openTextFile(mainWindow, request);
  });
  backend.on('state', (state) => mainWindow?.webContents.send(IPC.backendStateChanged, state));
  backend.start();

  createWindow();
  updater.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quitting waits (a few seconds at most) for the backend to delete the bodies it stored on
// disk, and clears HAR scratch files, so captured traffic doesn't outlast the session.
// Installing an update quits at once, as before: the bodies are cleared when it restarts.
let cleanedUp = false;
app.on('before-quit', (event) => {
  if (cleanedUp) return;
  if (updater.installing) {
    cleanedUp = true;
    backend.stop();
    return;
  }
  event.preventDefault();
  cleanedUp = true;
  void Promise.allSettled([backend.shutdown(), clearScratch()]).finally(() => app.quit());
});
app.on('will-quit', () => logger.close());
