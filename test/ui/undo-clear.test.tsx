import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_CLEAR_MS, useUndoableClear } from '../../src/renderer/src/useUndoableClear';

describe('useUndoableClear', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the rows at once and deletes them when Undo runs out', () => {
    const remove = vi.fn();
    const { result } = renderHook(() => useUndoableClear(remove));
    act(() => result.current.clear(['a', 'b']));
    expect([...result.current.pending!.ids]).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(UNDO_CLEAR_MS - 1));
    expect(remove).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(remove).toHaveBeenCalledTimes(1);
    expect([...remove.mock.calls[0]![0]]).toEqual(['a', 'b']);
    expect(result.current.pending).toBeUndefined();
  });

  it('brings the rows back on Undo, and deletes nothing', () => {
    const remove = vi.fn();
    const { result } = renderHook(() => useUndoableClear(remove));
    act(() => result.current.clear(['a']));
    act(() => result.current.undo());
    expect(result.current.pending).toBeUndefined();
    act(() => vi.advanceTimersByTime(UNDO_CLEAR_MS * 2));
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes the earlier rows when Clear is used again, and offers Undo for the new ones', () => {
    const remove = vi.fn();
    const { result } = renderHook(() => useUndoableClear(remove));
    act(() => result.current.clear(['a']));
    act(() => result.current.clear(['b']));
    expect(remove).toHaveBeenCalledTimes(1);
    expect([...remove.mock.calls[0]![0]]).toEqual(['a']);
    expect([...result.current.pending!.ids]).toEqual(['b']);
    act(() => result.current.dismiss());
    expect([...remove.mock.calls[1]![0]]).toEqual(['b']);
    act(() => vi.advanceTimersByTime(UNDO_CLEAR_MS));
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('waits while the notice is held, and counts down again from the start after', () => {
    const remove = vi.fn();
    const { result } = renderHook(() => useUndoableClear(remove));
    act(() => result.current.clear(['a']));
    act(() => vi.advanceTimersByTime(UNDO_CLEAR_MS - 100));
    act(() => result.current.hold(true)); // pointer
    act(() => result.current.hold(true)); // focus
    act(() => result.current.hold(false));
    act(() => vi.advanceTimersByTime(UNDO_CLEAR_MS * 3));
    expect(remove).not.toHaveBeenCalled();
    act(() => result.current.hold(false));
    act(() => vi.advanceTimersByTime(UNDO_CLEAR_MS - 1));
    expect(remove).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('offers no Undo when there was nothing to clear', () => {
    const remove = vi.fn();
    const { result } = renderHook(() => useUndoableClear(remove));
    act(() => result.current.clear([]));
    expect(result.current.pending).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
  });
});
