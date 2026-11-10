/** The divider between the traffic list and the details (src/renderer/src/Splitter.tsx). */
import { useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Splitter } from '../../src/renderer/src/Splitter';

beforeAll(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

/** The splitter in a container of this size, keeping the size it's given as the app does. */
function Harness(props: {
  stacked?: boolean;
  width: number;
  height: number;
  start?: number;
  onCommit?: (size?: number) => void;
  sizes?: number[];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(props.start ?? 0.5);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) {
          Object.defineProperty(el, 'clientWidth', { value: props.width, configurable: true });
          Object.defineProperty(el, 'clientHeight', { value: props.height, configurable: true });
          el.getBoundingClientRect = () =>
            ({
              left: 0,
              top: 0,
              right: props.width,
              bottom: props.height,
              width: props.width,
              height: props.height,
            }) as DOMRect;
        }
      }}
    >
      <Splitter
        stacked={props.stacked ?? false}
        size={size}
        onChange={(next) => {
          props.sizes?.push(next);
          setSize(next);
        }}
        onCommit={props.onCommit ?? (() => undefined)}
        container={ref}
      />
    </div>
  );
}

const divider = () => screen.getByRole('separator', { name: 'Details size' });
const value = () => Number(divider().getAttribute('aria-valuenow'));
const range = () => [
  Number(divider().getAttribute('aria-valuemin')),
  Number(divider().getAttribute('aria-valuemax')),
];
const key = (k: string) => act(() => void fireEvent.keyDown(divider(), { key: k }));

describe('Splitter', () => {
  it('limits the details to 20–80%, narrowed so neither pane gets too small', () => {
    // Side by side, 1000 px: details at least 300 px, the list at least 336 px.
    render(<Harness width={1000} height={600} />);
    expect(range()).toEqual([30, 66]);
    expect(divider().getAttribute('aria-orientation')).toBe('vertical');
  });

  it('uses only 20–80% in a window too small for both minimums', () => {
    render(<Harness width={500} height={600} />);
    expect(range()).toEqual([20, 80]);
  });

  it('uses the stacked minimums when the details sit under the list', () => {
    // 140 px for the details, 96 px for the list, of 400 px.
    render(<Harness stacked width={700} height={400} />);
    expect(range()).toEqual([35, 76]);
    expect(divider().getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('shows a saved size that no longer fits at the nearest that does', () => {
    render(<Harness width={1000} height={600} start={0.2} />);
    expect(value()).toBe(30);
  });

  it('grows the details with the arrow toward the list, and shrinks them with the other', () => {
    const onCommit = vi.fn();
    render(<Harness width={2000} height={600} onCommit={onCommit} />);
    key('ArrowLeft');
    expect(value()).toBe(55);
    key('ArrowRight');
    key('ArrowRight');
    expect(value()).toBe(45);
    // Up and down do nothing side by side.
    key('ArrowUp');
    key('ArrowDown');
    expect(value()).toBe(45);
    fireEvent.keyUp(divider(), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledWith();
  });

  it('uses up and down when stacked', () => {
    render(<Harness stacked width={700} height={2000} />);
    key('ArrowUp');
    expect(value()).toBe(55);
    key('ArrowDown');
    expect(value()).toBe(50);
    key('ArrowLeft');
    expect(value()).toBe(50);
  });

  it('goes to either end with Home and End, and no further with the arrows', () => {
    render(<Harness width={1000} height={600} />);
    key('Home');
    expect(value()).toBe(30);
    key('ArrowRight');
    expect(value()).toBe(30);
    key('End');
    expect(value()).toBe(66);
    key('ArrowLeft');
    expect(value()).toBe(66);
  });

  it('keeps the keys it uses from scrolling the page', () => {
    render(<Harness width={1000} height={600} />);
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      let notPrevented = true;
      act(() => void (notPrevented = fireEvent.keyDown(divider(), { key: k })));
      expect(notPrevented, k).toBe(false);
    }
  });

  it('leaves other keys to the page', () => {
    render(<Harness width={1000} height={600} />);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => void divider().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(value()).toBe(50);
  });

  it('resets to half on a double-click, and saves that', () => {
    const onCommit = vi.fn();
    render(<Harness width={2000} height={600} start={0.7} onCommit={onCommit} />);
    act(() => void fireEvent.doubleClick(divider()));
    expect(value()).toBe(50);
    expect(onCommit).toHaveBeenCalledWith(0.5);
  });

  it('follows a drag with the main button, within the limits, and saves when it ends', () => {
    const onCommit = vi.fn();
    const sizes: number[] = [];
    const capture = vi.spyOn(HTMLElement.prototype, 'setPointerCapture');
    render(<Harness width={1000} height={600} onCommit={onCommit} sizes={sizes} />);
    let down = true;
    act(() => void (down = fireEvent.pointerDown(divider(), { button: 0, pointerId: 7 })));
    // The pointer is captured, so the drag ends (and saves) wherever it's let go; no text is selected.
    expect(capture).toHaveBeenCalledWith(7);
    expect(down).toBe(false);
    capture.mockRestore();
    // The details are to the right of the pointer: at x = 600, they take 40%.
    act(() => void fireEvent.pointerMove(divider(), { clientX: 600, clientY: 10 }));
    expect(value()).toBe(40);
    // Past the limit, it stops at the limit.
    act(() => void fireEvent.pointerMove(divider(), { clientX: 50, clientY: 10 }));
    expect(value()).toBe(66);
    expect(onCommit).not.toHaveBeenCalled();
    act(() => void fireEvent.lostPointerCapture(divider()));
    expect(onCommit).toHaveBeenCalledTimes(1);
    // After the drag, moving the pointer does nothing.
    act(() => void fireEvent.pointerMove(divider(), { clientX: 600, clientY: 10 }));
    expect(value()).toBe(66);
    act(() => void fireEvent.lostPointerCapture(divider()));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(sizes).toEqual([0.4, 0.664]);
  });

  it('follows the pointer up and down when stacked', () => {
    render(<Harness stacked width={700} height={1000} />);
    act(() => void fireEvent.pointerDown(divider(), { button: 0, pointerId: 1 }));
    // The details are below the pointer: at y = 300, they take 70%.
    act(() => void fireEvent.pointerMove(divider(), { clientX: 10, clientY: 300 }));
    expect(value()).toBe(70);
  });

  it('ignores a drag with another button', () => {
    const sizes: number[] = [];
    render(<Harness width={1000} height={600} sizes={sizes} />);
    let notPrevented = false;
    act(() => void (notPrevented = fireEvent.pointerDown(divider(), { button: 2, pointerId: 1 })));
    expect(notPrevented).toBe(true);
    act(() => void fireEvent.pointerMove(divider(), { clientX: 600, clientY: 10 }));
    expect(sizes).toEqual([]);
    expect(value()).toBe(50);
  });
});
