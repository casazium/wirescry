import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AndroidDevice, AndroidStatus, ProxyStatus } from '../../src/shared/api';
import { AndroidSection } from '../../src/renderer/src/AndroidSection';
import { HIDE_ANDROID_SYSTEM_QUERY } from '../../src/shared/android-system';
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

describe('Android section: capturing', () => {
  const ready = (extra: Partial<AndroidDevice> = {}): ProxyStatus =>
    withAndroid({
      state: 'ready',
      devices: [
        {
          serial: 'R58',
          state: 'ready',
          label: 'Pixel 8',
          emulator: false,
          apiLevel: 35,
          id: 'a'.repeat(32),
          ...extra,
        },
      ],
    });
  const id = 'a'.repeat(32);

  it('captures a device, warning about other apps first', () => {
    const send = vi.fn().mockResolvedValue({});
    render(<AndroidSection status={ready()} send={send} />);
    expect(screen.getByText(/Other apps on the device may stop working/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    expect(send).toHaveBeenCalledWith({
      command: 'androidCapture',
      deviceId: id,
      replaceProxy: undefined,
      confirmWireless: false,
    });
  });

  it('asks before replacing a proxy the device already has, and can be cancelled', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ needsConfirmation: 'proxy.corp:3128' })
      .mockResolvedValue({});
    render(<AndroidSection status={ready()} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('proxy.corp:3128'));
    fireEvent.click(screen.getByRole('button', { name: 'Replace and capture' }));
    expect(send).toHaveBeenLastCalledWith({
      command: 'androidCapture',
      deviceId: id,
      replaceProxy: 'proxy.corp:3128',
      confirmWireless: false,
    });
    send.mockResolvedValueOnce({ needsConfirmation: 'proxy.corp:3128' });
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() => screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Capture' })).toBeTruthy();
  });

  it('shows a capturing device with Stop and the destination switch', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <AndroidSection
        status={ready({ capture: { devicePort: 40000, hostPort: 8001, localAccess: false } })}
        send={send}
      />,
    );
    expect(screen.getByText(/Stop capture before unplugging it/)).toBeTruthy();
    const box = screen.getByRole('checkbox', {
      name: 'Let this device reach this computer and its local networks',
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(send).toHaveBeenCalledWith({ command: 'androidSetLocalAccess', deviceId: id, allowed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'androidStop', deviceId: id });
  });

  it('tells emulator users to stop before closing it', () => {
    render(
      <AndroidSection
        status={ready({ emulator: true, capture: { devicePort: 40000, hostPort: 8001, localAccess: true } })}
        send={vi.fn()}
      />,
    );
    expect(screen.getByText(/Stop capture before closing the emulator/)).toBeTruthy();
  });

  it('offers Resume and Restore for a device left set up, and Clear for a stray proxy', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<AndroidSection status={ready({ leftover: true })} send={send} />);
    expect(screen.getByText(/left this device set up last time/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'androidResume', deviceId: id });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'androidStop', deviceId: id });
    rerender(<AndroidSection status={ready({ strayProxy: '127.0.0.1:41111' })} send={send} />);
    expect(screen.getByText(/127\.0\.0\.1:41111/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear proxy' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'androidClearProxy', deviceId: id });
  });

  it('disables actions while busy or disconnected, and shows what went wrong', async () => {
    const send = vi.fn().mockRejectedValue(new Error('The device refused.'));
    const { rerender } = render(<AndroidSection status={ready({ busy: 'capturing' })} send={send} />);
    expect((screen.getByRole('button', { name: 'Capturing…' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<AndroidSection status={ready()} send={send} connected={false} />);
    expect((screen.getByRole('button', { name: 'Capture' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<AndroidSection status={ready({ note: 'Its proxy setting had been changed.' })} send={send} />);
    expect(screen.getByText('Its proxy setting had been changed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() =>
      expect(screen.getAllByRole('alert').some((a) => a.textContent === 'The device refused.')).toBe(true),
    );
  });

  it('asks before capturing a device on Wi-Fi, then still asks about its proxy', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ needsWirelessConfirmation: true })
      .mockResolvedValueOnce({ needsConfirmation: 'proxy.corp:3128' })
      .mockResolvedValue({});
    render(<AndroidSection status={ready({ wireless: true, serial: '192.168.1.20:5555' })} send={send} />);
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('Device over Wi-Fi');
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/connected over Wi-Fi/));
    fireEvent.click(screen.getByRole('button', { name: 'Capture over Wi-Fi' }));
    expect(send).toHaveBeenLastCalledWith({
      command: 'androidCapture',
      deviceId: id,
      replaceProxy: undefined,
      confirmWireless: true,
    });
    await waitFor(() => screen.getByRole('button', { name: 'Replace and capture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace and capture' }));
    // The Wi-Fi answer carries over.
    expect(send).toHaveBeenLastCalledWith({
      command: 'androidCapture',
      deviceId: id,
      replaceProxy: 'proxy.corp:3128',
      confirmWireless: true,
    });
  });

  it('can cancel capturing over Wi-Fi', async () => {
    const send = vi.fn().mockResolvedValue({ needsWirelessConfirmation: true });
    render(<AndroidSection status={ready({ wireless: true })} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() => screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Capture' })).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('offers nothing for a device that is unsupported, unauthorized or unread', () => {
    const send = vi.fn();
    const { rerender } = render(<AndroidSection status={ready({ unsupported: 'Too old.' })} send={send} />);
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
    rerender(<AndroidSection status={ready({ state: 'unauthorized' })} send={send} />);
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
    rerender(<AndroidSection status={ready({ id: undefined })} send={send} />);
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
  });
});

it('says what to do about set-up devices that are not connected', () => {
  render(
    <AndroidSection
      status={withAndroid({
        state: 'ready',
        devices: [],
        notConnected: [
          { label: 'Pixel 8', capturing: true },
          { label: 'Galaxy Tab', capturing: false },
        ],
      })}
    />,
  );
  const notes = screen.getAllByRole('status').map((n) => n.textContent ?? '');
  expect(notes.some((t) => /Pixel 8 was disconnected while capturing.*capture carries on/.test(t))).toBe(
    true,
  );
  expect(notes.some((t) => /Galaxy Tab was left set up last time.*Resume or Restore/.test(t))).toBe(true);
  expect(notes.every((t) => !t.includes('Pixel 8') || t.includes('http_proxy :0'))).toBe(true);
});

it('words it for emulators, which come back from a saved state', () => {
  render(
    <AndroidSection
      status={withAndroid({
        state: 'ready',
        devices: [],
        notConnected: [
          { label: 'Pixel 8 API 35', capturing: true, emulator: true },
          { label: 'Small Phone', capturing: false, emulator: true },
        ],
      })}
    />,
  );
  const notes = screen.getAllByRole('status').map((n) => n.textContent ?? '');
  expect(notes.some((t) => /Pixel 8 API 35 closed while capturing\. Start it again/.test(t))).toBe(true);
  expect(notes.some((t) => /Small Phone was left set up last time and isn’t running/.test(t))).toBe(true);
});

describe('Android section: certificate', () => {
  const id = 'a'.repeat(32);
  const certificate = {
    commonName: 'Wirescry CA (1234abcd)',
    spkiFingerprint: 'x',
    sha256: 'AB:CD:EF',
    validTo: '2030-01-01',
    path: '/data/ca.pem',
  };
  const capturing = (extra: Partial<AndroidDevice> = {}): ProxyStatus => ({
    ...withAndroid({
      state: 'ready',
      devices: [
        {
          serial: 'R58',
          state: 'ready',
          label: 'Pixel 8',
          emulator: false,
          apiLevel: 35,
          id,
          capture: { devicePort: 40000, hostPort: 8001, localAccess: false },
          certificate: { trusted: false, sent: false },
          ...extra,
        },
      ],
    }),
    certificate,
  });
  const CopyButton = ({ text }: { text: string }) => (
    <button type="button" data-copy={text}>
      Copy
    </button>
  );

  it('walks through sending, installing, checking and checking the name and SHA-256', async () => {
    const send = vi.fn().mockResolvedValue({ settingsOpened: true });
    const { rerender } = render(<AndroidSection status={capturing()} send={send} CopyButton={CopyButton} />);
    const steps = document.querySelector('.device-https')!.textContent!;
    expect(steps).toMatch(
      /Encryption & credentials › Install a certificate › CA certificate › Install anyway/,
    );
    expect(steps).toContain('Wirescry CA (1234abcd)');
    expect(steps).toContain('AB:CD:EF');
    expect(screen.getByLabelText('the menu').textContent).toBe('☰');
    fireEvent.click(screen.getByRole('button', { name: 'Send certificate' }));
    expect(send).toHaveBeenCalledWith({ command: 'androidSendCertificate', deviceId: id });
    rerender(
      <AndroidSection status={capturing({ certificate: { trusted: false, sent: true } })} send={send} />,
    );
    await waitFor(() =>
      expect(screen.getByText('Sent. Security settings are open on the device.')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check in Chrome' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'androidCheckCertificate', deviceId: id });
    fireEvent.click(screen.getAllByRole('button', { name: 'installed certificates' })[0]!);
    expect(send).toHaveBeenLastCalledWith({ command: 'androidShowCertificates', deviceId: id });
  });

  it('says to open Settings when the device didn’t, and shows a failure', async () => {
    const send = vi.fn().mockResolvedValueOnce({ settingsOpened: false });
    const { rerender } = render(<AndroidSection status={capturing()} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send certificate' }));
    rerender(
      <AndroidSection status={capturing({ certificate: { trusted: false, sent: true } })} send={send} />,
    );
    await waitFor(() => expect(screen.getByText('Sent. Open Settings on the device.')).toBeTruthy());
    send.mockRejectedValueOnce(new Error('No browser on the device opened http://wirescry.internal/.'));
    fireEvent.click(screen.getByRole('button', { name: 'Check in Chrome' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/No browser on the device/));
  });

  it('forgets “Sent” once the copy is out of date (a certificate reset)', async () => {
    const send = vi.fn().mockResolvedValue({ settingsOpened: true });
    const { rerender } = render(<AndroidSection status={capturing()} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send certificate' }));
    rerender(
      <AndroidSection status={capturing({ certificate: { trusted: false, sent: true } })} send={send} />,
    );
    await waitFor(() => screen.getByText('Sent. Security settings are open on the device.'));
    rerender(<AndroidSection status={capturing()} send={send} />);
    expect(screen.queryByText(/^Sent/)).toBeNull();
    expect(
      screen.getByText('Copies it to the device’s Downloads and opens Security settings there.'),
    ).toBeTruthy();
  });

  it('shows Sending… while it’s on its way', () => {
    render(<AndroidSection status={capturing({ busy: 'sending' })} send={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('says when the page opened in a browser other than Chrome', async () => {
    const send = vi.fn().mockResolvedValue({ browser: 'default' });
    render(<AndroidSection status={capturing()} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check in Chrome' }));
    await waitFor(() =>
      expect(
        screen.getByText(/default browser, as it has no Chrome.*may not use certificates installed/),
      ).toBeTruthy(),
    );
  });

  it('gives Android 10 and older their own steps', () => {
    render(<AndroidSection status={capturing({ apiLevel: 29 })} send={vi.fn()} />);
    const steps = document.querySelector('.device-https')!.textContent!;
    expect(steps).toMatch(/Encryption & credentials › Install from storage \(or Install from SD card\)/);
    expect(steps).not.toMatch(/Install anyway/);
  });

  it('says when it was sent earlier, and when Chrome on the device trusts the certificate', () => {
    const send = vi.fn().mockResolvedValue({ browser: 'chrome' });
    const { rerender } = render(
      <AndroidSection status={capturing({ certificate: { trusted: false, sent: true } })} send={send} />,
    );
    expect(screen.getByText('Sent to the device’s Downloads.')).toBeTruthy();
    rerender(
      <AndroidSection status={capturing({ certificate: { trusted: true, sent: true } })} send={send} />,
    );
    expect(
      screen.getByText(/Chrome on this device trusts Wirescry’s certificate, so HTTPS from Chrome shows/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send certificate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check in Chrome again' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'androidCheckCertificate', deviceId: id });
    expect(screen.getByRole('button', { name: 'installed certificates' })).toBeTruthy();
  });

  it('gives the snippet for your own app, with Copy', () => {
    render(<AndroidSection status={capturing()} send={vi.fn()} CopyButton={CopyButton} />);
    const copies = [...document.querySelectorAll('[data-copy]')].map((b) => b.getAttribute('data-copy'));
    expect(copies[0]).toMatch(/<debug-overrides>\s*<trust-anchors>\s*<certificates src="user" \/>/);
    expect(copies[1]).toBe('android:networkSecurityConfig="@xml/network_security_config"');
    expect(screen.getByText('Your own app')).toBeTruthy();
  });

  it('shows no certificate steps until capturing, or while disconnected or busy can’t act', () => {
    const { rerender } = render(<AndroidSection status={capturing({ capture: undefined })} send={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Send certificate' })).toBeNull();
    rerender(<AndroidSection status={capturing({ busy: 'stopping' })} send={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Send certificate' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<AndroidSection status={capturing()} send={vi.fn()} connected={false} />);
    expect((screen.getByRole('button', { name: 'Check in Chrome' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('Android section: connections that refused the certificate', () => {
  const id = 'b'.repeat(32);
  const phoneDevice = (extra: Partial<AndroidDevice> = {}): AndroidDevice => ({
    serial: 'R58',
    state: 'ready',
    label: 'Pixel 8',
    emulator: false,
    apiLevel: 35,
    id,
    capture: { devicePort: 40000, hostPort: 8001, localAccess: false },
    ...extra,
  });
  const capturing = (extra: Partial<AndroidDevice> = {}): ProxyStatus => ({
    ...withAndroid({ state: 'ready', devices: [phoneDevice(extra)] }),
    certificate: {
      commonName: 'Wirescry CA (1234abcd)',
      spkiFingerprint: 'x',
      sha256: 'AB:CD:EF',
      validTo: '2030-01-01',
      path: '/data/ca.pem',
    },
  });
  const summaryText = (): string => document.querySelector('.device-refused')?.textContent ?? '';
  const HIDE = 'Hide Android’s background traffic in Traffic';

  it('names the apps’ hosts, most frequent first, and counts the rest', () => {
    render(
      <AndroidSection
        status={capturing({
          refused: {
            count: 12,
            hosts: [
              { host: 'api.bank.test', count: 4 },
              { host: 'youtubei.googleapis.com', count: 3 },
              { host: '', count: 1 },
              { host: 'b.test', count: 1 },
              { host: 'c.test', count: 1 },
              { host: 'd.test', count: 1 },
              { host: 'e.test', count: 1 },
            ],
          },
        })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toContain(
      '12 connections refused Wirescry’s certificate: api.bank.test, youtubei.googleapis.com, a connection without a hostname, b.test, c.test, and 2 more.',
    );
    expect(summaryText()).toMatch(
      /The apps making them don’t trust certificates you install\. For your own app, see “Your own app”/,
    );
    expect(summaryText()).not.toContain('d.test');
    expect(summaryText()).not.toMatch(/Android’s own services|Install the certificate first/);
  });

  it('says to install the certificate first while the device doesn’t trust it yet', () => {
    const refused = { count: 2, hosts: [{ host: 'example.com', count: 2 }] };
    const { rerender } = render(
      <AndroidSection
        status={capturing({ refused, certificate: { trusted: false, sent: true } })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toContain('2 connections refused Wirescry’s certificate: example.com.');
    expect(summaryText()).toContain(
      'Install the certificate first (the steps above). Apps that still refuse it after that don’t trust certificates you install.',
    );
    expect(summaryText()).not.toContain('The apps making them');
    rerender(
      <AndroidSection
        status={capturing({ refused, certificate: { trusted: true, sent: true } })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toContain('The apps making them don’t trust certificates you install.');
    expect(summaryText()).not.toContain('Install the certificate first');
  });

  it('counts Android’s own services apart, without naming them', () => {
    const { rerender } = render(
      <AndroidSection
        status={capturing({
          refused: {
            count: 6,
            hosts: [
              { host: 'www.google.com', count: 3 },
              { host: 'geomobileservices-pa.googleapis.com', count: 2 },
              { host: 'api.example.test', count: 1 },
            ],
          },
        })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toContain('1 connection refused Wirescry’s certificate: api.example.test.');
    expect(summaryText()).toContain('5 connections from Android’s own services refused it too.');
    expect(summaryText()).not.toMatch(/www\.google\.com|geomobileservices/);

    // Only Android's own: no sentence about apps.
    rerender(
      <AndroidSection
        status={capturing({ refused: { count: 1, hosts: [{ host: 'www.google.com', count: 1 }] } })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).not.toMatch(/refused Wirescry’s certificate/);
    expect(summaryText()).toContain('1 connection from Android’s own services refused it too.');
  });

  it('counts refusals past the hosts kept as the apps’, without an empty list', () => {
    render(
      <AndroidSection
        status={capturing({ refused: { count: 60, hosts: [{ host: 'www.google.com', count: 10 }] } })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toMatch(/^50 connections refused Wirescry’s certificate\. The apps/);
  });

  it('says “connections” for more than one without a hostname', () => {
    render(
      <AndroidSection
        status={capturing({ refused: { count: 3, hosts: [{ host: '', count: 3 }] } })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toContain(
      '3 connections refused Wirescry’s certificate: connections without a hostname.',
    );
  });

  it('shows hostnames as text, never as markup, and doesn’t announce every update', () => {
    render(
      <AndroidSection
        status={capturing({ refused: { count: 1, hosts: [{ host: '<b>bold</b>', count: 1 }] } })}
        send={vi.fn()}
      />,
    );
    expect(summaryText()).toContain('<b>bold</b>');
    expect(document.querySelector('.device-refused b')).toBeNull();
    expect(document.querySelector('.device-refused [role="status"]')).toBeNull();
  });

  it('shows nothing about refusals without any, nor while not capturing', () => {
    const { rerender } = render(
      <AndroidSection status={capturing({ refused: { count: 0, hosts: [] } })} send={vi.fn()} />,
    );
    expect(document.querySelector('.device-refused')).toBeNull();
    rerender(
      <AndroidSection
        status={capturing({
          capture: undefined,
          refused: { count: 1, hosts: [{ host: 'a.test', count: 1 }] },
        })}
        send={vi.fn()}
      />,
    );
    expect(document.querySelector('.device-refused')).toBeNull();
  });

  it('offers one way to hide Android’s background traffic while any device is capturing', () => {
    const onShowTraffic = vi.fn();
    const two = withAndroid({
      state: 'ready',
      devices: [
        phoneDevice(),
        phoneDevice({ serial: 'emulator-5554', label: 'Emulator', id: 'c'.repeat(32) }),
      ],
    });
    const { rerender } = render(<AndroidSection status={two} send={vi.fn()} onShowTraffic={onShowTraffic} />);
    expect(screen.getAllByRole('button', { name: HIDE })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: HIDE }));
    expect(onShowTraffic).toHaveBeenCalledWith(HIDE_ANDROID_SYSTEM_QUERY);
    expect(screen.getByText(/Adds to the Traffic search/)).toBeTruthy();

    // Nobody capturing, or nowhere to show it: no button.
    rerender(
      <AndroidSection
        status={capturing({ capture: undefined })}
        send={vi.fn()}
        onShowTraffic={onShowTraffic}
      />,
    );
    expect(screen.queryByRole('button', { name: HIDE })).toBeNull();
    rerender(<AndroidSection status={capturing()} send={vi.fn()} />);
    expect(screen.queryByRole('button', { name: HIDE })).toBeNull();
  });
});
