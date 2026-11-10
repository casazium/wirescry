/**
 * The Setup page's own actions (src/renderer/src/SetupPage.tsx): launching browsers, the
 * proxy port, saving and resetting the certificate, and the Copy buttons.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserInfo, ProxyStatus } from '../../src/shared/api';
import type { WirescryBridge } from '../../src/shared/ipc';
import { SetupPage } from '../../src/renderer/src/SetupPage';
import { status } from './fixtures';

const chrome: BrowserInfo = { id: 'chrome', name: 'Google Chrome', kind: 'chromium' };
const edge: BrowserInfo = { id: 'edge', name: 'Microsoft Edge', kind: 'chromium' };
const firefox: BrowserInfo = { id: 'firefox', name: 'Firefox', kind: 'firefox' };

const setupStatus = (overrides: Partial<ProxyStatus> = {}): ProxyStatus => ({
  ...status(),
  browsers: [chrome, firefox],
  certificate: {
    commonName: 'Wirescry CA (test)',
    spkiFingerprint: 'x',
    sha256: 'AA:BB',
    validTo: '2030-01-01',
    path: '/data/ca.pem',
  },
  ...overrides,
});

let exportCertificate: ReturnType<typeof vi.fn>;
let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  exportCertificate = vi.fn(async () => ({}));
  window.wirescry = { exportCertificate } as unknown as WirescryBridge;
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});
afterEach(() => vi.useRealTimers());

function setup(
  options: {
    status?: Partial<ProxyStatus>;
    send?: (command: unknown) => Promise<unknown>;
    connected?: boolean;
  } = {},
) {
  const send = vi.fn(options.send ?? (async () => undefined));
  const onLaunched = vi.fn();
  render(
    <SetupPage
      status={setupStatus(options.status)}
      connected={options.connected ?? true}
      send={send as never}
      onLaunched={onLaunched}
    />,
  );
  return { send, onLaunched };
}
const settle = () => act(async () => undefined);
const row = (name: string) => screen.getByText(name, { selector: '.browser-list span' }).closest('li')!;
const section = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!;

describe('launching a browser from Setup', () => {
  it('launches the one clicked, then goes to the traffic', async () => {
    const { send, onLaunched } = setup({ status: { browsers: [chrome, edge, firefox] } });
    fireEvent.click(within(row('Microsoft Edge')).getByRole('button', { name: 'Launch' }));
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'launchBrowser', browserId: 'edge' });
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('says why when it can’t, and stays on Setup', async () => {
    const { onLaunched } = setup({
      send: async () => {
        throw new Error('Browser not found: chrome');
      },
    });
    fireEvent.click(within(row('Google Chrome')).getByRole('button', { name: 'Launch' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Browser not found: chrome');
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it('says whether Firefox trusts the certificate yet', () => {
    setup({ status: { firefoxTrusted: false } });
    expect(
      within(row('Firefox')).getByText('First launch asks you to trust the certificate once'),
    ).toBeTruthy();
  });

  it('says when Firefox is set up, and launches it', async () => {
    const { send } = setup({ status: { firefoxTrusted: true } });
    expect(within(row('Firefox')).getByText('Set up and trusting the certificate')).toBeTruthy();
    fireEvent.click(within(row('Firefox')).getByRole('button', { name: 'Launch' }));
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'launchBrowser', browserId: 'firefox' });
  });

  it('can’t launch while the proxy isn’t running', () => {
    setup({ connected: false });
    expect(
      (within(row('Google Chrome')).getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says when no browser was found', () => {
    setup({ status: { browsers: [] } });
    expect(screen.getByText(/No supported browser found\./)).toBeTruthy();
  });
});

describe('the proxy port', () => {
  const portSection = () => section('Proxy port');
  const portInput = () => within(portSection()).getByRole('spinbutton', { name: 'Port' }) as HTMLInputElement;
  const [auto, fixed] = [
    () =>
      within(portSection()).getByRole('radio', {
        name: 'Pick a free port automatically',
      }) as HTMLInputElement,
    () => within(portSection()).getByRole('radio', { name: /Always use port/ }) as HTMLInputElement,
  ];

  it('starts as automatic when no port is set, showing the one in use', () => {
    setup({ status: { proxyPortSetting: null, proxyPort: 8001 } });
    expect(auto().checked).toBe(true);
    expect(portInput().value).toBe('8001');
    expect(portInput().disabled).toBe(true);
  });

  it('starts as the set port when there is one', () => {
    setup({ status: { proxyPortSetting: 9123, proxyPort: 9123 } as Partial<ProxyStatus> });
    expect(fixed().checked).toBe(true);
    expect(portInput().value).toBe('9123');
  });

  it('saves a fixed port with Apply, or Enter in the field', async () => {
    const { send } = setup({ status: { proxyPortSetting: null } });
    fireEvent.click(fixed());
    fireEvent.change(portInput(), { target: { value: '9000' } });
    fireEvent.click(within(portSection()).getByRole('button', { name: 'Apply' }));
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'setProxyPort', port: 9000 });
    expect(within(portSection()).getByText('Saved.')).toBeTruthy();
    fireEvent.change(portInput(), { target: { value: '9001' } });
    fireEvent.keyDown(portInput(), { key: 'Enter' });
    await settle();
    expect(send).toHaveBeenLastCalledWith({ command: 'setProxyPort', port: 9001 });
    // Other keys just type.
    send.mockClear();
    fireEvent.keyDown(portInput(), { key: '5' });
    expect(send).not.toHaveBeenCalled();
  });

  it('goes back to automatic, saving no port', async () => {
    const { send } = setup({ status: { proxyPortSetting: 9123 } as Partial<ProxyStatus> });
    fireEvent.click(auto());
    fireEvent.click(within(portSection()).getByRole('button', { name: 'Apply' }));
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'setProxyPort', port: null });
  });

  it('says why a port wasn’t saved', async () => {
    setup({
      send: async () => {
        throw new Error('Port 9000 is in use by another program.');
      },
    });
    fireEvent.click(fixed());
    fireEvent.change(portInput(), { target: { value: '9000' } });
    fireEvent.click(within(portSection()).getByRole('button', { name: 'Apply' }));
    await settle();
    expect(within(portSection()).getByRole('alert').textContent).toBe(
      'Port 9000 is in use by another program.',
    );
    expect(within(portSection()).queryByText('Saved.')).toBeNull();
  });
});

describe('the certificate', () => {
  const certSection = () => section('Certificate');

  it('saves a copy and says where', async () => {
    setup();
    exportCertificate.mockResolvedValueOnce({ path: '/Users/me/wirescry-ca.pem' });
    fireEvent.click(screen.getByRole('button', { name: 'Save certificate…' }));
    await settle();
    expect(screen.getByText('Saved to /Users/me/wirescry-ca.pem')).toBeTruthy();
  });

  it('says nothing when the save is canceled, and why when it fails', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save certificate…' }));
    await settle();
    expect(screen.queryByText(/^Saved to/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    exportCertificate.mockRejectedValueOnce(new Error('Folder is read-only.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save certificate…' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Folder is read-only.');
  });

  it('asks before resetting, and Cancel leaves it as it was', async () => {
    const { send } = setup();
    fireEvent.click(within(certSection()).getByRole('button', { name: 'Reset certificate…' }));
    expect(
      within(certSection()).getByText(/Anything that trusts the current certificate will stop working/),
    ).toBeTruthy();
    fireEvent.click(within(certSection()).getByRole('button', { name: 'Cancel' }));
    expect(within(certSection()).queryByText(/stop working/)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('resets it when confirmed, and says what to do next', async () => {
    const { send } = setup();
    fireEvent.click(within(certSection()).getByRole('button', { name: 'Reset certificate…' }));
    fireEvent.click(within(certSection()).getByRole('button', { name: 'Reset certificate' }));
    await settle();
    expect(send).toHaveBeenCalledWith({ command: 'resetCertificate' });
    expect(
      within(certSection()).getByText('A new certificate was created. Relaunch any browsers you opened.'),
    ).toBeTruthy();
    // The question is gone.
    expect(within(certSection()).queryByText(/stop working/)).toBeNull();
  });

  it('says why a reset failed', async () => {
    setup({
      send: async () => {
        throw new Error('Couldn’t write the new certificate.');
      },
    });
    fireEvent.click(within(certSection()).getByRole('button', { name: 'Reset certificate…' }));
    fireEvent.click(within(certSection()).getByRole('button', { name: 'Reset certificate' }));
    await settle();
    expect(within(certSection()).getByRole('alert').textContent).toBe('Couldn’t write the new certificate.');
  });

  it('can’t be reset while the proxy isn’t running', () => {
    setup({ connected: false });
    expect(
      (within(certSection()).getByRole('button', { name: 'Reset certificate…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('Copy buttons', () => {
  it('copy the proxy address and say Copied for a moment', async () => {
    vi.useFakeTimers();
    setup({ status: { proxyPort: 8001 } });
    const address = screen.getByTestId('proxy-address');
    const copy = within(address.closest('dd')!).getByRole('button');
    expect(copy.textContent).toBe('Copy');
    await act(async () => void fireEvent.click(copy));
    expect(clipboard).toHaveBeenCalledWith('127.0.0.1:8001');
    expect(copy.textContent).toBe('Copied');
    await act(async () => void vi.advanceTimersByTime(1499));
    expect(copy.textContent).toBe('Copied');
    await act(async () => void vi.advanceTimersByTime(1));
    expect(copy.textContent).toBe('Copy');
  });

  it('say so when the copy fails, instead of Copied', async () => {
    vi.useFakeTimers();
    clipboard.mockRejectedValueOnce(new Error('denied'));
    setup();
    const copy = within(screen.getByTestId('proxy-address').closest('dd')!).getByRole('button');
    await act(async () => void fireEvent.click(copy));
    expect(copy.textContent).toBe('Couldn’t copy');
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(copy.textContent).toBe('Copy');
  });
});
