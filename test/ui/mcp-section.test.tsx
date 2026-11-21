/**
 * Setup's "AI agents (MCP)" section, its helpers, and the toolbar's "Agent active" badge.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpStatus, ServerMessage } from '../../src/shared/api';
import type { BackendState, WirescryBridge } from '../../src/shared/ipc';
import { McpSection } from '../../src/renderer/src/McpSection';
import { ACTIVE_MS, agentActive, agentConfigs } from '../../src/renderer/src/mcp-config';
import { status } from './fixtures';

const TOKEN = 'T0k3n' + 'x'.repeat(38);
const on: McpStatus = {
  enabled: true,
  port: 45450,
  url: 'http://127.0.0.1:45450/mcp',
  token: TOKEN,
  listening: true,
  activity: [],
};

let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});

describe('agentActive and agentConfigs', () => {
  it('counts an agent active for a minute after its last call, while listening', () => {
    const at = 1_000_000;
    const recent = { ...on, activity: [{ tool: 'get_body', args: '', ok: true, at, client: '' }] };
    expect(agentActive(recent, at + 1)).toBe(true);
    expect(agentActive(recent, at + ACTIVE_MS - 1)).toBe(true);
    expect(agentActive(recent, at + ACTIVE_MS)).toBe(false);
    expect(agentActive({ ...recent, listening: false }, at + 1)).toBe(false);
    expect(agentActive(on, at)).toBe(false);
    expect(agentActive(undefined, at)).toBe(false);
  });

  it('gives each agent’s settings with the URL and token', () => {
    const configs = agentConfigs(on.url, TOKEN);
    expect(configs.map((c) => c.name)).toEqual([
      'Claude Code (run in a terminal)',
      'Cursor (.cursor/mcp.json)',
      'VS Code (.vscode/mcp.json)',
    ]);
    for (const c of configs) {
      expect(c.text).toContain(on.url);
      expect(c.text).toContain(`Bearer ${TOKEN}`);
    }
    expect(JSON.parse(configs[2]!.text)).toEqual({
      servers: { wirescry: { type: 'http', url: on.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
  });
});

describe('McpSection', () => {
  const send = vi.fn(async () => undefined);
  const section = (mcp: McpStatus | undefined, connected = true) =>
    render(<McpSection mcp={mcp} connected={connected} send={send} />);
  const box = () => screen.getByRole('checkbox', { name: 'Let AI agents read captured traffic' });

  beforeEach(() => send.mockClear());

  it('is off by default, showing no address or token, and turns on', async () => {
    section({ ...on, enabled: false, listening: false, token: undefined });
    expect((box() as HTMLInputElement).checked).toBe(false);
    expect(document.body.textContent).not.toContain(on.url);
    await act(async () => void fireEvent.click(box()));
    expect(send).toHaveBeenCalledWith({ command: 'setMcp', enabled: true });
  });

  it('can’t be switched while disconnected or not yet known', () => {
    section(on, false);
    expect((box() as HTMLInputElement).disabled).toBe(true);
  });

  it('shows the address, hides the token until asked, and copies the real one', async () => {
    section(on);
    expect(document.body.textContent).toContain(on.url);
    expect(document.body.textContent).not.toContain(TOKEN);
    const copies = screen.getAllByRole('button', { name: 'Copy' });
    await act(async () => void fireEvent.click(copies[1]!));
    expect(clipboard).toHaveBeenLastCalledWith(TOKEN);
    // The settings shown hide it too, and copy with it.
    await act(async () => void fireEvent.click(copies[2]!));
    expect(clipboard.mock.calls.at(-1)![0]).toContain(`Bearer ${TOKEN}`);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Show' })));
    expect(document.body.textContent).toContain(TOKEN);
  });

  it('makes a new token only after confirming', async () => {
    section(on);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Reset…' })));
    expect(send).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Make a new token' })));
    expect(send).toHaveBeenCalledWith({ command: 'setMcp', resetToken: true });
  });

  it('applies a new port, and says when it can’t listen', async () => {
    const view = section(on);
    const port = screen.getByRole('spinbutton', { name: 'MCP port' });
    expect((port as HTMLInputElement).value).toBe('45450');
    await act(async () => void fireEvent.change(port, { target: { value: '45999' } }));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Apply' })));
    expect(send).toHaveBeenCalledWith({ command: 'setMcp', port: 45999 });
    view.rerender(
      <McpSection
        mcp={{ ...on, listening: false, problem: 'Port 45999 is in use by another program.' }}
        connected
        send={send}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('in use');
  });

  it('lists recent calls by tool and client, or says there are none', () => {
    const view = section(on);
    expect(screen.getByText('No agent has called yet.')).toBeTruthy();
    view.rerender(
      <McpSection
        mcp={{
          ...on,
          activity: [
            {
              tool: 'get_body',
              args: 'abc, response, offset 0',
              ok: false,
              at: 0,
              client: 'claude-code/2.1',
            },
          ],
        }}
        connected
        send={send}
      />,
    );
    expect(screen.getByRole('table', { name: 'Recent MCP calls' }).textContent).toContain(
      'get_body (abc, response, offset 0), failed by claude-code/2.1',
    );
  });
});

/** The App, for the toolbar badge. */
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  mcp: undefined as unknown,
}));
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: { command: string }) =>
      command.command === 'getMcp' ? fake.mcp : undefined,
    );
    close = vi.fn();
    constructor(
      public connection: unknown,
      public onMessage: (message: unknown) => void,
    ) {
      fake.clients.push(this);
    }
  },
}));
const { App } = await import('../../src/renderer/src/App');

describe('the toolbar badge', () => {
  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    fake.clients.length = 0;
    fake.mcp = on;
    const ready = {
      state: 'ready',
      connection: { apiUrl: 'ws://127.0.0.1:9001/', token: 't' },
      generation: 1,
    } as BackendState;
    window.wirescry = new Proxy(
      {
        getBackendState: async () => ready,
        onBackendStateChanged: () => () => undefined,
        onMenuCommand: () => () => undefined,
        setMenuState: () => undefined,
      },
      { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
    ) as unknown as WirescryBridge;
  });

  async function started(): Promise<void> {
    render(<App />);
    await act(async () => undefined);
    await act(async () =>
      fake.clients.at(-1)!.onMessage({
        type: 'hello',
        status: {
          ...status(),
          certificate: {
            commonName: 'Test CA',
            spkiFingerprint: 'f',
            sha256: 's',
            validTo: new Date().toISOString(),
            path: '/ca.pem',
          },
        },
        exchanges: [],
        paused: false,
      } as ServerMessage),
    );
    await act(async () => undefined);
  }
  const badge = () => screen.queryByRole('button', { name: 'Agent active' });

  it('shows while an agent called in the last minute, and opens Setup’s section', async () => {
    await started();
    expect(badge()).toBeNull();
    await act(async () =>
      fake.clients.at(-1)!.onMessage({
        type: 'mcp',
        status: {
          ...on,
          activity: [{ tool: 'list_exchanges', args: '', ok: true, at: Date.now(), client: '' }],
        },
      } as ServerMessage),
    );
    await act(async () => undefined);
    expect(badge()).toBeTruthy();
    // jsdom has no scrollIntoView: a stand-in, to see the section brought into view.
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await act(async () => void fireEvent.click(badge()!));
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(document.getElementById('mcp-section')).toBeTruthy();
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts[0]).toBe(document.getElementById('mcp-section'));
  });

  it('doesn’t show for a call over a minute ago', async () => {
    fake.mcp = {
      ...on,
      activity: [
        { tool: 'list_exchanges', args: '', ok: true, at: Date.now() - ACTIVE_MS - 1000, client: '' },
      ],
    };
    await started();
    expect(badge()).toBeNull();
  });
});
