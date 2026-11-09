import { useState } from 'react';
import type { BrowserInfo, ProxyStatus } from '../../shared/api';
import type { Command } from './api-client';
import { CertificateTrust } from './CertificateTrust';
import { AndroidSection } from './AndroidSection';
import { DockerSection } from './DockerSection';
import { TerminalSection } from './TerminalSection';

interface Props {
  status: ProxyStatus;
  connected: boolean;
  send(command: Command): Promise<unknown>;
  onLaunched(): void;
  /** Opens Traffic with this search. */
  onShowTraffic?(query: string): void;
}

/** POSIX shell quoting for paths shown in example commands. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Runs a task, keeping its error, or the message it resolves with, for display. */

function useAction(): [string | undefined, string | undefined, (task: () => Promise<string | void>) => void] {
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const run = (task: () => Promise<string | void>): void => {
    setError(undefined);
    setNote(undefined);
    task().then(
      (message) => setNote(message || undefined),
      (e: Error) => setError(e.message),
    );
  };
  return [error, note, run];
}

/** Ways to send traffic through Wirescry, plus the proxy port and certificate settings. */
export function SetupPage({ status, connected, send, onLaunched, onShowTraffic }: Props): React.JSX.Element {
  const address = `127.0.0.1:${status.proxyPort}`;
  const proxyUrl = `http://${address}`;
  const certPath = status.certificate.path;

  const [portMode, setPortMode] = useState<'auto' | 'fixed'>(
    status.proxyPortSetting === null ? 'auto' : 'fixed',
  );
  const [portText, setPortText] = useState(String(status.proxyPortSetting ?? status.proxyPort));
  const [portError, portNote, runPort] = useAction();
  const [launchError, , runLaunch] = useAction();
  const [rescanError, rescanNote, runRescan] = useAction();
  const [rescanning, setRescanning] = useState(false);
  const [certError, certNote, runCert] = useAction();
  const [exportError, exportNote, runExport] = useAction();
  const [confirmReset, setConfirmReset] = useState(false);

  const applyPort = (): void => {
    const port = portMode === 'auto' ? null : Number(portText);
    runPort(async () => {
      await send({ command: 'setProxyPort', port });
      return 'Saved.';
    });
  };

  const chromium = status.browsers.filter((b) => b.kind === 'chromium');
  const firefox = status.browsers.find((b) => b.kind === 'firefox');

  const launch = (browserId: string): void =>
    runLaunch(async () => {
      await send({ command: 'launchBrowser', browserId });
      onLaunched();
    });

  const rescan = (): void => {
    const before = new Set(status.browsers.map((b) => b.id));
    setRescanning(true);
    runRescan(async () => {
      try {
        const found = (await send({ command: 'rescanBrowsers' })) as BrowserInfo[];
        const added = found.filter((b) => !before.has(b.id)).map((b) => b.name);
        if (added.length > 0) return `Found ${listNames(added)}.`;
        return found.length === before.size ? 'No new browsers found.' : 'Updated the list.';
      } finally {
        setRescanning(false);
      }
    });
  };

  const curlOnce = `curl --proxy ${proxyUrl} --cacert ${quote(certPath)} https://example.com/`;

  return (
    <div className="setup">
      <section>
        <h2>Browsers</h2>
        <p className="muted">Opens a separate browser window with its own profile, sent through Wirescry.</p>
        {status.browsers.length === 0 && (
          <p>No supported browser found. Install one and click Rescan, or use manual setup below.</p>
        )}
        <ul className="browser-list">
          {chromium.map((b) => (
            <li key={b.id}>
              <span>{b.name}</span>
              <span className="muted">Fresh temporary profile each time</span>
              <button type="button" onClick={() => launch(b.id)} disabled={!connected}>
                Launch
              </button>
            </li>
          ))}
          {!firefox && (
            <li>
              <span>Firefox</span>
              <span className="muted">Not found. Install Firefox, then click Rescan.</span>
              <span />
            </li>
          )}
          {firefox && (
            <li>
              <span>{firefox.name}</span>
              <span className="muted">
                {status.firefoxTrusted
                  ? 'Set up and trusting the certificate'
                  : 'First launch asks you to trust the certificate once'}
              </span>
              <button type="button" onClick={() => launch(firefox.id)} disabled={!connected}>
                Launch
              </button>
            </li>
          )}
        </ul>
        <button type="button" className="secondary" onClick={rescan} disabled={!connected || rescanning}>
          {rescanning ? 'Rescanning…' : 'Rescan'}
        </button>
        {launchError && (
          <p className="note error" role="alert">
            {launchError}
          </p>
        )}
        {rescanError && (
          <p className="note error" role="alert">
            {rescanError}
          </p>
        )}
        {rescanNote && (
          <p className="note" role="status">
            {rescanNote}
          </p>
        )}
      </section>

      <TerminalSection
        status={status}
        connected={connected}
        send={send}
        onLaunched={onLaunched}
        CopyButton={CopyButton}
      />

      <DockerSection status={status} connected={connected} send={send} CopyButton={CopyButton} />

      <AndroidSection
        status={status}
        connected={connected}
        send={send}
        CopyButton={CopyButton}
        onShowTraffic={onShowTraffic}
      />

      <section>
        <h2>Manual setup</h2>
        <p className="muted">
          For anything else on this computer: set it to use this proxy for HTTP and HTTPS, and trust the
          certificate.
        </p>
        <dl className="facts">
          <dt>Proxy</dt>
          <dd className="inline">
            <code data-testid="proxy-address">{address}</code>
            <CopyButton text={address} />
          </dd>
          <dt>Certificate</dt>
          <dd className="inline">
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                runExport(async () => {
                  const result = await window.wirescry.exportCertificate();
                  return result.path ? `Saved to ${result.path}` : undefined;
                })
              }
            >
              Save certificate…
            </button>
            <span className="muted">
              or, through the proxy, open <code>http://wirescry.internal/certificate</code>
            </span>
          </dd>
        </dl>
        {exportError && (
          <p className="note error" role="alert">
            {exportError}
          </p>
        )}
        {exportNote && <p className="note">{exportNote}</p>}
        <CertificateTrust
          platform={status.platform}
          certPath={certPath}
          commonName={status.certificate.commonName}
          CopyButton={CopyButton}
        />
        <h3>curl, one request</h3>
        <div className="snippet">
          <pre className="code">{curlOnce}</pre>
          <CopyButton text={curlOnce} />
        </div>
        <p className="muted">
          Only programs on this computer can use the proxy. Connections from other devices are refused.
        </p>
      </section>

      <section>
        <h2>Proxy port</h2>
        <div className="port-form">
          <label>
            <input type="radio" checked={portMode === 'auto'} onChange={() => setPortMode('auto')} />
            Pick a free port automatically
          </label>
          <label>
            <input type="radio" checked={portMode === 'fixed'} onChange={() => setPortMode('fixed')} />
            Always use port
            <input
              type="number"
              min={1024}
              max={65535}
              className="port-input"
              aria-label="Port"
              value={portText}
              disabled={portMode !== 'fixed'}
              onChange={(e) => setPortText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyPort()}
            />
          </label>
          <button type="button" className="secondary" onClick={applyPort} disabled={!connected}>
            Apply
          </button>
        </div>
        <p className="muted">
          Now using port {status.proxyPort}. Changing it restarts the proxy, so relaunch any browsers you
          opened.
        </p>
        {portError && (
          <p className="note error" role="alert">
            {portError}
          </p>
        )}
        {portNote && <p className="note">{portNote}</p>}
      </section>

      <section>
        <h2>Certificate</h2>
        <p className="muted">Created for this install only. Its private key never leaves this computer.</p>
        <dl className="facts">
          <dt>Name</dt>
          <dd>{status.certificate.commonName}</dd>
          <dt>Expires</dt>
          <dd>{new Date(status.certificate.validTo).toLocaleDateString()}</dd>
          <dt>Fingerprint</dt>
          <dd>
            <code className="wrap">{status.certificate.spkiFingerprint}</code>
          </dd>
          <dt>File</dt>
          <dd>
            <code className="wrap">{certPath}</code>
          </dd>
        </dl>
        <div className="actions">
          {confirmReset ? (
            <>
              <span>
                Anything that trusts the current certificate will stop working until you set it up again.
              </span>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirmReset(false);
                  runCert(async () => {
                    await send({ command: 'resetCertificate' });
                    return 'A new certificate was created. Relaunch any browsers you opened.';
                  });
                }}
              >
                Reset certificate
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirmReset(true)}
              disabled={!connected}
            >
              Reset certificate…
            </button>
          )}
        </div>
        {certError && (
          <p className="note error" role="alert">
            {certError}
          </p>
        )}
        {certNote && <p className="note">{certNote}</p>}
      </section>
    </div>
  );
}
