/** The search syntax guide beside the search box (src/renderer/src/FilterHelp.tsx). */
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterHelp } from '../../src/renderer/src/FilterHelp';
import { QUERY_FIELDS } from '../../src/shared/query';

function open() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const toggle = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={toggle}>?</button>
      <input aria-label="Elsewhere" />
      <FilterHelp onPick={onPick} onClose={onClose} toggle={toggle} />
    </>,
  );
  return { onPick, onClose, toggle };
}
const dialog = () => screen.getByRole('dialog', { name: 'Search syntax' });

describe('FilterHelp', () => {
  it('takes focus on its first example when it opens', () => {
    open();
    expect(document.activeElement?.textContent).toBe('status>=400');
  });

  it('fills in the search with an example', () => {
    const { onPick } = open();
    fireEvent.click(screen.getByRole('button', { name: 'path~login' }));
    expect(onPick).toHaveBeenCalledWith('path~login');
  });

  it('lists every field the search knows', () => {
    open();
    expect(dialog().textContent).toContain(`Fields: ${QUERY_FIELDS.join(', ')}.`);
  });

  it('closes with ×, giving focus back', () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('closes with Escape inside it, giving focus back, and keeps Escape from going further', () => {
    const { onClose } = open();
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    try {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      expect(onClose).toHaveBeenCalledWith(true);
      expect(event.defaultPrevented).toBe(true);
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener('keydown', outer);
    }
  });

  it('closes with Escape from elsewhere without taking focus back, and lets Escape do its job there', () => {
    const { onClose } = open();
    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' });
    elsewhere.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    elsewhere.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledWith(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores other keys', () => {
    const { onClose } = open();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a click outside it, but not inside it or on its own button', () => {
    const { onClose, toggle } = open();
    fireEvent.pointerDown(dialog());
    fireEvent.pointerDown(toggle.current!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Elsewhere' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('stops listening once closed', () => {
    const onClose = vi.fn();
    const { unmount } = render(<FilterHelp onPick={vi.fn()} onClose={onClose} toggle={createRef()} />);
    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });
});
