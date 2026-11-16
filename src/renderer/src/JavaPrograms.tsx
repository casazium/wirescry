import { useCallback, useEffect, useRef, useState } from 'react';
import type { JavaAttachStatus, JavaProgram } from '../../shared/api';
import type { Command } from './api-client';

interface Props {
  attach: JavaAttachStatus | undefined;
  /** The operating system the backend runs on, for which JDK attaching needs. */
  platform: string;
  connected: boolean;
  send: (command: Command) => Promise<unknown>;
}

type Agent = NonNullable<JavaProgram['agent']>;

/** A hook the agent reports as `name:state` (Hooks.java), or undefined. */
const hook = (agent: Agent, name: string): string | undefined =>
  agent.hooks.find((h) => h.startsWith(`${name}:`))?.slice(name.length + 1);

/** What an agent that's on is doing, from its hooks. */
function onText(agent: Agent): string {
  const trust = hook(agent, 'trust');
  const proxy = hook(agent, 'proxy');
  const apache = hook(agent, 'apache');
  const jetty = hook(agent, 'jetty');
  const reactorNetty = hook(agent, 'reactor-netty');
  // Apache's, Jetty's and Reactor Netty's classes are old bytecode: a weave it can't read isn't about the program's Java.
  if (trust === 'jdk-too-new' || proxy === 'jdk-too-new') {
    return 'This program’s Java is newer than Wirescry’s agent supports: its traffic may not reach Wirescry.';
  }
  if (
    trust === 'failed' ||
    proxy === 'failed' ||
    apache === 'failed' ||
    apache === 'jdk-too-new' ||
    jetty === 'failed' ||
    jetty === 'jdk-too-new' ||
    reactorNetty === 'failed' ||
    reactorNetty === 'jdk-too-new'
  ) {
    return 'The agent couldn’t set itself up in this program: its traffic may not reach Wirescry.';
  }
  if (proxy === 'app-selector') {
    return 'This program chooses its own proxy, which the agent leaves alone: its traffic may not reach Wirescry.';
  }
  if (trust && trust !== 'ok' && trust !== 'waiting') {
    return 'The agent can’t use Wirescry’s certificate yet, so this program may refuse its HTTPS.';
  }
  if (jetty === 'not-covered') {
    return 'This program’s Jetty is older than the agent covers: its Jetty requests may not reach Wirescry.';
  }
  if (!agent.current) return 'Updating to Wirescry’s current settings…';
  const sending = `Sending its traffic through Wirescry${agent.route === 'startup' ? ' (started with the agent)' : ''}.`;
  // Clients whose transport can't use a proxy (HTTP/2 only, PROXY protocol, a Unix socket): left alone.
  const notes: string[] = [];
  if (hook(agent, 'jetty-skipped')) {
    notes.push('Some of its Jetty clients can’t go through a proxy, and connect directly.');
  }
  // Netty's proxy support (netty-handler-proxy) is optional: without it the rest still comes.
  if (reactorNetty === 'no-proxy-handler') {
    notes.push(
      'Its Reactor Netty requests connect directly: it lacks Netty’s proxy support (netty-handler-proxy).',
    );
  }
  return [sending, ...notes].join(' ');
}

/** What a program's agent is doing, in words. */
function agentText(agent: Agent): string {
  switch (agent.reason) {
    case 'on':
      return onText(agent);
    case 'detaching':
      return 'Detaching…';
    case 'detached':
      return 'Detached: the agent stays loaded, and sends nothing to Wirescry.';
    case 'startup-off':
      return 'Started with the agent, which is off while the setting above is off.';
    case 'unsafe-files':
      return 'The agent is off: other users can change Wirescry’s agent files.';
    case 'bad-control':
    case 'no-control':
      return 'The agent is off: it can’t read Wirescry’s settings.';
    default:
      return 'The agent is off until Wirescry is running.';
  }
}

/** Java 21's warning, before an attach: the program's name in it. */
function WarningCallout({
  name,
  disabled,
  onAttach,
  onCancel,
}: {
  name: string;
  disabled: boolean;
  onAttach: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="callout warn" role="alert">
      <p>
        {name} runs Java 21 or later, which prints a warning on the program&apos;s standard error when an
        agent is attached while it runs (&quot;WARNING: A Java agent has been loaded dynamically…&quot;). The
        program carries on as before. Attach anyway? Wirescry won&apos;t ask again.
      </p>
      <button type="button" disabled={disabled} onClick={onAttach}>
        Attach anyway
      </button>{' '}
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** Sends an attach or detach, asking first about Java 21's warning: for a row, or the pid form. */
function useAttach(send: (command: Command) => Promise<unknown>) {
  const [warning, setWarning] = useState(false);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const run = (command: Command): void => {
    setError(undefined);
    setSending(true);
    send(command)
      .then(
        (reply) =>
          setWarning((reply as { needsConfirmation?: string } | undefined)?.needsConfirmation !== undefined),
        (e: Error) => {
          setWarning(false);
          setError(e.message);
        },
      )
      .finally(() => setSending(false));
  };
  return {
    warning,
    error,
    sending,
    attach: (pid: number, confirmWarning = false) =>
      run({ command: 'javaAttach', pid, ...(confirmWarning ? { confirmWarning: true } : {}) }),
    detach: (pid: number) => run({ command: 'javaDetach', pid }),
    cancel: () => setWarning(false),
  };
}

function ProgramRow({
  program,
  canAttach,
  disabled,
  send,
}: {
  program: JavaProgram;
  /** A JDK to attach with was found. */
  canAttach: boolean;
  disabled: boolean;
  send: (command: Command) => Promise<unknown>;
}): React.JSX.Element {
  const { warning, error, sending, attach, detach, cancel } = useAttach(send);
  const { agent, busy } = program;
  const label = program.name || 'Unknown program';
  const off = disabled || sending || busy !== undefined;
  // Detach while it's on; Attach where there's none (given a JDK), or it's detached or detaching
  // (Attach undoes that). Otherwise it's off for a reason Attach can't change.
  const action =
    agent?.reason === 'on'
      ? 'detach'
      : !agent
        ? canAttach
          ? 'attach'
          : undefined
        : agent.reason === 'detached' || agent.reason === 'detaching'
          ? 'attach'
          : undefined;
  // One place for what went wrong: the backend notes most refusals on the program as well.
  const message = error ?? program.note;
  return (
    <li>
      <span className="device-name">{label}</span>{' '}
      <span className="muted">
        {[`pid ${program.pid}`, agent?.java ? `Java ${agent.java}` : undefined].filter(Boolean).join(' · ')}
      </span>
      {agent && <div className="muted">{agentText(agent)}</div>}
      {agent?.outdated && (
        <div className="muted">
          It runs the agent from another version of Wirescry: restart the program to update it.
        </div>
      )}
      {warning ? (
        <WarningCallout
          name={label}
          disabled={off}
          onAttach={() => attach(program.pid, true)}
          onCancel={cancel}
        />
      ) : action === 'detach' ? (
        <div className="step-row">
          <button
            type="button"
            className="secondary"
            disabled={off}
            aria-label={`Detach ${label}`}
            onClick={() => detach(program.pid)}
          >
            {busy === 'detaching' ? 'Detaching…' : 'Detach'}
          </button>
        </div>
      ) : action === 'attach' ? (
        <div className="step-row">
          <button
            type="button"
            disabled={off}
            aria-label={`Attach ${label}`}
            onClick={() => attach(program.pid)}
          >
            {busy === 'attaching' ? 'Attaching…' : 'Attach'}
          </button>
        </div>
      ) : null}
      {message && (
        <p className={error ? 'note error' : 'note'} role={error ? 'alert' : 'status'}>
          {message}
        </p>
      )}
    </li>
  );
}

/** Attaching to a program by its process id, for one the list doesn't show. */
function PidForm({
  disabled,
  send,
}: {
  disabled: boolean;
  send: (command: Command) => Promise<unknown>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const { warning, error, sending, attach, cancel } = useAttach(send);
  const trimmed = text.trim();
  const pid = /^[1-9]\d{0,9}$/.test(trimmed) ? Number(trimmed) : undefined;
  return (
    <>
      <form
        className="step-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (pid !== undefined) attach(pid);
        }}
      >
        <label>
          Attach by process id{' '}
          <input
            type="text"
            inputMode="numeric"
            size={10}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              cancel();
            }}
          />
        </label>{' '}
        <button type="submit" className="secondary" disabled={disabled || sending || pid === undefined}>
          Attach
        </button>
      </form>
      {warning && pid !== undefined && (
        <WarningCallout
          name={`Process ${pid}`}
          disabled={disabled || sending}
          onAttach={() => attach(pid, true)}
          onCancel={cancel}
        />
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Attaching Wirescry's agent to Java programs that are already running. */
export function JavaPrograms({ attach, platform, connected, send }: Props): React.JSX.Element {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  /** Whether this connection has looked: once per connection, not on every render. */
  const asked = useRef(false);

  const checkAgain = useCallback((): void => {
    setError(undefined);
    setChecking(true);
    send({ command: 'javaRefresh' })
      .catch((e: Error) => setError(e.message))
      .finally(() => setChecking(false));
  }, [send]);

  // Look when first shown, and after reconnecting to a backend that hasn't looked: listing runs a
  // short Java program, so only then.
  useEffect(() => {
    if (!connected) {
      asked.current = false;
      return;
    }
    if (attach || asked.current) return;
    asked.current = true;
    checkAgain();
  }, [attach, connected, checkAgain]);

  const looking = checking || attach?.state === 'checking';
  const disabled = !connected;
  const canAttach = attach?.state === 'ready' || attach?.state === 'failed';

  return (
    <>
      <h3>Running programs</h3>
      <p className="muted">
        Attach the agent to a Java program that&apos;s already running, without restarting it. Detach turns it
        off again.
      </p>
      {looking && (
        <p className="muted" role="status">
          Looking for Java programs…
        </p>
      )}
      {attach?.state === 'no-jdk' && (
        <div className="note" role="status">
          <p>
            Attaching needs a JDK {platform === 'win32' ? '11' : '17'} or later (a full JDK, not just a
            runtime). Wirescry looks in <code>JAVA_HOME</code>, then for <code>java</code> on your PATH
            {platform === 'darwin' ? ', then among the JDKs macOS knows' : ''}.{' '}
            {platform === 'darwin'
              ? 'Install one, then check again.'
              : 'Install one, then restart Wirescry so it sees the new PATH or JAVA_HOME.'}
          </p>
          {attach.passed && attach.passed.length > 0 && (
            <details>
              <summary>What Wirescry found</summary>
              <ul>
                {attach.passed.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {attach?.state === 'failed' && (
        <p className="note" role="status">
          {attach.error}
        </p>
      )}
      {attach && !looking && attach.state !== 'no-jdk' && attach.programs.length === 0 && (
        <p className="muted">
          No running Java programs found. Programs run by other users aren&apos;t shown.
        </p>
      )}
      {attach && attach.programs.length > 0 && (
        <ul className="device-list" aria-label="Running Java programs">
          {attach.programs.map((program) => (
            <ProgramRow
              key={program.pid}
              program={program}
              canAttach={canAttach}
              disabled={disabled}
              send={send}
            />
          ))}
        </ul>
      )}
      {canAttach && <PidForm disabled={disabled} send={send} />}
      <p>
        <button type="button" className="secondary" onClick={checkAgain} disabled={disabled || looking}>
          {looking ? 'Checking…' : 'Check again'}
        </button>
      </p>
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
