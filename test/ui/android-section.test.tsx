import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AndroidStatus, ProxyStatus } from '../../src/shared/api';
import { AndroidSection } from '../../src/renderer/src/AndroidSection';
import { status } from './fixtures';

const withAndroid = (android?: AndroidStatus): ProxyStatus => ({
  ...status(),
  ...(android ? { android } : {}),
});

describe('Android section', () => {
  it('is absent while Android setup is off', () => {
    const { container } = render(<AndroidSection status={withAndroid()} />);
    expect(container.textContent).toBe('');
  });

  it('lists devices with their state, and says what to do about each', () => {
    render(
      <AndroidSection
        status={withAndroid({
          state: 'ready',
          serverVersion: 41,
          devices: [
            {
              serial: 'emulator-5554',
              state: 'ready',
              label: 'Medium Phone API 37.0',
              emulator: true,
              apiLevel: 37,
              id: 'a',
            },
            { serial: 'R58', state: 'unauthorized', label: 'R58', emulator: false },
            {
              serial: 'old',
              state: 'ready',
              label: 'Nexus 5',
              emulator: false,
              apiLevel: 23,
              unsupported: 'Needs Android 7.',
            },
            { serial: 'bl', state: 'other', stateText: 'bootloader', label: 'bl', emulator: false },
          ],
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: /Android/ }).textContent).toContain('Experimental');
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Medium Phone API 37.0');
    expect(items[0]).toContain('Emulator · API 37 · emulator-5554');
    expect(items[1]).toMatch(/allow USB debugging/);
    expect(items[2]).toContain('Needs Android 7.');
    expect(items[3]).toContain('In bootloader mode.');
  });

  it('shows device names as text, never as markup', () => {
    render(
      <AndroidSection
        status={withAndroid({
          state: 'ready',
          devices: [{ serial: 'x', state: 'ready', label: '<img src=x onerror=alert(1)>', emulator: false }],
        })}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says how to get going with no devices, and with no adb', () => {
    const { rerender } = render(<AndroidSection status={withAndroid({ state: 'ready', devices: [] })} />);
    expect(screen.getByText(/No devices/)).toBeTruthy();
    rerender(
      <AndroidSection
        status={withAndroid({ state: 'no-adb', error: 'Install Android platform tools.', devices: [] })}
      />,
    );
    expect(screen.getByText('Install Android platform tools.')).toBeTruthy();
  });

  it('looks again on Check again, and shows a failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Android setup is off.'))
      .mockResolvedValue(undefined);
    render(
      <AndroidSection
        status={withAndroid({ state: 'failed', error: 'Lost touch.', devices: [] })}
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(send).toHaveBeenCalledWith({ command: 'androidRefresh' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Android setup is off.'));
  });

  it("can't check again while disconnected or still looking", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AndroidSection status={withAndroid({ state: 'ready', devices: [] })} send={send} connected={false} />,
    );
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<AndroidSection status={withAndroid({ state: 'starting', devices: [] })} send={send} />);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });
});
