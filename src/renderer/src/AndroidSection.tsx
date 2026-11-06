import { useState } from 'react';
import type { AndroidDevice, ProxyStatus } from '../../shared/api';
import type { Command } from './api-client';

interface Props {
  status: ProxyStatus;
  connected?: boolean;
  send?: (command: Command) => Promise<unknown>;
}

/** What to do about a device that isn't ready, in plain words. */
function stateNote(device: AndroidDevice): string | undefined {
  switch (device.state) {
    case 'ready':
      return undefined;
    case 'unauthorized':
      return 'Waiting for you to allow USB debugging: accept the prompt on the device.';
    case 'connecting':
      return 'Connecting…';
    case 'offline':
      return 'Not answering. Unplug it and plug it in again, or restart the emulator.';
    case 'no-permissions':
      return 'This computer can’t open the device over USB: Linux needs udev rules for it.';
    case 'other':
      return device.stateText ? `In ${device.stateText} mode.` : undefined;
  }
}

/** The switch's wording, as refusals in Traffic name it. */
const LOCAL_ACCESS = 'Let this device reach this computer and its local networks';

/** One device's actions: Capture, Stop, Restore, Clear, and the destination switch. */
function DeviceActions({
  device,
  connected,
  send,
}: {
  device: AndroidDevice;
  connected: boolean;
  send: (command: Command) => Promise<unknown>;
}): React.JSX.Element | null {
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const id = device.id;
  if (!id || device.state !== 'ready') return null;
  const busy = device.busy !== undefined;
  const run = (command: Command, then?: (value: unknown) => void): void => {
    setError(undefined);
    send(command)
      .then((value) => then?.(value))
      .catch((e: Error) => setError(e.message));
  };
  const capture = (replaceProxy?: string): void => {
    setConfirm(undefined);
    run({ command: 'androidCapture', deviceId: id, replaceProxy }, (value) => {
      const proxy = (value as { needsConfirmation?: string } | undefined)?.needsConfirmation;
      if (proxy) setConfirm(proxy);
    });
  };
  const disabled = !connected || busy;
  return (
    <div className="device-actions">
      {device.leftover ? (
        <>
          <p className="note" role="status">
            Wirescry left this device set up last time, so its internet may not work.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => run({ command: 'androidStop', deviceId: id })}
          >
            {device.busy === 'stopping' ? 'Restoring…' : 'Restore'}
          </button>
        </>
      ) : device.strayProxy ? (
        <>
          <p className="note" role="status">
            Its proxy is {device.strayProxy}, with nothing behind it that Wirescry knows of, so its internet
            may not work.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => run({ command: 'androidClearProxy', deviceId: id })}
          >
            Clear proxy
          </button>
        </>
      ) : device.capture ? (
        <>
          <p role="status">
            Capturing.{' '}
            <span className="muted">
              {device.emulator
                ? 'Stop capture before closing the emulator, or it may come back without internet.'
                : 'Stop capture before unplugging it, or its internet stops until you plug it in again.'}
            </span>
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={device.capture.localAccess}
              disabled={disabled}
              onChange={(e) =>
                run({ command: 'androidSetLocalAccess', deviceId: id, allowed: e.target.checked })
              }
            />{' '}
            {LOCAL_ACCESS}
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => run({ command: 'androidStop', deviceId: id })}
          >
            {device.busy === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        </>
      ) : device.unsupported ? null : confirm ? (
        <div className="callout warn" role="alert">
          <p>
            This device already uses the proxy {confirm}, set by you or another tool. Replace it while
            capturing? Wirescry puts it back when you stop.
          </p>
          <button type="button" disabled={disabled} onClick={() => capture(confirm)}>
            Replace and capture
          </button>{' '}
          <button type="button" onClick={() => setConfirm(undefined)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button type="button" disabled={disabled} onClick={() => capture()}>
            {device.busy === 'capturing' ? 'Capturing…' : 'Capture'}
          </button>{' '}
          <span className="muted">Other apps on the device may stop working until you stop capturing.</span>
        </>
      )}
      {(error ?? device.note) && (
        <p className={error ? 'note error' : 'muted'} role={error ? 'alert' : undefined}>
          {error ?? device.note}
        </p>
      )}
    </div>
  );
}

/**
 * Android devices over the user's ADB server: listed, captured and put back. Shown only while
 * the experimental setting is on.
 */
export function AndroidSection({ status, connected = true, send }: Props): React.JSX.Element | null {
  const { android } = status;
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  if (!android) return null;
  const checkAgain = (): void => {
    setError(undefined);
    setChecking(true);
    send?.({ command: 'androidRefresh' })
      .catch((e: Error) => setError(e.message))
      .finally(() => setChecking(false));
  };
  return (
    <section>
      <h2>
        Android <span className="badge">Experimental</span>
      </h2>
      {android.state === 'starting' && <p className="muted">Looking for the ADB server…</p>}
      {(android.state === 'no-adb' || android.state === 'failed') && (
        <p className="note" role="status">
          {android.error}
        </p>
      )}
      {android.state === 'ready' && android.devices.length === 0 && (
        <p className="muted">
          No devices. Plug in a phone with USB debugging on, or start an emulator in Android Studio.
        </p>
      )}
      {android.state === 'ready' && android.devices.length > 0 && (
        <ul className="device-list" aria-label="Android devices">
          {android.devices.map((device) => {
            const note = device.unsupported ?? device.error ?? stateNote(device);
            return (
              <li key={device.serial}>
                <span className="device-name">{device.label}</span>{' '}
                <span className="muted">
                  {[
                    device.emulator ? 'Emulator' : 'Device',
                    device.apiLevel !== undefined ? `API ${device.apiLevel}` : undefined,
                    device.serial,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {note && <div className="muted">{note}</div>}
                {send && <DeviceActions device={device} connected={connected} send={send} />}
              </li>
            );
          })}
        </ul>
      )}
      {android.notConnected?.map((d, i) => (
        <p key={i} className="note" role="status">
          <span className="device-name">{d.label}</span>{' '}
          {d.capturing ? 'was disconnected while capturing' : 'was left set up last time and isn’t connected'}
          . Its internet won’t work until you connect it here and use {d.capturing ? 'Stop' : 'Restore'}, or
          run <code>adb shell settings put global http_proxy :0</code> with only that device connected.
        </p>
      ))}
      {send && android.state !== 'starting' && (
        <p>
          <button type="button" onClick={checkAgain} disabled={!connected || checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        Capture sends the device’s HTTP and HTTPS traffic through Wirescry, and Stop puts the device back as
        it was. HTTPS from apps stays unreadable until the device trusts Wirescry’s certificate, which isn’t
        set up here yet. Wirescry uses the ADB server Android Studio uses, and starts it with your adb if it
        isn’t running. If a device is left without internet, run{' '}
        <code>adb shell settings put global http_proxy :0</code>.
      </p>
    </section>
  );
}
