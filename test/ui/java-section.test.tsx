import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JavaAgentStatus, JavaAttachStatus, JavaProgram, ProxyStatus } from '../../src/shared/api';
import { JavaSection } from '../../src/renderer/src/JavaSection';
import type { Command } from '../../src/renderer/src/api-client';
import { status } from './fixtures';

const STUB = '/Users/me/Library/Application Support/Wirescry/java-agent/wirescry-agent.jar';
const withJava = (javaAgent?: JavaAgentStatus): ProxyStatus => ({
  ...status(),
  ...(javaAgent ? { javaAgent } : {}),
});

function copyButton() {
  const copied: string[] = [];
  const CopyButton = ({ text }: { text: string }) => (
    <button type="button" onClick={() => copied.push(text)}>
      Copy
    </button>
  );
  return { copied, CopyButton };
}

describe('Java section', () => {
  it('isn’t shown where the backend has no agent', () => {
    const { container } = render(<JavaSection status={withJava()} />);
    expect(container.textContent).toBe('');
  });

  it('turns the setting on and off', () => {
    const send = vi.fn(async () => undefined);
    const { rerender } = render(<JavaSection status={withJava({ startup: false })} send={send} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(send).toHaveBeenLastCalledWith({ command: 'setJavaAgentStartup', enabled: true });
    rerender(<JavaSection status={withJava({ startup: true, stubPath: STUB })} send={send} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(send).toHaveBeenLastCalledWith({ command: 'setJavaAgentStartup', enabled: false });
  });

  it('can’t be changed while disconnected', () => {
    render(
      <JavaSection
        status={withJava({ startup: false })}
        send={vi.fn(async () => undefined)}
        connected={false}
      />,
    );
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('says why a change failed', async () => {
    const send = vi.fn(async (command: Command) => {
      if (command.command === 'setJavaAgentStartup') throw new Error('Java setup is off.');
      return undefined;
    });
    render(<JavaSection status={withJava({ startup: false })} send={send} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((await screen.findByRole('alert')).textContent).toBe('Java setup is off.');
  });

  it('offers the option in both forms once the agent is in place', () => {
    const { copied, CopyButton } = copyButton();
    render(
      <JavaSection
        status={withJava({ startup: true, stubPath: STUB })}
        send={vi.fn(async () => undefined)}
        CopyButton={CopyButton}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Copy' });
    for (const button of buttons) fireEvent.click(button);
    expect(copied).toEqual([`"-javaagent:${STUB}"`, `-javaagent:${STUB}`]);
  });

  it('offers no option while off, while setting up, or when the path can’t be used', () => {
    const { CopyButton } = copyButton();
    const { rerender } = render(
      <JavaSection
        status={withJava({ startup: false, stubPath: STUB })}
        send={vi.fn(async () => undefined)}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    rerender(
      <JavaSection
        status={withJava({ startup: true })}
        send={vi.fn(async () => undefined)}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.getByText('Setting up the agent…')).toBeTruthy();
    const problem = "Wirescry's data folder has = or a quote in its path";
    rerender(
      <JavaSection
        status={withJava({ startup: true, stubPath: '/a=b/wirescry-agent.jar', problem })}
        send={vi.fn(async () => undefined)}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(problem);
    expect(screen.queryByText('Setting up the agent…')).toBeNull();
  });
});

describe('Java section, running programs', () => {
  const attach = (change: Partial<JavaAttachStatus> = {}): JavaAttachStatus => ({
    state: 'ready',
    jdk: { home: '/jdk', version: '21.0.2' },
    programs: [],
    warningOk: false,
    ...change,
  });
  type Agent = NonNullable<JavaProgram['agent']>;
  const agent = (change: Partial<Agent> = {}): Agent => ({
    id: 'a1',
    route: 'attach',
    on: true,
    reason: 'on',
    java: '17.0.2',
    current: true,
    hooks: ['trust:ok', 'proxy:ok'],
    ...change,
  });
  const show = (
    a: JavaAttachStatus | undefined,
    send: (command: Command) => Promise<unknown> = vi.fn(async () => undefined),
    platform: ProxyStatus['platform'] = 'darwin',
    connected = true,
  ) => {
    const props = (next: JavaAttachStatus | undefined, isConnected: boolean) => ({
      status: { ...withJava({ startup: false, ...(next ? { attach: next } : {}) }), platform },
      send,
      connected: isConnected,
    });
    const view = render(<JavaSection {...props(a, connected)} />);
    return {
      send,
      rerender: (next: JavaAttachStatus | undefined, isConnected = true) =>
        view.rerender(<JavaSection {...props(next, isConnected)} />),
    };
  };
  const list = () => screen.getByRole('list', { name: 'Running Java programs' });
  const row = (name: string) => within(list()).getByText(name).closest('li') as HTMLElement;
  const buttonIn = (name: string) => within(row(name)).queryByRole('button');
  const pidBox = () => screen.getByRole('textbox', { name: 'Attach by process id' });
  const pidButton = () =>
    screen.getAllByRole('button', { name: 'Attach' }).find((b) => b.closest('form')) as HTMLButtonElement;

  it('looks for programs once when first shown, again when asked, and after reconnecting', async () => {
    const { send, rerender } = show(undefined);
    expect(send).toHaveBeenCalledWith({ command: 'javaRefresh' });
    expect(screen.getByRole('status').textContent).toBe('Looking for Java programs…');
    // Renders before the backend answers don't look again.
    rerender(undefined);
    rerender(undefined);
    expect(send).toHaveBeenCalledTimes(1);
    rerender(attach({ programs: [{ pid: 10, name: 'Main' }] }));
    await waitFor(() => expect(screen.queryByText('Looking for Java programs…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(send).toHaveBeenCalledTimes(2);
    // A restarted backend that hasn't looked: once it's connected again.
    rerender(undefined, false);
    expect(send).toHaveBeenCalledTimes(2);
    rerender(undefined, true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('looks once, even when the page renders it again with a new send', () => {
    const calls = vi.fn<(command: Command) => Promise<unknown>>(async () => undefined);
    const status = { ...withJava({ startup: false }), platform: 'darwin' as const };
    const view = render(<JavaSection status={status} send={(c) => calls(c)} />);
    view.rerender(<JavaSection status={status} send={(c) => calls(c)} />);
    view.rerender(<JavaSection status={status} send={(c) => calls(c)} />);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('doesn’t look by itself once the backend has a list, or while disconnected', () => {
    const send = vi.fn(async () => undefined);
    show(attach(), send);
    expect(send).not.toHaveBeenCalled();
    show(undefined, send, 'darwin', false);
    expect(send).not.toHaveBeenCalled();
  });

  it('isn’t shown while the agent can’t be used', () => {
    const send = vi.fn(async () => undefined);
    render(<JavaSection status={withJava({ startup: false, problem: 'No agent here.' })} send={send} />);
    expect(screen.queryByText('Running programs')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('lists programs with what their agent is doing, and the button that fits', () => {
    show(
      attach({
        programs: [
          { pid: 10, name: 'Plain' },
          { pid: 11, name: 'app.jar', agent: agent() },
          { pid: 12, name: 'Started', agent: agent({ route: 'startup' }) },
          { pid: 13, name: 'Off', agent: agent({ on: false, reason: 'detached' }) },
          { pid: 14, name: 'Behind', agent: agent({ current: false }) },
          { pid: 15, name: 'Old', agent: agent({ outdated: true, on: false, reason: 'detached' }) },
          { pid: 16, name: 'Setting', agent: agent({ on: false, reason: 'startup-off', route: 'startup' }) },
          { pid: 17, name: '', agent: agent({ on: false, reason: 'unsafe-files' }) },
          { pid: 18, name: 'Going', agent: agent({ reason: 'detaching' }) },
          { pid: 19, name: 'Unread', agent: agent({ on: false, reason: 'bad-control' }) },
          { pid: 20, name: 'Gone', agent: agent({ on: false, reason: 'wirescry-gone' }) },
        ],
      }),
    );
    expect(buttonIn('Plain')?.textContent).toBe('Attach');
    expect(buttonIn('Plain')?.getAttribute('aria-label')).toBe('Attach Plain');
    expect(row('Plain').textContent).toContain('pid 10');
    expect(buttonIn('app.jar')?.getAttribute('aria-label')).toBe('Detach app.jar');
    expect(row('app.jar').textContent).toContain('Sending its traffic through Wirescry.');
    expect(row('app.jar').textContent).toContain('Java 17.0.2');
    expect(row('Started').textContent).toContain('(started with the agent)');
    expect(buttonIn('Started')?.textContent).toBe('Detach');
    expect(buttonIn('Off')?.textContent).toBe('Attach');
    expect(row('Off').textContent).toContain('Detached');
    expect(row('Behind').textContent).toContain('Updating to Wirescry’s current settings');
    expect(buttonIn('Behind')?.textContent).toBe('Detach');
    // An old agent says both: what it's doing, and to restart.
    expect(row('Old').textContent).toContain('Detached');
    expect(row('Old').textContent).toContain('restart the program to update it');
    // Off for reasons Attach can't change: no button.
    expect(buttonIn('Setting')).toBeNull();
    expect(row('Setting').textContent).toContain('while the setting above is off');
    expect(row('Unknown program').textContent).toContain('other users can change');
    expect(buttonIn('Unknown program')).toBeNull();
    expect(buttonIn('Unread')).toBeNull();
    expect(row('Unread').textContent).toContain('can’t read Wirescry’s settings');
    expect(buttonIn('Gone')).toBeNull();
    // Detaching: Attach undoes it.
    expect(row('Going').textContent).toContain('Detaching…');
    expect(buttonIn('Going')?.textContent).toBe('Attach');
  });

  it('says when an agent that’s on can’t do its job', () => {
    show(
      attach({
        programs: [
          { pid: 1, name: 'New', agent: agent({ hooks: ['trust:jdk-too-new', 'proxy:jdk-too-new'] }) },
          { pid: 2, name: 'Broken', agent: agent({ hooks: ['trust:ok', 'proxy:failed'] }) },
          {
            pid: 6,
            name: 'ApacheBroken',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'apache:failed'] }),
          },
          {
            pid: 7,
            name: 'ApacheNew',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'apache:jdk-too-new'] }),
          },
          { pid: 8, name: 'ApacheFine', agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'apache:ok'] }) },
          {
            pid: 9,
            name: 'JettyBroken',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'jetty:failed'] }),
          },
          {
            pid: 10,
            name: 'JettyNew',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'jetty:jdk-too-new'] }),
          },
          {
            pid: 11,
            name: 'JettyOld',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'jetty:not-covered'] }),
          },
          {
            pid: 12,
            name: 'JettySome',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'jetty:ok', 'jetty-skipped:2'] }),
          },
          { pid: 13, name: 'JettyFine', agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'jetty:ok'] }) },
          {
            pid: 14,
            name: 'JettyOldCert',
            agent: agent({ hooks: ['trust:ca-mismatch', 'proxy:ok', 'jetty:not-covered'] }),
          },
          {
            pid: 15,
            name: 'NettyBroken',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'reactor-netty:failed'] }),
          },
          {
            pid: 16,
            name: 'NettyNew',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'reactor-netty:jdk-too-new'] }),
          },
          {
            pid: 17,
            name: 'NettyNoProxy',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'reactor-netty:no-proxy-handler'] }),
          },
          {
            pid: 18,
            name: 'NettyFine',
            agent: agent({ hooks: ['trust:ok', 'proxy:ok', 'reactor-netty:ok'] }),
          },
          {
            pid: 19,
            name: 'NettyNoProxyCert',
            agent: agent({ hooks: ['trust:ca-mismatch', 'proxy:ok', 'reactor-netty:no-proxy-handler'] }),
          },
          { pid: 3, name: 'Own', agent: agent({ hooks: ['trust:ok', 'proxy:app-selector'] }) },
          { pid: 4, name: 'Cert', agent: agent({ hooks: ['trust:ca-mismatch', 'proxy:ok'] }) },
          { pid: 5, name: 'Early', agent: agent({ hooks: ['trust:waiting', 'proxy:waiting'] }) },
        ],
      }),
    );
    expect(row('New').textContent).toContain('newer than Wirescry’s agent supports');
    expect(row('Broken').textContent).toContain('couldn’t set itself up');
    expect(row('ApacheBroken').textContent).toContain('couldn’t set itself up');
    expect(row('ApacheNew').textContent).toContain('couldn’t set itself up');
    expect(row('ApacheNew').textContent).not.toContain('newer');
    expect(row('ApacheFine').textContent).toContain('Sending its traffic through Wirescry.');
    expect(row('JettyBroken').textContent).toContain('couldn’t set itself up');
    expect(row('JettyNew').textContent).toContain('couldn’t set itself up');
    expect(row('JettyNew').textContent).not.toContain('newer');
    expect(row('JettyOld').textContent).toContain('older than the agent covers');
    expect(row('JettySome').textContent).toContain('Sending its traffic through Wirescry.');
    expect(row('JettySome').textContent).toContain('Some of its Jetty clients can’t go through a proxy');
    expect(row('JettyFine').textContent).toContain('Sending its traffic through Wirescry.');
    expect(row('JettyFine').textContent).not.toContain('Some of its Jetty clients');
    // A certificate problem says more than an old Jetty does.
    expect(row('JettyOldCert').textContent).toContain('can’t use Wirescry’s certificate');
    expect(row('NettyBroken').textContent).toContain('couldn’t set itself up');
    expect(row('NettyNew').textContent).toContain('couldn’t set itself up');
    expect(row('NettyNew').textContent).not.toContain('newer');
    // The program's other traffic still comes: said, with the note.
    expect(row('NettyNoProxy').textContent).toContain('Sending its traffic through Wirescry.');
    expect(row('NettyNoProxy').textContent).toContain(
      'Its Reactor Netty requests connect directly: it lacks Netty’s proxy support (netty-handler-proxy).',
    );
    expect(row('NettyFine').textContent).not.toContain('Reactor Netty');
    expect(row('NettyFine').textContent).toContain('Sending its traffic through Wirescry.');
    // A certificate problem says more than missing proxy support does.
    expect(row('NettyNoProxyCert').textContent).toContain('can’t use Wirescry’s certificate');
    expect(row('Own').textContent).toContain('chooses its own proxy');
    expect(row('Cert').textContent).toContain('can’t use Wirescry’s certificate');
    for (const name of [
      'New',
      'Broken',
      'Own',
      'Cert',
      'ApacheBroken',
      'ApacheNew',
      'JettyBroken',
      'JettyNew',
      'JettyOld',
      'NettyBroken',
      'NettyNew',
    ]) {
      expect(row(name).textContent).not.toContain('Sending its traffic');
      // Still on, so it can be turned off.
      expect(buttonIn(name)?.textContent).toBe('Detach');
    }
    expect(row('Early').textContent).toContain('Sending its traffic through Wirescry.');
  });

  it('offers Attach only with a JDK to attach with', () => {
    show(
      attach({
        state: 'no-jdk',
        jdk: undefined,
        programs: [
          { pid: 10, name: 'Noted', note: 'x' },
          { pid: 11, name: 'Detached', agent: agent({ on: false, reason: 'detached' }) },
        ],
      }),
    );
    expect(buttonIn('Noted')).toBeNull();
    // Turning a detached agent back on needs no JDK.
    expect(buttonIn('Detached')?.textContent).toBe('Attach');
    expect(screen.queryByRole('textbox', { name: 'Attach by process id' })).toBeNull();
  });

  it('attaches and detaches, and shows what it’s doing', async () => {
    const { send, rerender } = show(
      attach({
        programs: [
          { pid: 10, name: 'Plain' },
          { pid: 11, name: 'On', agent: agent() },
        ],
      }),
    );
    fireEvent.click(buttonIn('Plain')!);
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 10 });
    fireEvent.click(buttonIn('On')!);
    expect(send).toHaveBeenLastCalledWith({ command: 'javaDetach', pid: 11 });
    // The replies are in: what disables the buttons now is the backend's busy.
    await act(async () => undefined);
    rerender(
      attach({
        programs: [
          { pid: 10, name: 'Plain', busy: 'attaching' },
          { pid: 11, name: 'On', agent: agent(), busy: 'detaching' },
        ],
      }),
    );
    expect((buttonIn('Plain') as HTMLButtonElement).disabled).toBe(true);
    expect(buttonIn('Plain')?.textContent).toBe('Attaching…');
    expect((buttonIn('On') as HTMLButtonElement).disabled).toBe(true);
    expect(buttonIn('On')?.textContent).toBe('Detaching…');
  });

  it('can’t click twice while a reply is on its way', async () => {
    let finish: () => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = () => resolve({ attached: true });
        }),
    );
    show(attach({ programs: [{ pid: 10, name: 'Plain' }] }), send);
    fireEvent.click(buttonIn('Plain')!);
    expect((buttonIn('Plain') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttonIn('Plain')!);
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect((buttonIn('Plain') as HTMLButtonElement).disabled).toBe(false);
  });

  const asking = () =>
    vi.fn(async (command: Command): Promise<unknown> =>
      command.command === 'javaAttach' && !('confirmWarning' in command)
        ? { needsConfirmation: 'java-warning' }
        : { attached: true },
    );

  it('asks before Java 21’s warning, in the program’s row, and sends the answer', async () => {
    const send = asking();
    show(
      attach({
        programs: [
          { pid: 10, name: 'New' },
          { pid: 11, name: 'Other' },
        ],
      }),
      send,
    );
    fireEvent.click(buttonIn('New')!);
    const callout = await within(row('New')).findByRole('alert');
    expect(callout.textContent).toContain('New runs Java 21 or later');
    expect(within(row('Other')).queryByRole('alert')).toBeNull();
    // Another program's attach leaves this question alone.
    fireEvent.click(buttonIn('Other')!);
    await within(row('Other')).findByRole('alert');
    expect(within(row('New')).getByRole('alert')).toBeTruthy();
    fireEvent.click(within(callout).getByRole('button', { name: 'Attach anyway' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 10, confirmWarning: true });
    await waitFor(() => expect(within(row('New')).queryByRole('alert')).toBeNull());
  });

  it('cancels the warning without attaching, and drops it with its program', async () => {
    const send = asking();
    const { rerender } = show(attach({ programs: [{ pid: 10, name: 'New' }] }), send);
    fireEvent.click(buttonIn('New')!);
    fireEvent.click(
      within(await within(row('New')).findByRole('alert')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(buttonIn('New')!);
    await within(row('New')).findByRole('alert');
    rerender(attach({ programs: [] }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a refusal once, in the program’s row', async () => {
    const note = "Java didn't let Wirescry attach.";
    let current = attach({ programs: [{ pid: 10, name: 'P' }] });
    let rerender: (next: JavaAttachStatus | undefined) => void = () => undefined;
    // As the backend does: the note lands on the program, then the same text is thrown.
    const send = vi.fn(async (): Promise<unknown> => {
      current = attach({ programs: [{ pid: 10, name: 'P', note }] });
      rerender(current);
      throw new Error(note);
    });
    ({ rerender } = show(current, send));
    fireEvent.click(buttonIn('P')!);
    await within(row('P')).findByRole('alert');
    expect(screen.getAllByText(note)).toHaveLength(1);
    // A note from an earlier try, before any click: shown as a note.
    rerender(attach({ programs: [{ pid: 11, name: 'Q', note }] }));
    expect(within(row('Q')).getByRole('status').textContent).toBe(note);
  });

  it('attaches by process id: only a whole number above 0', async () => {
    const send = asking();
    show(attach(), send);
    for (const bad of ['', 'abc', '12a', '-5', '1.5', '0', '000', '12345678901']) {
      fireEvent.change(pidBox(), { target: { value: bad } });
      expect(pidButton().disabled, bad).toBe(true);
    }
    fireEvent.change(pidBox(), { target: { value: ' 4242 ' } });
    fireEvent.click(pidButton());
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 4242 });
    // Its own question, naming the pid.
    const callout = await screen.findByRole('alert');
    expect(callout.textContent).toContain('Process 4242 runs Java 21');
    fireEvent.click(within(callout).getByRole('button', { name: 'Attach anyway' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 4242, confirmWarning: true });
  });

  it('says why an attach by process id failed', async () => {
    const send = vi.fn(async (): Promise<unknown> => {
      throw new Error("Java doesn't list this process.");
    });
    show(attach(), send);
    fireEvent.change(pidBox(), { target: { value: '99' } });
    fireEvent.click(pidButton());
    expect((await screen.findByRole('alert')).textContent).toBe("Java doesn't list this process.");
  });

  it('says what attaching needs when there’s no JDK, by system', () => {
    show(
      attach({ state: 'no-jdk', jdk: undefined, passed: ['/usr/lib/jvm/java-8 is Java 1.8.0'] }),
      undefined,
      'linux',
    );
    const note = screen.getByText(/Attaching needs a JDK 17 or later/);
    expect(note.textContent).not.toContain('macOS');
    expect(note.textContent).toContain('restart Wirescry');
    expect(screen.getByText('/usr/lib/jvm/java-8 is Java 1.8.0')).toBeTruthy();
    cleanup();
    show(attach({ state: 'no-jdk', jdk: undefined }), undefined, 'darwin');
    const mac = screen.getByText(/Attaching needs a JDK 17 or later/);
    expect(mac.textContent).toContain('among the JDKs macOS knows');
    expect(mac.textContent).toContain('then check again');
    expect(mac.textContent).not.toContain('restart');
    cleanup();
    show(attach({ state: 'no-jdk', jdk: undefined }), undefined, 'win32');
    expect(screen.getByText(/Attaching needs a JDK 11 or later/)).toBeTruthy();
  });

  it('says why listing failed, and when there’s nothing', () => {
    const { rerender } = show(
      attach({ state: 'failed', error: 'Listing Java programs failed: it didn’t finish within 10 s' }),
    );
    expect(screen.getByText('Listing Java programs failed: it didn’t finish within 10 s')).toBeTruthy();
    // Programs with the agent still show, and can still be attached by pid.
    expect(screen.getByRole('textbox', { name: 'Attach by process id' })).toBeTruthy();
    rerender(attach());
    expect(screen.getByText(/No running Java programs found/)).toBeTruthy();
    rerender(attach({ state: 'checking' }));
    expect(screen.queryByText(/No running Java programs found/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('can’t attach or detach while disconnected', async () => {
    const send = asking();
    const { rerender } = show(
      attach({
        programs: [
          { pid: 10, name: 'P' },
          { pid: 11, name: 'Q', agent: agent() },
        ],
      }),
      send,
    );
    fireEvent.click(buttonIn('P')!);
    await within(row('P')).findByRole('alert');
    fireEvent.change(pidBox(), { target: { value: '42' } });
    rerender(
      attach({
        programs: [
          { pid: 10, name: 'P' },
          { pid: 11, name: 'Q', agent: agent() },
        ],
      }),
      false,
    );
    expect(
      (within(row('P')).getByRole('button', { name: 'Attach anyway' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((buttonIn('Q') as HTMLButtonElement).disabled).toBe(true);
    expect(pidButton().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
