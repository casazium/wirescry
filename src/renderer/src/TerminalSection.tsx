import { useState } from 'react';
import type { ProxyStatus } from '../../shared/api';
import { SHELL_LABELS, shellSnippet, sourceLine, type ShellKind } from '../../shared/terminal-env';
import type { Command } from './api-client';

interface Props {
  status: ProxyStatus;
  connected: boolean;
  send(command: Command): Promise<unknown>;
  onLaunched(): void;
  CopyButton: (props: { text: string }) => React.JSX.Element;
}

const SHELLS_BY_PLATFORM: Record<ProxyStatus['platform'], ShellKind[]> = {
  darwin: ['posix', 'fish'],
  linux: ['posix', 'fish'],
  win32: ['powershell', 'cmd'],
  other: ['posix', 'fish', 'powershell', 'cmd'],
};

/** Open a terminal that sends its traffic through Wirescry, or set up an existing one. */
export function TerminalSection({
  status,
  connected,
  send,
  onLaunched,
  CopyButton,
}: Props): React.JSX.Element {
  const shells = SHELLS_BY_PLATFORM[status.platform];
  const [shell, setShell] = useState<ShellKind>(shells[0]!);
  const [error, setError] = useState<string>();
  const snippet = shellSnippet(status.terminalEnv, shell);
  const line = sourceLine(shell, status.terminalScripts[shell]);

  const launch = (terminalId: string): void => {
    setError(undefined);
    send({ command: 'launchTerminal', terminalId }).then(onLaunched, (e: Error) => setError(e.message));
  };

  return (
    <section>
      <h2>Terminals</h2>
      <p className="muted">
        Opens a terminal window whose programs send their HTTP and HTTPS traffic through Wirescry. Works for
        Node.js, Python, Ruby, Go, PHP, Java, curl and git.
      </p>
      {status.terminals.length > 0 ? (
        <div className="actions">
          {status.terminals.map((t) => (
            <button key={t.id} type="button" onClick={() => launch(t.id)} disabled={!connected}>
              Open {t.name}
            </button>
          ))}
        </div>
      ) : (
        <p>No supported terminal found. Use the setup below in your own terminal.</p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}

      <h3>Set up a terminal that's already open</h3>
      <div className="body-meta">
        {shells.map((s) => (
          <button
            key={s}
            type="button"
            className={`tab ${s === shell ? 'active' : ''}`}
            onClick={() => setShell(s)}
          >
            {SHELL_LABELS[s]}
          </button>
        ))}
      </div>
      <p className="muted">
        Paste this into the terminal. It lasts until that terminal closes, and covers only that terminal.
      </p>
      <div className="snippet">
        <pre className="code">{line}</pre>
        <CopyButton text={line} />
      </div>
      <details className="coverage">
        <summary>Show what this sets</summary>
        <div className="snippet">
          <pre className="code">{snippet}</pre>
          <CopyButton text={snippet} />
        </div>
      </details>

      <details className="coverage">
        <summary>What's covered</summary>
        <ul>
          <li>
            <strong>Node.js</strong> 24 and later, and 22.21 and later: fetch, http and https.
          </li>
          <li>
            <strong>Python</strong>: urllib, requests and httpx. aiohttp needs <code>trust_env=True</code>.
          </li>
          <li>
            <strong>Ruby</strong>: Net::HTTP and most gems.
          </li>
          {status.platform === 'darwin' && (
            <li>
              The Python and Ruby built into macOS (<code>/usr/bin/python3</code>, <code>/usr/bin/ruby</code>)
              ignore the certificate setting, so their standard libraries won't trust Wirescry. Python
              requests still works. Python and Ruby from Homebrew, pyenv, python.org, uv, rbenv or asdf work
              fully.
            </li>
          )}
          <li>
            <strong>Go</strong>: net/http.{' '}
            {status.platform === 'win32'
              ? 'On Windows, Go only trusts the Windows certificate store, so HTTPS needs the certificate installed there.'
              : 'Requests to localhost skip the proxy.'}
          </li>
          <li>
            <strong>PHP</strong>: the curl extension and libraries built on it, such as Guzzle.
          </li>
          <li>
            <strong>Java</strong> 8 and later: HttpURLConnection, the java.net.http client, and libraries
            built on them such as OkHttp and Spring's RestTemplate. Apache HttpClient needs its
            system-properties builder. Every <code>java</code> command prints a &quot;Picked up
            JAVA_TOOL_OPTIONS&quot; line; that&apos;s the JVM confirming the setup.
          </li>
          <li>
            <strong>curl</strong> and <strong>git</strong>.
            {status.platform === 'win32' &&
              " curl.exe gets Wirescry's own config in these terminals, so your _curlrc isn't read there and certificate revocation checks are off."}
          </li>
        </ul>
        <p className="muted">
          Programs that ignore proxy settings, or use only the system certificate store, won't show up.
        </p>
      </details>
    </section>
  );
}
