import { useState } from 'react';
import type { ProxyStatus } from '../../shared/api';
import type { Command } from './api-client';

interface Props {
  status: ProxyStatus;
  connected: boolean;
  send(command: Command): Promise<unknown>;
  onLaunched(): void;
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

/** Ways to send traffic through Leverframe, plus the proxy port and certificate settings. */
export function SetupPage({ status, connected, send, onLaunched }: Props): React.JSX.Element {
  const address = `127.0.0.1:${status.proxyPort}`;
  const proxyUrl = `http://${address}`;
  const certPath = status.certificate.path;

  const [portMode, setPortMode] = useState<'auto' | 'fixed'>(
    status.proxyPortSetting === null ? 'auto' : 'fixed',
  );
  const [portText, setPortText] = useState(String(status.proxyPortSetting ?? status.proxyPort));
  const [portError, portNote, runPort] = useAction();
  const [launchError, , runLaunch] = useAction();
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

  // Per-tool variables rather than SSL_CERT_FILE, which makes Node's fetch reject the certificate.
  const shellSetup = [
    `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NODE_USE_ENV_PROXY=1`,
    `export CURL_CA_BUNDLE=${quote(certPath)} NODE_EXTRA_CA_CERTS=${quote(certPath)} REQUESTS_CA_BUNDLE=${quote(certPath)}`,
  ].join('\n');
  const pythonStdlib = `SSL_CERT_FILE=${quote(certPath)} python3 your_script.py`;
  const curlOnce = `curl --proxy ${proxyUrl} --cacert ${quote(certPath)} https://example.com/`;

  return (
    <div className="setup">
      <section>
        <h2>Browsers</h2>
        <p className="muted">
          Opens a separate browser window with its own profile, sent through Leverframe.
        </p>
        {status.browsers.length === 0 && <p>No supported browser found. Use manual setup below.</p>}
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
              <span className="muted">Not found. Install Firefox, then restart Leverframe.</span>
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
        {launchError && <p className="note error">{launchError}</p>}
      </section>

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
                  const result = await window.leverframe.exportCertificate();
                  return result.path ? `Saved to ${result.path}` : undefined;
                })
              }
            >
              Save certificate…
            </button>
            <span className="muted">
              or, through the proxy, open <code>http://leverframe.internal/certificate</code>
            </span>
          </dd>
        </dl>
        {exportError && <p className="note error">{exportError}</p>}
        {exportNote && <p className="note">{exportNote}</p>}
        <h3>Terminal (macOS and Linux)</h3>
        <p className="muted">
          Run in a shell to send curl, Node.js (24 and later) and Python requests through Leverframe.
        </p>
        <div className="snippet">
          <pre className="code">{shellSetup}</pre>
          <CopyButton text={shellSetup} />
        </div>
        <p className="muted">
          Python's standard library (urllib) also needs <code>SSL_CERT_FILE</code>. Set it for Python only:
          Node's fetch rejects the certificate when it's set.
        </p>
        <div className="snippet">
          <pre className="code">{pythonStdlib}</pre>
          <CopyButton text={pythonStdlib} />
        </div>
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
        {portError && <p className="note error">{portError}</p>}
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
        {certError && <p className="note error">{certError}</p>}
        {certNote && <p className="note">{certNote}</p>}
      </section>
    </div>
  );
}
