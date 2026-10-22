import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { IPC, type BackendState, type ExportResult } from '../shared/ipc';
import { APP_ORIGIN, handleAppProtocol, registerAppSchemeAsPrivileged } from './app-protocol';
import { BackendSupervisor } from './backend-supervisor';
import { buildMenu } from './menu';

// Set by electron-vite while running `npm run dev`.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
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
const backend = new BackendSupervisor({
  dataDir: app.getPath('userData'),
  allowedOrigins: [uiOrigin],
});

function isFromOurUi(url: string): boolean {
  try {
    // Not URL.origin: Node returns "null" for custom schemes like leverframe://.
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
    title: 'Leverframe',
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());

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
      title: 'Save Leverframe certificate',
      defaultPath: path.join(app.getPath('downloads'), 'Leverframe CA.pem'),
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
  backend.on('state', (state) => mainWindow?.webContents.send(IPC.backendStateChanged, state));
  backend.start();

  createWindow();

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

app.on('before-quit', () => backend.stop());
