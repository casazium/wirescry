import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Each test starts with an empty document.
afterEach(() => cleanup());

// jsdom has no ResizeObserver; components only use it to measure, so a no-op is enough.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;
