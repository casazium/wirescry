import { useState } from 'react';
import { HIDE_ANDROID_SYSTEM_QUERY, isAndroidSystemHost } from '../../shared/android-system';
import type { AndroidDevice, ProxyStatus, RefusedConnections } from '../../shared/api';
import type { Command } from './api-client';

type CopyButtonType = (props: { text: string }) => React.JSX.Element;

interface Props {
  status: ProxyStatus;
  connected?: boolean;
  send?: (command: Command) => Promise<unknown>;
  CopyButton?: CopyButtonType;
  /** Opens Traffic with this search. */
  onShowTraffic?: (query: string) => void;
}

/** App hosts named in the summary; the rest are counted. */
const NAMED_HOSTS = 5;

const connections = (n: number): string => (n === 1 ? '1 connection' : `${n} connections`);

/**
 * What refused Wirescry's certificate while capturing, apps first, then Android's own services,
 * and a way to hide Android's own traffic.
 */
function RefusedSummary({
  refused,
  onShowTraffic,
}: {
  refused: RefusedConnections | undefined;
  onShowTraffic?: (query: string) => void;
}): React.JSX.Element | null {
  const hosts = refused?.hosts ?? [];
  const apps = hosts.filter((h) => !isAndroidSystemHost(h.host));
  const system = hosts.filter((h) => isAndroidSystemHost(h.host)).reduce((sum, h) => sum + h.count, 0);
  // Refusals past the kept hosts can't be placed: count them with the apps.
  const appCount = (refused?.count ?? 0) - system;
  const named = apps.slice(0, NAMED_HOSTS).map((h) => h.host || 'a connection without a hostname');
  const more = apps.length - named.length;
  if (!onShowTraffic && appCount <= 0 && system === 0) return null;
  return (
    <div className="device-refused">
      {appCount > 0 && (
        <p role="status">
          {connections(appCount)} refused Wirescry’s certificate: {named.join(', ')}
          {more > 0 ? `, and ${more} more` : ''}. The apps making them don’t trust certificates you install.
          For your own app, see “Your own app” above.
        </p>
      )}
      {system > 0 && (
        <p className="muted">
          {connections(system)} from Android’s own services refused it too. They never trust certificates you
          install, so those services may not work while capturing.
        </p>
      )}
      {onShowTraffic && (
        <button type="button" className="link" onClick={() => onShowTraffic(HIDE_ANDROID_SYSTEM_QUERY)}>
          Hide Android’s own traffic in Traffic
        </button>
      )}
    </div>
  );
}

/**
 * Lets a debug build trust user-installed certificates (Android 7+ apps don't by default):
 * debug-overrides apply only while android:debuggable is true, and add to the app's other trust
 * anchors (developer.android.com/privacy-and-security/security-config).
 */
const NETWORK_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
`;
const MANIFEST_ATTRIBUTE = 'android:networkSecurityConfig="@xml/network_security_config"';

/** Getting the device to trust Wirescry's certificate, and the app snippet. */
function CertificateSteps({
  device,
  certificate,
  disabled,
  run,
  CopyButton,
}: {
  device: AndroidDevice;
  certificate: ProxyStatus['certificate'];
  disabled: boolean;
  run: (command: Command, then?: (value: unknown) => void) => void;
  CopyButton?: CopyButtonType;
}): React.JSX.Element | null {
  const [sentNote, setSentNote] = useState<string>();
  const [checkNote, setCheckNote] = useState<string>();
  const id = device.id;
  if (!id || !device.certificate) return null;
  const { trusted, sent } = device.certificate;
  const showInstalled = (
    <button
      type="button"
      className="link"
      disabled={disabled}
      onClick={() => run({ command: 'androidShowCertificates', deviceId: id })}
    >
      installed certificates
    </button>
  );
  const check = (label: string): React.JSX.Element => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setCheckNote(undefined);
        run({ command: 'androidCheckCertificate', deviceId: id }, (value) => {
          const reply = value as { browser?: string } | undefined;
          setCheckNote(
            reply?.browser === 'default'
              ? 'Opened in the device’s default browser, as it has no Chrome. A browser other than Chrome may not use certificates installed in Settings.'
              : undefined,
          );
        });
      }}
    >
      {label}
    </button>
  );
  // Android 11 moved installing CA certificates into its own screen (API 30).
  const older = device.apiLevel !== undefined && device.apiLevel < 30;
  return (
    <div className="device-https">
      {trusted ? (
        <p role="status">
          Chrome on this device trusts Wirescry’s certificate, so HTTPS from Chrome shows in Traffic. Apps
          trust it only if they say so: see <strong>Your own app</strong>. {check('Check in Chrome again')} To
          remove the certificate, open the device’s {showInstalled}.
        </p>
      ) : (
        <>
          <p>To read this device’s HTTPS traffic, install Wirescry’s certificate on it:</p>
          <ol>
            <li>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  run({ command: 'androidSendCertificate', deviceId: id }, (value) => {
                    const reply = value as { settingsOpened?: boolean } | undefined;
                    setSentNote(
                      reply?.settingsOpened
                        ? 'Sent. Security settings are open on the device.'
                        : 'Sent. Open Settings on the device.',
                    );
                  })
                }
              >
                {device.busy === 'sending' ? 'Sending…' : 'Send certificate'}
              </button>{' '}
              <span className="muted" role="status">
                {sent
                  ? (sentNote ?? 'Sent to the device’s Downloads.')
                  : 'Copies it to the device’s Downloads and opens Security settings there.'}
              </span>
            </li>
            <li>
              {older ? (
                <>
                  On the device: <strong>Security</strong> (on some devices, <strong>Security</strong> ›{' '}
                  <strong>Advanced</strong>) › <strong>Encryption &amp; credentials</strong> ›{' '}
                  <strong>Install from storage</strong> (or <strong>Install from SD card</strong>), then pick{' '}
                  <strong>Wirescry-CA.crt</strong> in <strong>Downloads</strong> and give it any name.
                </>
              ) : (
                <>
                  On the device: <strong>More security &amp; privacy</strong> ›{' '}
                  <strong>Encryption &amp; credentials</strong> › <strong>Install a certificate</strong> ›{' '}
                  <strong>CA certificate</strong> › <strong>Install anyway</strong>, then{' '}
                  <span aria-label="the menu">☰</span> › <strong>Downloads</strong> ›{' '}
                  <strong>Wirescry-CA.crt</strong>.
                </>
              )}{' '}
              <span className="muted">
                Names vary between devices: search Settings for “CA certificate” or “Install certificates”. It
                may ask you to set a screen lock first.
              </span>
            </li>
            <li>
              To be sure it’s Wirescry’s, find it in the device’s {showInstalled}: it’s named{' '}
              <strong>{certificate.commonName}</strong>, with SHA-256{' '}
              <code className="wrap">{certificate.sha256}</code>.
            </li>
            <li>
              {check('Check in Chrome')}{' '}
              <span className="muted">
                Opens Wirescry’s page on the device. This says so here once Chrome there trusts the
                certificate.
              </span>
            </li>
          </ol>
        </>
      )}
      {checkNote && (
        <p className="muted" role="status">
          {checkNote}
        </p>
      )}
      <details>
        <summary>Your own app</summary>
        <p>
          Apps don’t trust certificates you install unless they say so. For your own app’s debug builds, add{' '}
          <code>res/xml/network_security_config.xml</code>:
        </p>
        <div className="snippet">
          <pre className="code">{NETWORK_CONFIG}</pre>
          {CopyButton && <CopyButton text={NETWORK_CONFIG} />}
        </div>
        <p>
          and point to it from the <code>&lt;application&gt;</code> element in{' '}
          <code>AndroidManifest.xml</code>:
        </p>
        <div className="snippet">
          <pre className="code">{MANIFEST_ATTRIBUTE}</pre>
          {CopyButton && <CopyButton text={MANIFEST_ATTRIBUTE} />}
        </div>
        <p className="muted">
          It applies only to debuggable builds. Other apps on the device, such as Google’s, keep refusing
          Wirescry’s certificate while capturing.
        </p>
      </details>
    </div>
  );
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
  certificate,
  connected,
  send,
  CopyButton,
  onShowTraffic,
}: {
  device: AndroidDevice;
  certificate: ProxyStatus['certificate'];
  connected: boolean;
  send: (command: Command) => Promise<unknown>;
  CopyButton?: CopyButtonType;
  onShowTraffic?: (query: string) => void;
}): React.JSX.Element | null {
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const [confirmWireless, setConfirmWireless] = useState(false);
  /** The user has agreed to capture over Wi-Fi, for the proxy confirmation that may follow. */
  const [wirelessOk, setWirelessOk] = useState(false);
  const id = device.id;
  if (!id || device.state !== 'ready') return null;
  const busy = device.busy !== undefined;
  const run = (command: Command, then?: (value: unknown) => void): void => {
    setError(undefined);
    send(command)
      .then((value) => then?.(value))
      .catch((e: Error) => setError(e.message));
  };
  const capture = (options: { replaceProxy?: string; wireless?: boolean } = {}): void => {
    setConfirm(undefined);
    setConfirmWireless(false);
    const wireless = options.wireless ?? wirelessOk;
    setWirelessOk(wireless);
    run(
      {
        command: 'androidCapture',
        deviceId: id,
        replaceProxy: options.replaceProxy,
        confirmWireless: wireless,
      },
      (value) => {
        const reply = value as
          { needsConfirmation?: string; needsWirelessConfirmation?: boolean } | undefined;
        if (reply?.needsWirelessConfirmation) setConfirmWireless(true);
        else if (reply?.needsConfirmation) setConfirm(reply.needsConfirmation);
      },
    );
  };
  const disabled = !connected || busy;
  return (
    <div className="device-actions">
      {device.leftover ? (
        <>
          <p className="note" role="status">
            Wirescry left this device set up last time, so its internet may not work. Resume carries on
            capturing it; Restore puts it back as it was.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => run({ command: 'androidResume', deviceId: id })}
          >
            {device.busy === 'capturing' ? 'Resuming…' : 'Resume'}
          </button>{' '}
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
          <CertificateSteps
            device={device}
            certificate={certificate}
            disabled={disabled}
            run={run}
            CopyButton={CopyButton}
          />
          <RefusedSummary refused={device.refused} onShowTraffic={onShowTraffic} />
        </>
      ) : device.unsupported ? null : confirmWireless ? (
        <div className="callout warn" role="alert">
          <p>
            This device is connected over Wi-Fi. Wireless debugging turns itself off when the device sleeps or
            changes network, and Android’s Wi-Fi settings don’t show this proxy, so the device could be left
            without internet until you connect it here again, or run{' '}
            <code>adb shell settings put global http_proxy :0</code>. Capture anyway?
          </p>
          <button type="button" disabled={disabled} onClick={() => capture({ wireless: true })}>
            Capture over Wi-Fi
          </button>{' '}
          <button type="button" onClick={() => setConfirmWireless(false)}>
            Cancel
          </button>
        </div>
      ) : confirm ? (
        <div className="callout warn" role="alert">
          <p>
            This device already uses the proxy {confirm}, set by you or another tool. Replace it while
            capturing? Wirescry puts it back when you stop.
          </p>
          <button type="button" disabled={disabled} onClick={() => capture({ replaceProxy: confirm })}>
            Replace and capture
          </button>{' '}
          <button type="button" onClick={() => setConfirm(undefined)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button type="button" disabled={disabled} onClick={() => capture({ wireless: false })}>
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
export function AndroidSection({
  status,
  connected = true,
  send,
  CopyButton,
  onShowTraffic,
}: Props): React.JSX.Element | null {
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
                    device.emulator ? 'Emulator' : device.wireless ? 'Device over Wi-Fi' : 'Device',
                    device.apiLevel !== undefined ? `API ${device.apiLevel}` : undefined,
                    device.serial,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {note && <div className="muted">{note}</div>}
                {send && (
                  <DeviceActions
                    device={device}
                    certificate={status.certificate}
                    connected={connected}
                    send={send}
                    CopyButton={CopyButton}
                    onShowTraffic={onShowTraffic}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {android.notConnected?.map((d, i) =>
        d.emulator ? (
          <p key={i} className="note" role="status">
            <span className="device-name">{d.label}</span>{' '}
            {d.capturing
              ? 'closed while capturing. Start it again while Wirescry is running and capture carries on.'
              : 'was left set up last time and isn’t running. Start it while Wirescry is running, then Resume or Restore.'}{' '}
            Until then it has no internet.
          </p>
        ) : (
          <p key={i} className="note" role="status">
            <span className="device-name">{d.label}</span>{' '}
            {d.capturing
              ? 'was disconnected while capturing. Connect it again and capture carries on.'
              : 'was left set up last time and isn’t connected. Connect it here, then Resume or Restore.'}{' '}
            Until then it has no internet, unless you run{' '}
            <code>adb shell settings put global http_proxy :0</code> with only that device connected.
          </p>
        ),
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
        Capture sends the device’s HTTP and HTTPS traffic through Wirescry, and Stop puts the device back as
        it was. HTTPS stays unreadable until the device trusts Wirescry’s certificate: the steps show while
        capturing. Wirescry uses the ADB server Android Studio uses, and starts it with your adb if it isn’t
        running. If a device is left without internet, run{' '}
        <code>adb shell settings put global http_proxy :0</code>.
      </p>
    </section>
  );
}
