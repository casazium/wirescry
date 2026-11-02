import { useEffect, useRef, useState } from 'react';
import { clamp, MAX, MIN } from './detail-size';

const STEP = 0.05;

/** Pixel limits that match .detail in styles.css: [details minimum, list minimum]. */
const SIDE_LIMITS = [300, 336] as const;
const STACKED_LIMITS = [140, 96] as const;

/** The id of the pane the divider sizes (DetailPane's aside). */
export const DETAIL_PANE_ID = 'exchange-details';

interface Props {
  stacked: boolean;
  /** The detail pane's saved share of the container. */
  size: number;
  onChange(size: number): void;
  /** Called when a drag or key press ends, to save the size (the latest one, unless given). */
  onCommit(size?: number): void;
  container: React.RefObject<HTMLElement | null>;
}

/** The divider between the traffic list and the detail pane: drag it, or use the arrow keys. */
export function Splitter({ stacked, size, onChange, onCommit, container }: Props): React.JSX.Element {
  const dragging = useRef(false);
  // The container's length along the divider's axis, so the limits below match what's on screen.
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = (): void => setTotal(stacked ? el.clientHeight : el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [container, stacked]);

  // The range the details can take here: 20–80%, narrowed by both panes' pixel minimums.
  // In a window too small for both minimums, only 20–80% applies.
  const [detailMin, listMin] = stacked ? STACKED_LIMITS : SIDE_LIMITS;
  let low = MIN;
  let high = MAX;
  if (total > 0 && detailMin + listMin <= total) {
    low = Math.max(MIN, detailMin / total);
    high = Math.min(MAX, (total - listMin) / total);
  }
  const fit = (next: number): number => (total > 0 ? Math.min(high, Math.max(low, next)) : clamp(next));
  // What's on screen, which can differ from the saved size after the window changes size.
  const shown = fit(size);

  const sizeAt = (event: React.PointerEvent): number | undefined => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return undefined;
    return stacked ? (rect.bottom - event.clientY) / rect.height : (rect.right - event.clientX) / rect.width;
  };

  const endDrag = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit();
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      className="splitter"
      aria-label="Details size"
      aria-controls={DETAIL_PANE_ID}
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-valuemin={Math.round(low * 100)}
      aria-valuemax={Math.round(high * 100)}
      aria-valuenow={Math.round(shown * 100)}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // No text selection while dragging. This also means a click doesn't focus the divider; Tab does.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const next = sizeAt(event);
        if (next !== undefined) onChange(fit(next));
      }}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => {
        onChange(fit(0.5));
        onCommit(fit(0.5));
      }}
      onKeyDown={(event) => {
        // The arrow toward the list makes the details bigger.
        const grow = stacked ? 'ArrowUp' : 'ArrowLeft';
        const shrink = stacked ? 'ArrowDown' : 'ArrowRight';
        let next: number | undefined;
        if (event.key === grow) next = shown + STEP;
        else if (event.key === shrink) next = shown - STEP;
        else if (event.key === 'Home') next = low;
        else if (event.key === 'End') next = high;
        if (next === undefined) return;
        event.preventDefault();
        onChange(fit(next));
      }}
      onKeyUp={() => onCommit()}
    />
  );
}
