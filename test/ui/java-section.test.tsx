import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JavaAgentStatus, ProxyStatus } from '../../src/shared/api';
import { JavaSection } from '../../src/renderer/src/JavaSection';
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
    render(<JavaSection status={withJava({ startup: false })} send={vi.fn()} connected={false} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('says why a change failed', async () => {
    const send = vi.fn(async () => {
      throw new Error('Java setup is off.');
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
        send={vi.fn()}
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
        send={vi.fn()}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    rerender(<JavaSection status={withJava({ startup: true })} send={vi.fn()} CopyButton={CopyButton} />);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.getByText('Setting up the agent…')).toBeTruthy();
    const problem = "Wirescry's data folder has = or a quote in its path";
    rerender(
      <JavaSection
        status={withJava({ startup: true, stubPath: '/a=b/wirescry-agent.jar', problem })}
        send={vi.fn()}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(problem);
    expect(screen.queryByText('Setting up the agent…')).toBeNull();
  });
});
