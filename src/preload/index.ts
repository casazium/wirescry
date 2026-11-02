import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type BackendState, type MenuCommand, type WirescryBridge } from '../shared/ipc';

/**
 * The only API the UI gets from Electron: how to reach the backend, and system dialogs
 * for saving and opening files. Everything else goes over the token-protected local API.
 */
const api: WirescryBridge = {
  getBackendState: () => ipcRenderer.invoke(IPC.getBackendState),
  exportCertificate: () => ipcRenderer.invoke(IPC.exportCertificate),
  saveTextFile: (request) => ipcRenderer.invoke(IPC.saveTextFile, request),
  openTextFile: (request) => ipcRenderer.invoke(IPC.openTextFile, request),
  exportHar: (exchangeIds) => ipcRenderer.invoke(IPC.exportHar, exchangeIds),
  importHar: () => ipcRenderer.invoke(IPC.importHar),
  showMenu: (choices) => ipcRenderer.invoke(IPC.showMenu, choices),
  saveBody: (request) => ipcRenderer.invoke(IPC.saveBody, request),
  restartBackend: () => ipcRenderer.invoke(IPC.restartBackend),
  showLog: () => ipcRenderer.invoke(IPC.showLog),
  onMenuCommand(callback) {
    const listener = (_event: IpcRendererEvent, command: MenuCommand): void => callback(command);
    ipcRenderer.on(IPC.menuCommand, listener);
    return () => ipcRenderer.removeListener(IPC.menuCommand, listener);
  },
  setMenuState: (state) => ipcRenderer.send(IPC.menuState, state),
  onBackendStateChanged(callback) {
    const listener = (_event: IpcRendererEvent, state: BackendState): void => callback(state);
    ipcRenderer.on(IPC.backendStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.backendStateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('wirescry', api);
