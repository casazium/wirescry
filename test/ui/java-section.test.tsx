import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  const agent = (
    change: Partial<NonNullable<JavaProgram['agent']>> = {},
  ): NonNullable<JavaProgram['agent']> => ({
    id: 'a1',
    route: 'attach',
    on: true,
    reason: 'on',
    java: '17.0.2',
    current: true,
    hooks: [],
    ...change,
  });
  const show = (
    a: JavaAttachStatus | undefined,
    send: (command: Command) => Promise<unknown> = vi.fn(async () => undefined),
    platform: ProxyStatus['platform'] = 'darwin',
  ) => {
    const props = (next: JavaAttachStatus | undefined) => ({
      status: { ...withJava({ startup: false, ...(next ? { attach: next } : {}) }), platform },
      send,
    });
    const view = render(<JavaSection {...props(a)} />);
    return {
      send,
      rerender: (next: JavaAttachStatus | undefined) => view.rerender(<JavaSection {...props(next)} />),
    };
  };
  const list = () => screen.getByRole('list', { name: 'Running Java programs' });
  const row = (name: string) => within(list()).getByText(name).closest('li') as HTMLElement;

  it('looks for programs once when first shown, and again when asked', async () => {
    const { send, rerender } = show(undefined);
    expect(send).toHaveBeenCalledWith({ command: 'javaRefresh' });
    expect(screen.getByText('Looking for Java programs…')).toBeTruthy();
    rerender(attach({ programs: [{ pid: 10, name: 'Main' }] }));
    await waitFor(() => expect(screen.queryByText('Looking for Java programs…')).toBeNull());
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('doesn’t look by itself once the backend has a list, or while disconnected', () => {
    const send = vi.fn(async () => undefined);
    show(attach(), send);
    expect(send).not.toHaveBeenCalled();
    render(<JavaSection status={withJava({ startup: false })} send={send} connected={false} />);
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
          { pid: 15, name: 'Old', agent: agent({ outdated: true }) },
          { pid: 16, name: 'Setting', agent: agent({ on: false, reason: 'startup-off', route: 'startup' }) },
          { pid: 17, name: '', agent: agent({ on: false, reason: 'unsafe-files' }) },
          { pid: 18, name: 'Going', agent: agent({ on: false, reason: 'detaching' }) },
        ],
      }),
    );
    const button = (name: string) => within(row(name)).queryByRole('button')?.textContent;
    expect(button('Plain')).toBe('Attach');
    expect(row('Plain').textContent).toContain('pid 10');
    expect(button('app.jar')).toBe('Detach');
    expect(row('app.jar').textContent).toContain('Sending its traffic through Wirescry.');
    expect(row('app.jar').textContent).toContain('Java 17.0.2');
    expect(row('Started').textContent).toContain('(started with the agent)');
    expect(button('Off')).toBe('Attach');
    expect(row('Off').textContent).toContain('Detached');
    expect(row('Behind').textContent).toContain('Taking up Wirescry’s current settings');
    expect(row('Old').textContent).toContain('restart the program to update it');
    // The setting decides for a program started with the agent: no button.
    expect(button('Setting')).toBeUndefined();
    expect(row('Setting').textContent).toContain('while the setting above is off');
    // A nameless program goes by its pid.
    expect(row('Process 17').textContent).toContain('other users can change');
    expect(button('Going')).toBeUndefined();
  });

  it('attaches and detaches, and shows what it’s doing', () => {
    const { send, rerender } = show(
      attach({
        programs: [
          { pid: 10, name: 'Plain' },
          { pid: 11, name: 'On', agent: agent() },
        ],
      }),
    );
    fireEvent.click(within(row('Plain')).getByRole('button', { name: 'Attach' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 10 });
    fireEvent.click(within(row('On')).getByRole('button', { name: 'Detach' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'javaDetach', pid: 11 });
    rerender(
      attach({
        programs: [
          { pid: 10, name: 'Plain', busy: 'attaching' },
          { pid: 11, name: 'On', agent: agent(), busy: 'detaching' },
        ],
      }),
    );
    expect((within(row('Plain')).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(within(row('Plain')).getByRole('button').textContent).toBe('Attaching…');
    expect(within(row('On')).getByRole('button').textContent).toBe('Detaching…');
  });

  it('asks before Java 21’s warning, and sends the answer', async () => {
    const send = vi.fn(async (command: Command): Promise<unknown> =>
      command.command === 'javaAttach' && !('confirmWarning' in command)
        ? { needsConfirmation: 'java-warning' }
        : { attached: true },
    );
    show(attach({ programs: [{ pid: 10, name: 'New' }] }), send);
    fireEvent.click(within(row('New')).getByRole('button', { name: 'Attach' }));
    const callout = await screen.findByRole('alert');
    expect(callout.textContent).toContain('Java 21 or later');
    fireEvent.click(within(callout).getByRole('button', { name: 'Attach' }));
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 10, confirmWarning: true });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('cancels the warning without attaching', async () => {
    const send = vi.fn(async (): Promise<unknown> => ({ needsConfirmation: 'java-warning' }));
    show(attach({ programs: [{ pid: 10, name: 'New' }] }), send);
    fireEvent.click(within(row('New')).getByRole('button', { name: 'Attach' }));
    const callout = await screen.findByRole('alert');
    fireEvent.click(within(callout).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal once: on the program when noted there, else below', async () => {
    const note = "Java didn't let Wirescry attach.";
    const send = vi.fn(async (command: Command): Promise<unknown> => {
      if (command.command === 'javaAttach' && command.pid === 10) throw new Error(note);
      if (command.command === 'javaAttach') throw new Error('Not a process id.');
      return undefined;
    });
    show(attach({ programs: [{ pid: 10, name: 'Noted', note }] }), send);
    expect(within(row('Noted')).getByRole('status').textContent).toBe(note);
    fireEvent.click(within(row('Noted')).getByRole('button', { name: 'Attach' }));
    await act(async () => undefined);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Process id' }), { target: { value: '99' } });
    // The pid form's button: the last Attach.
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toBe('Not a process id.');
  });

  it('attaches by process id, only a number', () => {
    const { send } = show(attach());
    const box = screen.getByRole('textbox', { name: 'Process id' });
    const submit = () => screen.getAllByRole('button', { name: 'Attach' }).at(-1) as HTMLButtonElement;
    for (const bad of ['', 'abc', '12a', '-5', '1.5', '12345678901']) {
      fireEvent.change(box, { target: { value: bad } });
      expect(submit().disabled, bad).toBe(true);
    }
    fireEvent.change(box, { target: { value: ' 4242 ' } });
    fireEvent.click(submit());
    expect(send).toHaveBeenLastCalledWith({ command: 'javaAttach', pid: 4242 });
  });

  it('says what attaching needs when there’s no JDK, by system', () => {
    show(
      attach({ state: 'no-jdk', jdk: undefined, passed: ['/usr/lib/jvm/java-8 is Java 1.8.0'] }),
      undefined,
      'linux',
    );
    const note = screen.getByText(/Attaching needs a JDK 17 or later/);
    expect(note.textContent).not.toContain('macOS');
    expect(screen.getByText('/usr/lib/jvm/java-8 is Java 1.8.0')).toBeTruthy();
    // Nothing to attach with: no pid box.
    expect(screen.queryByRole('textbox', { name: 'Process id' })).toBeNull();
  });

  it('asks Windows for JDK 11, and macOS’s JDKs are looked in', () => {
    show(attach({ state: 'no-jdk', jdk: undefined }), undefined, 'win32');
    expect(screen.getByText(/Attaching needs a JDK 11 or later/)).toBeTruthy();
  });

  it('says why listing failed, and when there’s nothing', () => {
    const { rerender } = show(
      attach({ state: 'failed', error: 'Listing Java programs failed: it didn’t finish within 10 s' }),
    );
    expect(screen.getByText('Listing Java programs failed: it didn’t finish within 10 s')).toBeTruthy();
    rerender(attach());
    expect(screen.getByText(/No running Java programs found/)).toBeTruthy();
  });

  it('can’t attach or detach while disconnected', () => {
    const send = vi.fn(async () => undefined);
    render(
      <JavaSection
        status={withJava({
          startup: false,
          attach: attach({
            programs: [
              { pid: 10, name: 'P' },
              { pid: 11, name: 'Q', agent: agent() },
            ],
          }),
        })}
        send={send}
        connected={false}
      />,
    );
    for (const button of within(list()).getAllByRole('button'))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
