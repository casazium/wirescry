import { useState } from 'react';
import type { McpStatus } from '../../shared/api';
import type { Command } from './api-client';
import { agentConfigs, MCP_SECTION_ID } from './mcp-config';

function Copy({ text, label = 'Copy' }: { text: string; label?: string }): React.JSX.Element {
  const [result, setResult] = useState<string>();
  return (
    <button
      type="button"
      className="secondary small"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setResult('Copied');
            setTimeout(() => setResult(undefined), 1500);
          },
          () => setResult('Couldn’t copy'),
        )
      }
    >
      {result ?? label}
    </button>
  );
}

const time = (at: number): string => new Date(at).toLocaleTimeString();

/** Setup's "AI agents (MCP)": lets agents read captured traffic, masked, through the MCP server. */
export function McpSection({
  mcp,
  connected,
  send,
}: {
  mcp: McpStatus | undefined;
  connected: boolean;
  send(command: Command): Promise<unknown>;
}): React.JSX.Element {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // What's typed in the port field, until applied; the saved port otherwise.
  const [portEdit, setPortEdit] = useState<string>();
  const portText = portEdit ?? String(mcp?.port ?? '');

  const change = (command: { enabled?: boolean; port?: number; resetToken?: boolean }): void => {
    setError(undefined);
    setBusy(true);
    if (command.port !== undefined) setPortEdit(undefined);
    send({ command: 'setMcp', ...command })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const on = mcp?.enabled === true;
  const token = mcp?.token;
  return (
    <section id={MCP_SECTION_ID} aria-labelledby={`${MCP_SECTION_ID}-heading`}>
      <h2 id={`${MCP_SECTION_ID}-heading`}>AI agents (MCP)</h2>
      <p className="muted">
        Lets AI coding agents such as Claude Code, Cursor and VS Code read the traffic Wirescry captures,
        through MCP. They can list requests and read headers, bodies, WebSocket messages and events. They
        can’t change anything, and secrets are always replaced with [redacted] (best effort for bodies).
      </p>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={on}
          disabled={!connected || busy || mcp === undefined}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        Let AI agents read captured traffic
      </label>
      {mcp?.problem && (
        <p className="note error" role="alert">
          {mcp.problem}
        </p>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
      {on && token && (
        <>
          <dl className="facts">
            <dt>Address</dt>
            <dd>
              <code className="wrap">{mcp.url}</code> <Copy text={mcp.url} />
              {!mcp.listening && <span className="muted"> (not listening)</span>}
            </dd>
            <dt>Token</dt>
            <dd>
              <code className="wrap" aria-label={showToken ? 'Token' : 'Token, hidden'}>
                {showToken ? token : '•'.repeat(16)}
              </code>{' '}
              <button type="button" className="secondary small" onClick={() => setShowToken((s) => !s)}>
                {showToken ? 'Hide' : 'Show'}
              </button>{' '}
              <Copy text={token} />{' '}
              {confirmReset ? (
                <>
                  <button
                    type="button"
                    className="danger small"
                    onClick={() => {
                      setConfirmReset(false);
                      change({ resetToken: true });
                    }}
                  >
                    Make a new token
                  </button>{' '}
                  <button type="button" className="secondary small" onClick={() => setConfirmReset(false)}>
                    Cancel
                  </button>
                  <span className="muted"> Agents set up with the old one stop working.</span>
                </>
              ) : (
                <button type="button" className="secondary small" onClick={() => setConfirmReset(true)}>
                  Reset…
                </button>
              )}
            </dd>
            <dt>Port</dt>
            <dd>
              <input
                type="number"
                min={1024}
                max={65535}
                className="port-input"
                aria-label="MCP port"
                value={portText}
                onChange={(e) => setPortEdit(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && change({ port: Number(portText) })}
              />{' '}
              <button
                type="button"
                className="secondary small"
                disabled={busy || Number(portText) === mcp.port}
                onClick={() => change({ port: Number(portText) })}
              >
                Apply
              </button>
            </dd>
          </dl>
          <p className="note">
            Anything that can read the token can read your captured traffic, masked. Agents keep it in their
            settings files. Traffic can also contain text written to mislead an agent: Wirescry marks it as
            data, but review what an agent does with it.
          </p>
          <h3>Set up an agent</h3>
          {agentConfigs(mcp.url, token).map((config) => (
            <div key={config.name} className="config">
              <div className="config-head">
                <strong>{config.name}</strong> <Copy text={config.text} />
              </div>
              <pre className="code">{config.text.split(token).join(showToken ? token : '•'.repeat(16))}</pre>
            </div>
          ))}
          <h3>Recent calls</h3>
          {mcp.activity.length === 0 ? (
            <p className="muted">No agent has called yet.</p>
          ) : (
            <table className="headers" aria-label="Recent MCP calls">
              <tbody>
                {mcp.activity.map((a, i) => (
                  <tr key={`${a.at}-${i}`}>
                    <th scope="row">{time(a.at)}</th>
                    <td>
                      {a.tool} ({a.args}){a.ok ? '' : ', failed'}
                      {a.client && <span className="muted"> by {a.client}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
