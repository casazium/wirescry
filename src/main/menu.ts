import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand, MenuState } from '../shared/ipc';

export function buildMenu(actions: {
  devTools: boolean;
  showLogFile(): void;
  checkForUpdates(): void;
  /** The same box on every system, so the version, copyright and website read alike. */
  showAbout(): void;
  /** Sends a menu command to the window, e.g. Clear. */
  command(name: MenuCommand): void;
  openWebsite(): void;
  reportProblem(): void;
}): Menu {
  const command = (name: MenuCommand) => () => actions.command(name);
  const isMac = process.platform === 'darwin';
  const checkForUpdates: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => actions.checkForUpdates(),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: 'About Wirescry', click: () => actions.showAbout() },
              checkForUpdates,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        // Enabled once the window says the proxy is running (see updateMenu).
        {
          id: 'import-har',
          label: 'Import HAR…',
          accelerator: 'CmdOrCtrl+O',
          enabled: false,
          click: command('import-har'),
        },
        {
          id: 'export-har',
          label: 'Export HAR…',
          accelerator: 'CmdOrCtrl+S',
          enabled: false,
          click: command('export-har'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Capture',
      submenu: [
        {
          id: 'pause-recording',
          label: 'Pause Recording',
          type: 'checkbox',
          accelerator: 'CmdOrCtrl+P',
          enabled: false,
          click: command('toggle-recording'),
        },
        { id: 'clear', label: 'Clear', accelerator: 'CmdOrCtrl+K', enabled: false, click: command('clear') },
        { type: 'separator' },
        { id: 'find', label: 'Find', accelerator: 'CmdOrCtrl+F', click: command('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(actions.devTools ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [checkForUpdates, { type: 'separator' as const }]),
        { label: 'Wirescry Website', click: () => actions.openWebsite() },
        { label: 'Report a Problem…', click: () => actions.reportProblem() },
        { type: 'separator' },
        { label: 'Show Log File', click: () => actions.showLogFile() },
        ...(isMac
          ? []
          : [{ type: 'separator' as const }, { label: 'About Wirescry', click: () => actions.showAbout() }]),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** Enables and ticks the menu's commands to match the window, e.g. no Export with nothing to export. */
export function updateMenu(menu: Menu, state: MenuState): void {
  const set = (id: string, enabled: boolean, checked?: boolean): void => {
    const item = menu.getMenuItemById(id);
    if (!item) return;
    item.enabled = enabled;
    if (checked !== undefined) item.checked = checked;
  };
  set('import-har', state.connected);
  set('export-har', state.connected && state.canExport);
  set('pause-recording', state.connected, state.paused);
  set('clear', state.connected);
}
