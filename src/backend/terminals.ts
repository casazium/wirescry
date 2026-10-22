import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TerminalInfo } from '../shared/api';
import { shellSnippet } from '../shared/terminal-env';

/** A terminal Leverframe can open on this machine. */
export interface DetectedTerminal extends TerminalInfo {
  /** macOS: application name for `open -a`. Elsewhere: the executable. */
  command: string;
  /** How the terminal takes a command to run, on Linux. */
  execFlag?: string[];
}

async function exists(file: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (await exists(file, constants.X_OK)) return file;
    }
  }
  return undefined;
}

// Linux terminals, roughly in order of how likely they are to be the user's choice.
// Each gets a flag that runs a command in the new window.
const LINUX_TERMINALS: Array<{ id: string; name: string; bin: string; execFlag: string[] }> = [
  { id: 'x-terminal-emulator', name: 'Default terminal', bin: 'x-terminal-emulator', execFlag: ['-e'] },
  { id: 'gnome-terminal', name: 'GNOME Terminal', bin: 'gnome-terminal', execFlag: ['--'] },
  { id: 'konsole', name: 'Konsole', bin: 'konsole', execFlag: ['-e'] },
  { id: 'xfce4-terminal', name: 'Xfce Terminal', bin: 'xfce4-terminal', execFlag: ['-x'] },
  { id: 'kitty', name: 'kitty', bin: 'kitty', execFlag: [] },
  { id: 'alacritty', name: 'Alacritty', bin: 'alacritty', execFlag: ['-e'] },
  { id: 'wezterm', name: 'WezTerm', bin: 'wezterm', execFlag: ['start', '--'] },
  { id: 'foot', name: 'foot', bin: 'foot', execFlag: [] },
  { id: 'xterm', name: 'XTerm', bin: 'xterm', execFlag: ['-e'] },
];

export async function detectTerminals(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedTerminal[]> {
  if (platform === 'darwin') {
    const found: DetectedTerminal[] = [{ id: 'terminal', name: 'Terminal', command: 'Terminal' }];
    for (const dir of ['/Applications', path.join(env.HOME ?? '', 'Applications')]) {
      if (await exists(path.join(dir, 'iTerm.app'))) {
        found.push({ id: 'iterm', name: 'iTerm', command: 'iTerm' });
        break;
      }
    }
    return found;
  }
  if (platform === 'win32') {
    const found: DetectedTerminal[] = [];
    const pwsh = await onPath('pwsh', env);
    if (pwsh) found.push({ id: 'pwsh', name: 'PowerShell', command: pwsh });
    found.push({
      id: 'powershell',
      name: pwsh ? 'Windows PowerShell' : 'PowerShell',
      command: 'powershell.exe',
    });
    found.push({ id: 'cmd', name: 'Command Prompt', command: 'cmd.exe' });
    return found;
  }
  const found: DetectedTerminal[] = [];
  for (const t of LINUX_TERMINALS) {
    const bin = await onPath(t.bin, env);
    if (bin) found.push({ id: t.id, name: t.name, command: bin, execFlag: t.execFlag });
  }
  return found;
}

/** The environment for a new terminal: the backend's own, minus Electron's, plus `extra`. */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('ELECTRON_') && key !== 'NODE_CHANNEL_FD') env[key] = value;
  }
  return { ...env, ...extra };
}

/** A shell script that sets `env`, says what it did, deletes itself and starts the user's login shell. */
export function posixStartScript(env: Record<string, string>, proxyAddress: string): string {
  return [
    '#!/bin/sh',
    '# Opened by Leverframe. Deletes itself once it has run.',
    shellSnippet(env, 'posix'),
    `printf '\\033]0;Leverframe\\007'`,
    `echo "This terminal sends HTTP and HTTPS traffic through Leverframe (${proxyAddress})."`,
    'echo "Requests from programs you start here show up in Leverframe."',
    'rm -f -- "$0"',
    'exec "${SHELL:-/bin/sh}" -l',
    '',
  ].join('\n');
}

/** Opens a new terminal window whose programs send their traffic through Leverframe. */
export async function launchTerminal(
  terminal: DetectedTerminal,
  env: Record<string, string>,
  options: { scriptDir: string; proxyAddress: string },
): Promise<void> {
  const banner = `This terminal sends HTTP and HTTPS traffic through Leverframe (${options.proxyAddress}).`;

  if (process.platform === 'darwin') {
    // macOS terminals don't take an environment from the caller, so hand them a
    // .command script that sets it and then starts the user's shell.
    await mkdir(options.scriptDir, { recursive: true, mode: 0o700 });
    const script = path.join(options.scriptDir, `leverframe-${randomBytes(6).toString('hex')}.command`);
    await writeFile(script, posixStartScript(env, options.proxyAddress), { mode: 0o700 });
    await chmod(script, 0o700);
    await run('open', ['-a', terminal.command, script], process.env);
    return;
  }

  const spawnEnv = childEnv(process.env, env);
  if (process.platform === 'win32') {
    // detached: true gives the new process its own console window.
    if (terminal.id === 'cmd') {
      await run(terminal.command, ['/K', `echo ${banner}`], spawnEnv, true);
    } else {
      await run(
        terminal.command,
        ['-NoExit', '-Command', `Write-Host '${banner.replace(/'/g, "''")}'`],
        spawnEnv,
        true,
      );
    }
    return;
  }

  // Linux: the terminal inherits the environment; run a shell that prints the banner first.
  const shellCommand = `echo '${banner.replace(/'/g, `'\\''`)}'; exec "\${SHELL:-/bin/sh}" -l`;
  await run(terminal.command, [...(terminal.execFlag ?? ['-e']), 'sh', '-c', shellCommand], spawnEnv, true);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, detached = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
