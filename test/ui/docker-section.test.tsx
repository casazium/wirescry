import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
