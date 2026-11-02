import { useRef } from 'react';
import { clamp, MAX, MIN } from './detail-size';

const STEP = 0.05;

/** Pixel limits that match .detail in styles.css: [details minimum, list minimum]. */
const SIDE_LIMITS = [300, 320] as const;
const STACKED_LIMITS = [140, 96] as const;

interface Props {
  stacked: boolean;
  /** The detail pane's share of the container. */
  size: number;
  onChange(size: number): void;
  container: React.RefObject<HTMLElement | null>;
}

/** The divider between the traffic list and the detail pane: drag it, or use the arrow keys. */
export function Splitter({ stacked, size, onChange, container }: Props): React.JSX.Element {
  const dragging = useRef(false);

  /** Keeps a size within both the 20–80% range and the panes' minimum sizes in pixels. */
  const fit = (next: number): number => {
    const rect = container.current?.getBoundingClientRect();
    const total = rect ? (stacked ? rect.height : rect.width) : 0;
    if (total <= 0) return clamp(next);
    const [detailMin, listMin] = stacked ? STACKED_LIMITS : SIDE_LIMITS;
    const low = Math.max(MIN, detailMin / total);
    const high = Math.min(MAX, (total - listMin) / total);
    return low > high ? clamp(next) : Math.min(high, Math.max(low, next));
  };

  const sizeAt = (event: React.PointerEvent): number | undefined => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return undefined;
    return stacked ? (rect.bottom - event.clientY) / rect.height : (rect.right - event.clientX) / rect.width;
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      className="splitter"
      aria-label="Details size"
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-valuemin={MIN * 100}
      aria-valuemax={MAX * 100}
      aria-valuenow={Math.round(size * 100)}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const next = sizeAt(event);
        if (next !== undefined) onChange(fit(next));
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onDoubleClick={() => onChange(0.5)}
      onKeyDown={(event) => {
        // The arrow toward the list makes the details bigger.
        const grow = stacked ? 'ArrowUp' : 'ArrowLeft';
        const shrink = stacked ? 'ArrowDown' : 'ArrowRight';
        let next: number | undefined;
        if (event.key === grow) next = size + STEP;
        else if (event.key === shrink) next = size - STEP;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 1;
        if (next === undefined) return;
        event.preventDefault();
        onChange(fit(next));
      }}
    />
  );
}
