import { useState } from 'react';
import type { ProxyStatus } from '../../shared/api';
import type { Command } from './api-client';

interface Props {
  status: ProxyStatus;
  connected?: boolean;
  send?: (command: Command) => Promise<unknown>;
}

/** What Wirescry does for Docker, and whether it can here. */
export function DockerSection({ status, connected = true, send }: Props): React.JSX.Element {
  const { docker } = status;
  const [error, setError] = useState<string>();
  const switchable = docker.state === 'ready' || docker.state === 'off' || docker.state === 'unsupported';
  const toggle = (enabled: boolean): void => {
    setError(undefined);
    send?.({ command: 'setDockerSetup', enabled }).catch((e: Error) => setError(e.message));
  };
  const last = docker.lastContainer;
  return (
    <section>
      <h2>Docker</h2>
      {switchable && send && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={docker.state !== 'off'}
            disabled={!connected}
            onChange={(e) => toggle(e.target.checked)}
          />{' '}
          Set up containers started from Wirescry terminals
        </label>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      {docker.state === 'off' && (
        <p className="muted">
          Off. New terminals don&apos;t get <code>DOCKER_HOST</code>, and terminals that already have it pass
          containers on to Docker as you wrote them.
        </p>
      )}
      {docker.state === 'ready' && (
        <>
          <p className="muted">
            Containers you start with <code>docker run</code> or <code>docker compose up</code> in a terminal
            Wirescry set up send their HTTP and HTTPS traffic through Wirescry. Your images and compose files
            stay as they are.
          </p>
          <details className="coverage">
            <summary>How it works</summary>
            <ul>
              <li>
                Those terminals point <code>DOCKER_HOST</code> at Wirescry, which passes everything on to your
                Docker ({docker.daemon}). New containers also get the proxy settings and Wirescry&apos;s
                certificate, read-only at <code>/run/wirescry</code>.
              </li>
              <li>
                Containers reach each other directly, not through Wirescry: Compose service names, network
                aliases, other containers&apos; names and their networks&apos; addresses skip the proxy. A
                container started before the one it calls may not know its name; give that name in{' '}
                <code>NO_PROXY</code>. Their requests to <code>host.docker.internal</code> go through it, to
                this computer. A certificate setting you give a container, such as{' '}
                <code>NODE_EXTRA_CA_CERTS</code> in a compose file, is kept; HTTPS through Wirescry then fails
                for the tools that read it.
              </li>
              <li>
                <code>docker compose up</code> recreates containers that were started without Wirescry, and
                recreates them again without the proxy settings when you next run it outside Wirescry.
              </li>
              <li>
                While Wirescry isn&apos;t running, <code>docker</code> commands in those terminals can&apos;t
                reach Docker, and the HTTP requests of containers it set up fail. Containers that restart by
                themselves (<code>restart: always</code>) and ones you start again with{' '}
                <code>docker start</code> keep the proxy settings: recreate them outside Wirescry to drop
                them.
              </li>
              <li>
                Not covered: containers that are already running, the steps of <code>docker build</code>,
                Windows containers, and Docker on another computer. If your shell profile sets{' '}
                <code>DOCKER_HOST</code> itself, it replaces Wirescry&apos;s and nothing is set up.
              </li>
              {status.platform === 'linux' && (
                <li>
                  On Linux, a firewall that blocks containers from reaching this computer (ufw, firewalld)
                  blocks the proxy too; allow Docker&apos;s networks to reach port {status.proxyPort}.
                </li>
              )}
            </ul>
          </details>
        </>
      )}
      {docker.state === 'ready' && last && (
        <p className="muted" role="status">
          Last container: {last.name ?? last.image ?? 'unnamed'},{' '}
          {last.setUp ? 'set up.' : `left as it is${last.reason ? `: ${last.reason}` : '.'}`}
        </p>
      )}
      {docker.state === 'none' && (
        <p className="muted">
          Docker wasn&apos;t found on this computer. Once it&apos;s installed, containers you start from a
          Wirescry terminal send their traffic through Wirescry.
        </p>
      )}
      {docker.state === 'remote' && (
        <p className="note">
          Your Docker runs on another computer ({docker.daemon}). Wirescry only sets up Docker on this
          computer.
        </p>
      )}
      {docker.state === 'unsupported' && (
        <p className="note">
          {docker.error} Containers you start from a Wirescry terminal are left as they are, and their traffic
          doesn&apos;t go through Wirescry.
        </p>
      )}
      {docker.state === 'failed' && (
        <p className="note error">Wirescry couldn&apos;t set itself up for Docker: {docker.error}</p>
      )}
    </section>
  );
}
