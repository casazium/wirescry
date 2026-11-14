import { useState } from 'react';
import type { ProxyStatus } from '../../shared/api';
import { jvmOptionForms } from '../../shared/terminal-env';
import type { Command } from './api-client';
import { JavaPrograms } from './JavaPrograms';

interface Props {
  status: ProxyStatus;
  connected?: boolean;
  send?: (command: Command) => Promise<unknown>;
  CopyButton?: (props: { text: string; label?: string }) => React.JSX.Element;
}

/**
 * Java programs and Wirescry's agent: the setting for programs started with it, the option to copy,
 * and attaching to programs already running.
 */
export function JavaSection({ status, connected = true, send, CopyButton }: Props): React.JSX.Element | null {
  const java = status.javaAgent;
  const [error, setError] = useState<string>();
  if (!java) return null;
  const toggle = (enabled: boolean): void => {
    setError(undefined);
    send?.({ command: 'setJavaAgentStartup', enabled }).catch((e: Error) => setError(e.message));
  };
  const forms = java.stubPath && !java.problem ? jvmOptionForms(java.stubPath) : undefined;
  return (
    <section>
      <h2>Java programs</h2>
      <p className="muted">
        Wirescry&apos;s Java agent sends a Java program&apos;s HTTP and HTTPS traffic through Wirescry, and
        trusts its certificate: HttpURLConnection, Java&apos;s HttpClient, OkHttp, Apache HttpClient 4 and 5,
        and libraries built on them, even when the program chose its own trust store. Java 8 and later.
      </p>
      {send && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={java.startup}
            disabled={!connected}
            onChange={(e) => toggle(e.target.checked)}
          />{' '}
          Load the agent in Java programs started from Wirescry terminals, or with the option below
        </label>
      )}
      {java.startup && (
        <p className="muted">
          Programs on Java 7 or older, or on a trimmed runtime without agent support (some tools bundle one),
          won&apos;t start with it. Start one with <code>JAVA_TOOL_OPTIONS=</code> in front of its command.
        </p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      {java.problem && (
        <p className="note error" role="alert">
          {java.problem}
        </p>
      )}
      {java.startup && !java.stubPath && !java.problem && <p className="muted">Setting up the agent…</p>}
      {java.startup && forms && CopyButton && (
        <>
          <h3>Programs started elsewhere</h3>
          <p className="muted">
            Add this option to the program&apos;s Java command, or to the VM options of its run configuration
            in your IDE:
          </p>
          <div className="snippet">
            <pre className="code">{forms.quoted}</pre>
            <CopyButton text={forms.quoted} />
          </div>
          <p className="muted">
            Where a setting takes each option as one argument, such as Gradle&apos;s <code>jvmArgs</code>, use
            it without quotes:
          </p>
          <div className="snippet">
            <pre className="code">{forms.plain}</pre>
            <CopyButton text={forms.plain} />
          </div>
        </>
      )}
      {/* With a problem (the agent missing, or a path Java can't take), attaching can't work either. */}
      {send && !java.problem && (
        <JavaPrograms attach={java.attach} platform={status.platform} connected={connected} send={send} />
      )}
      <details className="coverage">
        <summary>How it works</summary>
        <ul>
          <li>
            Terminals Wirescry opens, and the setup lines above, add the agent to{' '}
            <code>JAVA_TOOL_OPTIONS</code> after any options you already set there (Command Prompt&apos;s
            setup lines replace them). A value your shell profile sets replaces Wirescry&apos;s in the
            terminals it opens; set yours in the terminal instead, or after its setup. Every <code>java</code>{' '}
            command prints a &quot;Picked up JAVA_TOOL_OPTIONS&quot; line; that&apos;s the JVM confirming it.
            Java 8 ignores that variable whole when it&apos;s over 1,024 bytes, so Wirescry leaves the agent
            out when it would be.
          </li>
          <li>
            The agent sends <code>http</code> and <code>https</code> requests to Wirescry when the program
            hasn&apos;t chosen a proxy of its own. It leaves alone requests to this computer, hosts in the
            program&apos;s <code>http.nonProxyHosts</code>, a company proxy and other connections, such as
            databases.
          </li>
          <li>
            The option stays useful: a program started with it is captured whenever Wirescry is running with
            this setting on. While Wirescry isn&apos;t, the agent does nothing, and the program connects
            directly. The option names a file in Wirescry&apos;s data folder; remove it before deleting that
            folder, or Java won&apos;t start the program.
          </li>
          <li>
            Some programs ship their own trimmed Java runtime without agent support, and Java 7 and older
            can&apos;t load it: those refuse to start with the agent. Remove the option for them. In a
            Wirescry terminal, start one with <code>JAVA_TOOL_OPTIONS=</code> in front of its command, or turn
            this setting off and open a new terminal.
          </li>
          <li>
            Attaching runs a short Java program from a JDK on this computer (17 or later; 11 on Windows),
            which asks Java to load the agent into the running program. It works for programs run by you, with
            HotSpot-based Java (OpenJDK, Temurin, Oracle and most others) 8 and later. It doesn&apos;t work
            for programs in containers, run as administrator or by another user, GraalVM native images, or
            OpenJ9. Security software on Windows may flag it, since it acts on another program.
          </li>
          <li>
            An agent can&apos;t be removed from a running program: Detach turns it off, and it puts back what
            it changed. Programs stay detached when Wirescry restarts. An attached program goes on sending its
            traffic through Wirescry whenever Wirescry runs, until you detach it or it ends.
          </li>
          <li>
            When Wirescry quits, the agent turns off within a second (about 15 on Java 8), and programs
            started from its terminals connect directly instead of to the closed proxy.
          </li>
        </ul>
      </details>
    </section>
  );
}
