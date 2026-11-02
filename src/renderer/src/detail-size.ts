import { useSyncExternalStore } from 'react';

/** Below this width the detail pane sits under the list. Matches the media query in styles.css. */
const STACKED_QUERY = '(max-width: 799px)';

export const MIN = 0.2;
export const MAX = 0.8;
export const clamp = (size: number): number => Math.min(MAX, Math.max(MIN, size));

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(STACKED_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Whether the window is narrow enough that the detail pane goes under the list. */
export function useStacked(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(STACKED_QUERY).matches);
}

/** The detail pane's saved share of the main area (0.2–0.8), or half if none is saved. */
export function loadDetailSize(key: string): number {
  try {
    const saved = Number(localStorage.getItem(key));
    if (saved >= MIN && saved <= MAX) return saved;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return 0.5;
}

export function saveDetailSize(key: string, size: number): void {
  try {
    localStorage.setItem(key, size.toFixed(3));
  } catch {
    // Not saved; the size still applies until the window closes.
  }
}
