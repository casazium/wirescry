import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type BackendState, type LeverframeBridge } from '../shared/ipc';

/**
 * The only API the UI gets from Electron: how to reach the backend.
 * Everything else goes over the token-protected local API.
 */
const api: LeverframeBridge = {
  getBackendState: () => ipcRenderer.invoke(IPC.getBackendState),
  exportCertificate: () => ipcRenderer.invoke(IPC.exportCertificate),
  onBackendStateChanged(callback) {
    const listener = (_event: IpcRendererEvent, state: BackendState): void => callback(state);
    ipcRenderer.on(IPC.backendStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.backendStateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('leverframe', api);
