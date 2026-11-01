import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export function buildMenu(actions: {
  devTools: boolean;
  showLogFile(): void;
  checkForUpdates(): void;
  /** The same box on every system, so the version, copyright and website read alike. */
  showAbout(): void;
}): Menu {
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
    { role: 'fileMenu' },
    { role: 'editMenu' },
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
        { label: 'Show Log File', click: () => actions.showLogFile() },
        ...(isMac
          ? []
          : [{ type: 'separator' as const }, { label: 'About Wirescry', click: () => actions.showAbout() }]),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
