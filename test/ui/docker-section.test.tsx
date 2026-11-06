import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DockerStatus, ProxyStatus } from '../../src/shared/api';
import { DockerSection } from '../../src/renderer/src/DockerSection';
import { status } from './fixtures';

const withDocker = (docker: DockerStatus, platform: ProxyStatus['platform'] = 'darwin'): ProxyStatus => ({
  ...status(),
  platform,
  docker,
});

describe('Docker section', () => {
  it('explains the setup when Docker is ready, naming the daemon', () => {
    render(<DockerSection status={withDocker({ state: 'ready', daemon: 'unix:///var/run/docker.sock' })} />);
    expect(screen.getByRole('heading', { name: 'Docker' })).toBeTruthy();
    expect(screen.getByText(/send their HTTP and HTTPS traffic through Wirescry/)).toBeTruthy();
    expect(screen.getByText(/unix:\/\/\/var\/run\/docker\.sock/)).toBeTruthy();
    expect(screen.queryByText(/firewall/)).toBeNull();
  });

  it('mentions firewalls on Linux, with the proxy port', () => {
    render(
      <DockerSection
        status={withDocker({ state: 'ready', daemon: 'unix:///var/run/docker.sock' }, 'linux')}
      />,
    );
    expect(screen.getByText(/firewall.*port 8001/)).toBeTruthy();
  });

  it('warns that ufw is on, with commands to copy, only when told', () => {
    const commands = [
      'sudo ufw allow from 172.16.0.0/12 to any port 8001 proto tcp',
      'sudo ufw allow from 192.168.144.0/20 to any port 8001 proto tcp',
    ];
    const copied: string[] = [];
    const CopyButton = ({ text, label = 'Copy' }: { text: string; label?: string }) => (
      <button type="button" onClick={() => copied.push(text)}>
        {label}
      </button>
    );
    const ready = { state: 'ready', daemon: 'unix:///var/run/docker.sock' } as const;
    const { rerender } = render(
      <DockerSection
        status={withDocker({ ...ready, firewall: { name: 'ufw', commands } }, 'linux')}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.getByRole('note').textContent).toMatch(/ufw, this computer.s firewall, is on.*hang/);
    expect(screen.getByText(commands.join('\n'), { collapseWhitespace: false, trim: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy ufw commands' }));
    expect(copied).toEqual([commands.join('\n')]);
    // No fixed port: Wirescry may pick another, so it says to fix one.
    expect(screen.getByText(/picked port 8001 this time.*Always use port/)).toBeTruthy();
    rerender(
      <DockerSection
        status={{
          ...withDocker({ ...ready, firewall: { name: 'ufw', commands } }, 'linux'),
          proxyPortSetting: 8001,
        }}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.getByText(/If you change the proxy port, run them again/)).toBeTruthy();
    // No firewall reported, or setup off: no note.
    rerender(<DockerSection status={withDocker(ready, 'linux')} CopyButton={CopyButton} />);
    expect(screen.queryByRole('note')).toBeNull();
    rerender(
      <DockerSection
        status={withDocker(
          { state: 'off', daemon: ready.daemon, firewall: { name: 'ufw', commands } },
          'linux',
        )}
        CopyButton={CopyButton}
      />,
    );
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('on Windows, has the switch like everywhere else', () => {
    const send = vi.fn(async () => undefined);
    const { rerender } = render(
      <DockerSection
        status={withDocker({ state: 'ready', daemon: 'npipe:////./pipe/docker_engine' }, 'win32')}
        send={send}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeTruthy();
    // Windows containers: left alone, but the switch stays.
    rerender(
      <DockerSection
        status={withDocker(
          { state: 'unsupported', daemon: 'npipe:////./pipe/docker_engine', error: 'Windows containers.' },
          'win32',
        )}
        send={send}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeTruthy();
    rerender(<DockerSection status={withDocker({ state: 'none' }, 'win32')} send={send} />);
    expect(screen.getByText(/Docker wasn.t found/)).toBeTruthy();
  });

  it('says when Docker is missing, remote, or could not be set up', () => {
    const { rerender } = render(<DockerSection status={withDocker({ state: 'none' })} />);
    expect(screen.getByText(/Docker wasn.t found/)).toBeTruthy();
    rerender(<DockerSection status={withDocker({ state: 'remote', daemon: 'ssh://me@box' })} />);
    expect(screen.getByText(/another computer \(ssh:\/\/me@box\)/)).toBeTruthy();
    rerender(
      <DockerSection status={withDocker({ state: 'failed', daemon: 'unix:///x', error: 'EACCES' })} />,
    );
    expect(screen.getByText(/couldn.t set itself up for Docker: EACCES/)).toBeTruthy();
  });

  it('turns Docker setup off and on with the switch', () => {
    const send = vi.fn(async () => undefined);
    const { rerender } = render(
      <DockerSection status={withDocker({ state: 'ready', daemon: 'unix:///d' })} send={send} />,
    );
    const box = screen.getByRole('checkbox', { name: /Set up containers started from Wirescry terminals/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(send).toHaveBeenCalledWith({ command: 'setDockerSetup', enabled: false });
    rerender(<DockerSection status={withDocker({ state: 'off', daemon: 'unix:///d' })} send={send} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/New terminals don.t get/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(send).toHaveBeenLastCalledWith({ command: 'setDockerSetup', enabled: true });
  });

  it('shows why the switch failed, and is disabled while disconnected', async () => {
    const send = vi.fn(async () => {
      throw new Error('Could not save settings.');
    });
    const { rerender } = render(
      <DockerSection status={withDocker({ state: 'ready', daemon: 'unix:///d' })} send={send} />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not save settings.');
    rerender(
      <DockerSection
        status={withDocker({ state: 'ready', daemon: 'unix:///d' })}
        send={send}
        connected={false}
      />,
    );
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('offers no switch where there is nothing to switch', () => {
    render(<DockerSection status={withDocker({ state: 'none' })} send={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says why a kind of Docker is not set up', () => {
    render(
      <DockerSection
        status={withDocker({
          state: 'unsupported',
          daemon: 'unix:///c',
          error: 'Wirescry doesn’t set up Podman yet.',
        })}
      />,
    );
    expect(
      screen.getByText(/doesn.t set up Podman yet\. Containers you start from a Wirescry terminal are left/),
    ).toBeTruthy();
  });

  it('says what happened to the last container', () => {
    const { rerender } = render(
      <DockerSection
        status={withDocker({
          state: 'ready',
          daemon: 'unix:///d',
          lastContainer: { name: 'web', setUp: true },
        })}
      />,
    );
    expect(screen.getByText('Last container: web, set up.')).toBeTruthy();
    rerender(
      <DockerSection
        status={withDocker({
          state: 'ready',
          daemon: 'unix:///d',
          lastContainer: {
            image: 'kindest/node',
            setUp: false,
            reason: 'it’s a Kubernetes node.',
          },
        })}
      />,
    );
    expect(
      screen.getByText(/Last container: kindest\/node, left as it is: it’s a Kubernetes node\./),
    ).toBeTruthy();
  });
});
