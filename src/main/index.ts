import { copyFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { IPC, type BackendState, type ExportResult, type MenuState } from '../shared/ipc';
import { APP_ORIGIN, handleAppProtocol, registerAppSchemeAsPrivileged } from './app-protocol';
import { BackendSupervisor, type SecureStorage } from './backend-supervisor';
import { FileLogger, type LogLevel } from './logger';
import { buildMenu, updateMenu } from './menu';
import { aboutDetail, DOCS_URL, ISSUES_URL, WEBSITE } from './about';
import { checkMenuChoices, contextMenuItems } from './context-menu';
import { guarded, isOnOrigin } from './ipc-guard';
import { clearScratch, exportHar, importHar, saveBody } from './har-files';
import { chooseFilePath, openTextFile, saveTextFile } from './text-files';
import { Updater } from './updater';

/**
 * `--wirescry-self-test=<file>`: start the backend without a window, write what loaded
 * to <file> as JSON, and quit. The release workflow runs packaged builds this way to
 * check that Pro's bytecode loads on each platform, and that the backend survives its
 * self-check (src/backend/self-check.ts). Use a throwaway --user-data-dir.
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

// A second copy only hands over to the first and quits. It must not touch the first
// copy's files: the scratch folder at start, or the bodies folder on quit.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
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
  selfCheck: !!selfTestFile,
});
logger.addSecret(backend.token);
const updater = new Updater(logger, () => mainWindow);

const isFromOurUi = (url: string): boolean => isOnOrigin(url, uiOrigin);
/** Registers an IPC handler that only Wirescry's own UI can call. */
const handle = <A extends unknown[], R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: A) => R,
): void =>
  ipcMain.handle(channel, guarded(uiOrigin, handler) as (event: IpcMainInvokeEvent, ...args: unknown[]) => R);

/** About Wirescry: in the app menu on macOS, under Help on Windows and Linux. */
async function showAbout(): Promise<void> {
  const options = {
    type: 'info' as const,
    title: 'About Wirescry',
    message: 'Wirescry',
    detail: aboutDetail({
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    }),
    buttons: ['OK', 'Open Website'],
    defaultId: 0,
    cancelId: 0,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (response === 1) void shell.openExternal(WEBSITE);
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
  // Windows logging off or shutting down skips before-quit. Delete what we can now; the
  // next start empties the rest.
  window.on('session-end', () => backend.removeBodiesSync());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
    // Nothing for the menu's commands to act on until a window opens again.
    const menu = Menu.getApplicationMenu();
    if (menu) updateMenu(menu, { connected: false, canExport: false, paused: false });
  });

  // Right-click: the usual edit menu in text fields, and Copy for selected text.
  window.webContents.on('context-menu', (_event, params) => {
    const items = contextMenuItems(params);
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window });
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
  // Generous, so a slow start (an Intel build under Rosetta) is measured rather than cut
  // off; scripts/self-test-packaged.mjs decides what's too slow from backendStartMs.
  const startedAt = Date.now();
  const timer = setTimeout(
    () => void finish({ error: 'The backend took over 10 minutes to start.' }, 2),
    600_000,
  );
  let starts = 0;
  backend.on('state', (state) => {
    if (state.state === 'starting') {
      // A second start means the backend died and the supervisor is restarting it.
      if (++starts > 1) {
        clearTimeout(timer);
        void finish({ error: 'The backend stopped unexpectedly (see the log).' }, 1);
      }
      return;
    }
    clearTimeout(timer);
    const problems = backend.selfCheckProblems ?? ['the backend ran no self-check'];
    if (state.state !== 'ready') void finish({ error: state.message }, 1);
    else if (problems.length > 0) void finish({ error: `Self-check: ${problems.join('; ')}` }, 1);
    else void finish({ plugins: backend.plugins, backendStartMs: Date.now() - startedAt }, 0);
  });
  backend.start();
}

app.whenReady().then(() => {
  if (selfTestFile) {
    runSelfTest(path.resolve(selfTestFile));
    return;
  }
  if (!isFirstInstance) return;
  void clearScratch().catch(() => undefined);
  const appMenu = buildMenu({
    devTools: isDevBuild,
    showLogFile: () => {
      logger.flush();
      shell.showItemInFolder(logger.file);
    },
    checkForUpdates: () => updater.checkNow(),
    showAbout: () => void showAbout(),
    command: (name) => mainWindow?.webContents.send(IPC.menuCommand, name),
    openDocumentation: () => void shell.openExternal(DOCS_URL),
    openWebsite: () => void shell.openExternal(WEBSITE),
    reportProblem: () => void shell.openExternal(ISSUES_URL),
  });
  Menu.setApplicationMenu(appMenu);
  // The window says what's possible, so menu commands are enabled and ticked to match.
  ipcMain.on(IPC.menuState, (event, state: unknown) => {
    if (!isFromOurUi(event.senderFrame?.url ?? '')) return;
    const s = state as Partial<MenuState> | null;
    if (typeof s !== 'object' || s === null) return;
    updateMenu(appMenu, {
      connected: s.connected === true,
      canExport: s.canExport === true,
      paused: s.paused === true,
    });
  });

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

  handle(IPC.getBackendState, (): BackendState => {
    return backend.state;
  });
  handle(IPC.exportCertificate, async (): Promise<ExportResult> => {
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
  handle(IPC.saveTextFile, (_event, request: unknown) => {
    return saveTextFile(mainWindow, request);
  });
  handle(IPC.exportHar, (_event, request: unknown) => {
    return exportHar(mainWindow, backend, request);
  });
  handle(IPC.importHar, () => {
    return importHar(mainWindow, backend);
  });
  handle(IPC.openTextFile, (_event, request: unknown) => {
    return openTextFile(mainWindow, request);
  });
  handle(IPC.chooseFilePath, (_event, request: unknown) => {
    return chooseFilePath(mainWindow, request);
  });
  handle(IPC.saveBody, (_event, request: unknown) => {
    return saveBody(mainWindow, backend, request);
  });
  handle(IPC.restartBackend, () => {
    backend.restart();
  });
  handle(IPC.showLog, () => {
    // So the file has the latest lines, e.g. about a crash.
    logger.flush();
    shell.showItemInFolder(logger.file);
  });
  // A menu the UI builds, such as the one on a traffic row. Resolves with the chosen id.
  handle(IPC.showMenu, (_event, request: unknown) => {
    const choices = checkMenuChoices(request);
    return new Promise<string | undefined>((resolve) => {
      const menu = Menu.buildFromTemplate(
        choices.map((choice) =>
          'separator' in choice
            ? { type: 'separator' as const }
            : {
                // A lone & would mark a Windows access key.
                label: choice.label.replaceAll('&', '&&'),
                enabled: choice.enabled !== false,
                click: () => resolve(choice.id),
              },
        ),
      );
      // The close callback can come before the click handler, so give the click a moment.
      menu.popup({
        ...(mainWindow ? { window: mainWindow } : {}),
        callback: () => setTimeout(() => resolve(undefined), 100),
      });
    });
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
  if (cleanedUp || !isFirstInstance) return;
  if (updater.installing) {
    cleanedUp = true;
    backend.stop();
    return;
  }
  event.preventDefault();
  cleanedUp = true;
  // Scratch files last: the backend may be writing an export until it stops.
  void backend
    .shutdown()
    .catch(() => undefined)
    .then(() => clearScratch())
    .catch(() => undefined)
    .finally(() => app.quit());
});
app.on('will-quit', () => logger.close());
