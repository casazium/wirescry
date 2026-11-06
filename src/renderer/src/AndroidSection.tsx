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

/**
 * Android devices over the user's ADB server. Read-only while Android setup is being built:
 * it lists devices, and capturing comes later. Shown only while the experimental setting is on.
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
              </li>
            );
          })}
        </ul>
      )}
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
        Capturing a device’s traffic isn’t ready yet. Wirescry uses the ADB server Android Studio uses, and
        starts it with your adb if it isn’t running.
      </p>
    </section>
  );
}
