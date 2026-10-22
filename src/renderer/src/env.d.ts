/// <reference types="vite/client" />
import type { LeverframeBridge } from '../../shared/ipc';

declare global {
  interface Window {
    leverframe: LeverframeBridge;
  }
}
