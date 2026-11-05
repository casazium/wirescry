import type { ProxyStatus } from '../../shared/api';

/** What Wirescry does for Docker, and whether it can here. */
export function DockerSection({ status }: { status: ProxyStatus }): React.JSX.Element {
  const { docker } = status;
  return (
    <section>
      <h2>Docker</h2>
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
                Containers still reach each other by name directly: Compose service names and network aliases
                skip the proxy. Their requests to <code>host.docker.internal</code> go through it, to this
                computer.
              </li>
              <li>
                <code>docker compose up</code> recreates containers that were started without Wirescry, and
                recreates them again without the proxy settings when you next run it outside Wirescry.
              </li>
              <li>
                Not covered: containers that are already running, the steps of <code>docker build</code>,
                Windows containers, and Docker on another computer. A container you start again later with{' '}
                <code>docker start</code> keeps the proxy settings, so it needs Wirescry running.
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
      {docker.state === 'failed' && (
        <p className="note error">Wirescry couldn&apos;t set itself up for Docker: {docker.error}</p>
      )}
    </section>
  );
}
