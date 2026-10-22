/**
 * Environment variables that send a terminal's HTTP traffic through Leverframe,
 * and how to write them for each shell. Shared so the launched terminals and the
 * snippets on the Setup page are always the same.
 */

export interface TerminalEnvPaths {
  /** Leverframe's CA certificate alone. */
  caPath: string;
  /** Leverframe's CA plus the usual public and system roots, for tools that replace their trust store. */
  bundlePath: string;
}

export function terminalEnv(
  proxyPort: number,
  { caPath, bundlePath }: TerminalEnvPaths,
): Record<string, string> {
  const proxy = `http://127.0.0.1:${proxyPort}`;
  return {
    // Most tools read one case or the other (curl reads only lowercase http_proxy).
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    // Node.js 24+ (and 22.21+) uses the variables above only when asked.
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: caPath,
    // OpenSSL users: Python, Ruby, PHP, Go on Linux and macOS.
    SSL_CERT_FILE: bundlePath,
    // Python requests, curl and git each have their own variable.
    REQUESTS_CA_BUNDLE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
    LEVERFRAME_PROXY: proxy,
  };
}

export type ShellKind = 'posix' | 'fish' | 'powershell' | 'cmd';

export const SHELL_LABELS: Record<ShellKind, string> = {
  posix: 'bash / zsh',
  fish: 'fish',
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
};

const posixQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const fishQuote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const powershellQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Lines that set `env` in the given shell. */
export function shellSnippet(env: Record<string, string>, shell: ShellKind): string {
  const entries = Object.entries(env);
  switch (shell) {
    case 'posix':
      return entries.map(([key, value]) => `export ${key}=${posixQuote(value)}`).join('\n');
    case 'fish':
      return entries.map(([key, value]) => `set -gx ${key} ${fishQuote(value)}`).join('\n');
    case 'powershell':
      return entries.map(([key, value]) => `$env:${key} = ${powershellQuote(value)}`).join('\n');
    case 'cmd':
      // Windows variable names ignore case, so set each name once.
      return entries
        .filter(([key], i) => entries.findIndex(([other]) => other.toUpperCase() === key.toUpperCase()) === i)
        .map(([key, value]) => `set "${key}=${value}"`)
        .join('\n');
  }
}
