import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserInfo, ProxyStatus } from '../../src/shared/api';
import { SetupPage } from '../../src/renderer/src/SetupPage';
import { status } from './fixtures';

const chrome: BrowserInfo = { id: 'chrome', name: 'Google Chrome', kind: 'chromium' };
const firefox: BrowserInfo = { id: 'firefox', name: 'Firefox', kind: 'firefox' };

const setupStatus = (browsers: BrowserInfo[]): ProxyStatus => ({
  ...status(),
  browsers,
  certificate: {
    commonName: 'Wirescry CA (test)',
    spkiFingerprint: 'x',
    validTo: '2030-01-01',
    path: '/data/ca.pem',
  },
});

const renderSetup = (browsers: BrowserInfo[], send: (command: unknown) => Promise<unknown>) =>
  render(<SetupPage status={setupStatus(browsers)} connected send={send as never} onLaunched={() => {}} />);

describe('Setup → Rescan', () => {
  it('says to rescan, not restart, when Firefox is missing', () => {
    renderSetup([chrome], vi.fn());
    expect(screen.getByText('Not found. Install Firefox, then click Rescan.')).toBeTruthy();
  });

  it('names the browsers it found', async () => {
    const send = vi.fn(async () => [chrome, firefox]);
    renderSetup([chrome], send);
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect(send).toHaveBeenCalledWith({ command: 'rescanBrowsers' });
    expect(await screen.findByText('Found Firefox.')).toBeTruthy();
  });

  it('says when nothing new turned up', async () => {
    renderSetup(
      [chrome],
      vi.fn(async () => [chrome]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect(await screen.findByText('No new browsers found.')).toBeTruthy();
  });

  it('shows an error if the rescan fails, and can be tried again', async () => {
    renderSetup(
      [chrome],
      vi.fn(async () => Promise.reject(new Error('Not connected'))),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Rescan' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
