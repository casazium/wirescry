import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a Clear can be undone. */
export const UNDO_CLEAR_MS = 10_000;

export interface PendingClear {
  /** The rows the Clear hid. */
  ids: ReadonlySet<string>;
}

export interface UndoableClear {
  /** The Clear that can still be undone, if any. */
  pending?: PendingClear;
  /** Hides these rows, and deletes them once Undo is no longer offered. */
  clear(ids: readonly string[]): void;
  /** Shows the hidden rows again. */
  undo(): void;
  /** Deletes the hidden rows now and stops offering Undo. */
  dismiss(): void;
  /** Stops the countdown while on, e.g. while the pointer is over Undo; restarts it when all are off. */
  hold(on: boolean): void;
}

/**
 * Clear hides the rows at once and deletes them later: UNDO_CLEAR_MS after the pointer and
 * focus leave the notice, or at the next Clear. Rows that arrive in the meantime aren't touched.
 */
export function useUndoableClear(remove: (ids: ReadonlySet<string>) => void): UndoableClear {
  const [pending, setPending] = useState<PendingClear>();
  const pendingRef = useRef<PendingClear | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holds = useRef(0);
  const removeRef = useRef(remove);
  useEffect(() => {
    removeRef.current = remove;
  });

  const settle = useCallback((keep: boolean) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const current = pendingRef.current;
    pendingRef.current = undefined;
    setPending(undefined);
    if (current && !keep) removeRef.current(current.ids);
  }, []);

  const clear = useCallback(
    (ids: readonly string[]) => {
      settle(false);
      if (ids.length === 0) return;
      const next = { ids: new Set(ids) };
      pendingRef.current = next;
      setPending(next);
      holds.current = 0;
      timer.current = setTimeout(() => settle(false), UNDO_CLEAR_MS);
    },
    [settle],
  );

  const hold = useCallback(
    (on: boolean) => {
      holds.current = Math.max(0, holds.current + (on ? 1 : -1));
      if (!pendingRef.current) return;
      clearTimeout(timer.current);
      timer.current = holds.current === 0 ? setTimeout(() => settle(false), UNDO_CLEAR_MS) : undefined;
    },
    [settle],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    pending,
    clear,
    undo: useCallback(() => settle(true), [settle]),
    dismiss: useCallback(() => settle(false), [settle]),
    hold,
  };
}
