/**
 * Environment variables that send a terminal's HTTP traffic through Wirescry,
 * and how to write them for each shell. Shared so the launched terminals and the
 * snippets on the Setup page are always the same.
 */

export interface TerminalEnvPaths {
  /** Wirescry's CA certificate alone. */
  caPath: string;
  /** Wirescry's CA plus the usual public and system roots, for tools that replace their trust store. */
  bundlePath: string;
  /** Folder holding a PHP .ini file (see phpIniContent). */
  phpIniDir: string;
  /** Folder holding a curl config file, used on Windows only (see curlrcContent). */
  curlHome: string;
  /** JKS trust store with the same certificates as the bundle, for Java. */
  javaTrustStore: string;
}

/** Password for the Java trust store. It only protects the file's checksum; the file holds no secrets. */
export const JAVA_TRUST_STORE_PASSWORD = 'changeit';

/**
 * Options every JVM reads from JAVA_TOOL_OPTIONS: send HTTP and HTTPS through the proxy,
 * and trust the Wirescry trust store. The path is quoted because it may contain spaces
 * (macOS's "Application Support"), which the JVM otherwise splits on.
 */
export function javaToolOptions(proxyPort: number, trustStore: string): string {
  return [
    '-Dhttp.proxyHost=127.0.0.1',
    `-Dhttp.proxyPort=${proxyPort}`,
    '-Dhttps.proxyHost=127.0.0.1',
    `-Dhttps.proxyPort=${proxyPort}`,
    `-Djavax.net.ssl.trustStore="${trustStore}"`,
    `-Djavax.net.ssl.trustStorePassword=${JAVA_TRUST_STORE_PASSWORD}`,
    '-Djavax.net.ssl.trustStoreType=JKS',
  ].join(' ');
}

export type TerminalPlatform = 'darwin' | 'win32' | 'linux' | 'other';

export function terminalEnv(
  proxyPort: number,
  { caPath, bundlePath, phpIniDir, curlHome, javaTrustStore }: TerminalEnvPaths,
  platform: TerminalPlatform,
): Record<string, string> {
  const proxy = `http://127.0.0.1:${proxyPort}`;
  const windows = platform === 'win32';
  return {
    // Most tools read one case or the other (curl reads only lowercase http_proxy).
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    // Node.js 24+ (and 22.21+) uses the variables above only when asked.
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: caPath,
    // OpenSSL users: Python, Ruby, Go on Linux and macOS.
    SSL_CERT_FILE: bundlePath,
    // Python requests, curl and git each have their own variable.
    REQUESTS_CA_BUNDLE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
    // PHP builds hardcode a CA file that wins over SSL_CERT_FILE, so PHP also reads an
    // .ini from this folder. The leading separator keeps PHP's usual folder as well.
    PHP_INI_SCAN_DIR: `${windows ? ';' : ':'}${phpIniDir}`,
    // curl.exe on Windows ignores CURL_CA_BUNDLE and reads its CA from a config file instead.
    ...(windows ? { CURL_HOME: curlHome } : {}),
    // Java ignores the proxy variables; JVMs read these options at startup.
    JAVA_TOOL_OPTIONS: javaToolOptions(proxyPort, javaTrustStore),
    WIRESCRY_PROXY: proxy,
  };
}

/** PHP settings that make the curl extension and stream wrappers trust the bundle. */
export function phpIniContent(bundlePath: string): string {
  return [
    '; Written by Wirescry for terminals it sets up.',
    `curl.cainfo = "${bundlePath}"`,
    `openssl.cafile = "${bundlePath}"`,
    '',
  ].join('\n');
}

/**
 * curl config for Windows terminals. curl.exe there uses Schannel, which ignores
 * CURL_CA_BUNDLE, and can't check revocation for a local CA that has nowhere to publish
 * revocation lists, so that check is turned off. Only used inside terminals Wirescry
 * sets up; the user's own _curlrc isn't read there.
 */
export function curlrcContent(bundlePath: string): string {
  // curl config strings use backslash escapes, so double Windows path separators.
  const quoted = bundlePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '# Written by Wirescry for terminals it sets up.',
    `cacert = "${quoted}"`,
    'ssl-no-revoke',
    '',
  ].join('\n');
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

/** File name of the script that sets up a terminal, per shell, in the terminal-config/env folder. */
export const SHELL_SCRIPT_NAMES: Record<ShellKind, string> = {
  posix: 'wirescry.sh',
  fish: 'wirescry.fish',
  powershell: 'wirescry.ps1',
  cmd: 'wirescry.cmd',
};

/** The script's contents: the snippet with a comment, and for cmd, no echoing. */
export function shellScript(env: Record<string, string>, shell: ShellKind): string {
  const note = "Written by Wirescry. Sends this terminal's HTTP and HTTPS traffic through it.";
  const body = shellSnippet(env, shell);
  switch (shell) {
    case 'cmd':
      return `@echo off\r\nrem ${note}\r\n${body.replace(/\n/g, '\r\n')}\r\n`;
    case 'powershell':
      return `# ${note}\r\n${body.replace(/\n/g, '\r\n')}\r\n`;
    default:
      return `# ${note}\n${body}\n`;
  }
}

/**
 * One line to paste into a terminal that runs the script. PowerShell reads the file and
 * runs its text, because Windows' default execution policy refuses to run .ps1 scripts.
 */
export function sourceLine(shell: ShellKind, scriptPath: string): string {
  switch (shell) {
    case 'posix':
      return `. ${posixQuote(scriptPath)}`;
    case 'fish':
      return `source ${fishQuote(scriptPath)}`;
    case 'powershell':
      return `Get-Content -Raw ${powershellQuote(scriptPath)} | Invoke-Expression`;
    case 'cmd':
      return `call "${scriptPath}"`;
  }
}
