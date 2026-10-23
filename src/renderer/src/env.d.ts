/// <reference types="vite/client" />
import type { WirescryBridge } from '../../shared/ipc';

declare global {
  interface Window {
    wirescry: WirescryBridge;
  }
}
