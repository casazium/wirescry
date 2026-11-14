import { useEffect, useRef, useState } from 'react';
import type { JavaAttachStatus, JavaProgram } from '../../shared/api';
import type { Command } from './api-client';

interface Props {
  attach: JavaAttachStatus | undefined;
  /** The operating system the backend runs on, for which JDK attaching needs. */
  platform: string;
  connected: boolean;
  send: (command: Command) => Promise<unknown>;
}

/** What a program's agent is doing, in words. */
function agentText(agent: NonNullable<JavaProgram['agent']>): string {
  if (agent.outdated)
    return 'Runs the agent from another version of Wirescry: restart the program to update it.';
  switch (agent.reason) {
    case 'on':
      return agent.current
        ? `Sending its traffic through Wirescry${agent.route === 'startup' ? ' (started with the agent)' : ''}.`
        : 'Taking up Wirescry’s current settings…';
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
      return 'The agent is off.';
  }
}

function ProgramRow({
  program,
  disabled,
  onAttach,
  onDetach,
}: {
  program: JavaProgram;
  disabled: boolean;
  onAttach: () => void;
  onDetach: () => void;
}): React.JSX.Element {
  const { agent, busy } = program;
  const sending = agent?.on === true && agent.reason === 'on';
  return (
    <li>
      <span className="device-name">{program.name || `Process ${program.pid}`}</span>{' '}
      <span className="muted">
        {[`pid ${program.pid}`, agent?.java ? `Java ${agent.java}` : undefined].filter(Boolean).join(' · ')}
      </span>
      {agent && <div className="muted">{agentText(agent)}</div>}
      <div className="step-row">
        {sending ? (
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy !== undefined}
            onClick={onDetach}
          >
            {busy === 'detaching' ? 'Detaching…' : 'Detach'}
          </button>
        ) : agent?.reason === 'startup-off' || agent?.reason === 'detaching' ? null : (
          <button type="button" disabled={disabled || busy !== undefined} onClick={onAttach}>
            {busy === 'attaching' ? 'Attaching…' : 'Attach'}
          </button>
        )}
      </div>
      {program.note && (
        <p className="note" role="status">
          {program.note}
        </p>
      )}
    </li>
  );
}

/** Attaching Wirescry's agent to Java programs that are already running. */
export function JavaPrograms({ attach, platform, connected, send }: Props): React.JSX.Element {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  /** The program whose attach waits on the user agreeing to Java 21's warning. */
  const [warningFor, setWarningFor] = useState<number>();
  const [pidText, setPidText] = useState('');
  const asked = useRef(false);

  const checkAgain = (): void => {
    setError(undefined);
    setChecking(true);
    send({ command: 'javaRefresh' })
      .catch((e: Error) => setError(e.message))
      .finally(() => setChecking(false));
  };

  // The first time Setup shows this, look: listing runs a short Java program, so not before.
  useEffect(() => {
    if (attach || asked.current || !connected) return;
    asked.current = true;
    checkAgain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach, connected]);

  /** An error is shown here unless the backend noted it on the program, which the list shows. */
  const failed =
    (pid: number) =>
    (e: Error): void => {
      if (!attach?.programs.some((p) => p.pid === pid && p.note === e.message)) setError(e.message);
    };

  const attachPid = (pid: number, confirmWarning: boolean): void => {
    setError(undefined);
    send({ command: 'javaAttach', pid, ...(confirmWarning ? { confirmWarning: true } : {}) }).then(
      (reply) => {
        if ((reply as { needsConfirmation?: string } | undefined)?.needsConfirmation) setWarningFor(pid);
        else setWarningFor(undefined);
      },
      (e: Error) => {
        setWarningFor(undefined);
        failed(pid)(e);
      },
    );
  };

  const detachPid = (pid: number): void => {
    setError(undefined);
    send({ command: 'javaDetach', pid }).catch(failed(pid));
  };

  const pid = /^\d{1,10}$/.test(pidText.trim()) ? Number(pidText.trim()) : undefined;
  const busy = !connected;
  const minimum = platform === 'win32' ? '11' : '17';

  return (
    <>
      <h3>Running programs</h3>
      <p className="muted">
        Attach the agent to a Java program that&apos;s already running, without restarting it. Detach turns it
        off again.
      </p>
      {(!attach || attach.state === 'checking') && (checking || attach) && (
        <p className="muted">Looking for Java programs…</p>
      )}
      {attach?.state === 'no-jdk' && (
        <div className="note" role="status">
          <p>
            Attaching needs a JDK {minimum} or later (a full JDK, not just a runtime). Wirescry looks in{' '}
            <code>JAVA_HOME</code>, then for <code>java</code> on your PATH
            {platform === 'darwin' ? ', then among the JDKs macOS knows' : ''}. Install one, or point{' '}
            <code>JAVA_HOME</code> at one and restart Wirescry, then check again.
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
      {attach && attach.state !== 'checking' && attach.state !== 'no-jdk' && attach.programs.length === 0 && (
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
              disabled={busy}
              onAttach={() => attachPid(program.pid, false)}
              onDetach={() => detachPid(program.pid)}
            />
          ))}
        </ul>
      )}
      {warningFor !== undefined && (
        <div className="callout warn" role="alert">
          <p>
            This program runs Java 21 or later, which prints a warning on its standard error when an agent is
            attached while it runs (&quot;WARNING: A Java agent has been loaded dynamically…&quot;). The
            program carries on as before. Attach anyway? Wirescry won&apos;t ask again.
          </p>
          <button type="button" disabled={busy} onClick={() => attachPid(warningFor, true)}>
            Attach
          </button>{' '}
          <button type="button" className="secondary" onClick={() => setWarningFor(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {attach && attach.state !== 'no-jdk' && (
        <form
          className="step-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (pid !== undefined) attachPid(pid, false);
          }}
        >
          <label>
            Attach by process id{' '}
            <input
              type="text"
              inputMode="numeric"
              size={10}
              value={pidText}
              onChange={(e) => setPidText(e.target.value)}
              aria-label="Process id"
            />
          </label>{' '}
          <button type="submit" className="secondary" disabled={busy || pid === undefined}>
            Attach
          </button>
        </form>
      )}
      <p>
        <button
          type="button"
          className="secondary"
          onClick={checkAgain}
          disabled={!connected || checking || attach?.state === 'checking'}
        >
          {checking || attach?.state === 'checking' ? 'Checking…' : 'Check again'}
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
