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
export function javaToolOptions(proxyPort: number, trustStore: string, proxyHost = '127.0.0.1'): string {
  return [
    `-Dhttp.proxyHost=${proxyHost}`,
    `-Dhttp.proxyPort=${proxyPort}`,
    `-Dhttps.proxyHost=${proxyHost}`,
    `-Dhttps.proxyPort=${proxyPort}`,
    `-Djavax.net.ssl.trustStore="${trustStore}"`,
    `-Djavax.net.ssl.trustStorePassword=${JAVA_TRUST_STORE_PASSWORD}`,
    '-Djavax.net.ssl.trustStoreType=JKS',
  ].join(' ');
}

/**
 * JDK 8 reads JAVA_TOOL_OPTIONS into a 1,024-byte buffer and ignores a longer value whole, with no
 * message, and stops after 64 options. Wirescry keeps what it writes under both.
 */
export const JAVA_OPTIONS_MAX_BYTES = 1000;
export const JAVA_OPTIONS_MAX_COUNT = 64;

/**
 * What shows that a JAVA_TOOL_OPTIONS value already holds Wirescry's options: their trust store
 * option, which names a file in Wirescry's data folder. (The proxy host alone would also match
 * a local company proxy such as cntlm.)
 */
function wirescryJavaMark(ours: string): string {
  return /-Djavax\.net\.ssl\.trustStore="[^"]*"/.exec(ours)?.[0] ?? ours;
}

/** `ours` without its agent option, the last one, if it has one. */
function withoutAgent(ours: string): string {
  const agent = / -javaagent:"[^"]*"$/.exec(ours);
  return agent ? ours.slice(0, agent.index) : ours;
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** How Wirescry's options start (javaToolOptions). */
const WIRESCRY_JAVA_START = '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=';

/** How many options a JAVA_TOOL_OPTIONS value holds, as the JVM splits it: on spaces outside quotes. */
export function javaOptionCount(value: string): number {
  let count = 0;
  let inOption = false;
  let quote: string | undefined;
  for (const c of value) {
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      inOption = false;
    } else {
      if (!inOption) count++;
      inOption = true;
      if (c === '"' || c === "'") quote = c;
    }
  }
  return count;
}

/** Whether JDK 8 reads all of `value`. */
export function javaOptionsFit(value: string): boolean {
  return byteLength(value) <= JAVA_OPTIONS_MAX_BYTES && javaOptionCount(value) <= JAVA_OPTIONS_MAX_COUNT;
}

/**
 * Why the agent's jar can't go in a `-javaagent:` option, or undefined: the JVM splits the option
 * at the first `=` and drops quotes, with no way to escape either. On Windows, a path outside ASCII
 * may not survive the variable's trip through the system's code page, and a JVM whose agent jar
 * isn't there doesn't start, so it's left out there until checked on a real system.
 */
export function javaAgentPathProblem(stub: string, platform?: TerminalPlatform): string | undefined {
  if (/[="']/.test(stub)) {
    return `Wirescry's data folder has = or a quote in its path (${stub}), which Java can't take in an agent option.`;
  }
  if (platform === 'win32' && !/^[\x20-\x7e]*$/.test(stub)) {
    return `Wirescry's data folder has letters outside plain ASCII in its path (${stub}), which Java on Windows may not read in an agent option.`;
  }
  return undefined;
}

/**
 * The `-javaagent:` option for Wirescry's agent. The path is quoted (spaces). `terminalPort` tells
 * the agent which port the proxy properties beside it name, so it knows them as Wirescry's.
 */
export function javaAgentOption(stub: string, terminalPort?: number): string {
  return `-javaagent:"${stub}${terminalPort ? `=terminalPort=${terminalPort}` : ''}"`;
}

/**
 * The JVM option that loads Wirescry's agent, in two forms: one argument as it is (a Gradle or
 * Maven setting, an IDE field that takes one option), and quoted for a command line or an IDE's
 * VM options field. Double quotes work in every shell Wirescry sets up and in IDE fields, unless
 * the path holds what a POSIX shell expands inside them. (A path with a quote can't be used at all:
 * see javaAgentPathProblem.)
 */
export function jvmOptionForms(stubPath: string): { plain: string; quoted: string } {
  const plain = `-javaagent:${stubPath}`;
  const quoted = /[$`!]/.test(stubPath) ? `'${plain}'` : `"${plain}"`;
  return { plain, quoted };
}

/**
 * JAVA_TOOL_OPTIONS with the user's own value kept in front of Wirescry's (`ours`). If the user's
 * already holds Wirescry's options (a terminal started from a Wirescry terminal), ours replace it.
 * When the whole would be too long for JDK 8, the agent (ours' last option) is left out, then the
 * user's value: Wirescry's properties always stay.
 */
export function withUserJavaOptions(user: string | undefined, ours: string): string {
  let own = user?.trim();
  const mark = wirescryJavaMark(ours);
  // Wirescry's already (set up twice): the user's part is what comes before it.
  const at = own ? own.indexOf(mark) : -1;
  if (own && at >= 0) own = own.slice(0, Math.max(0, own.lastIndexOf(WIRESCRY_JAVA_START, at))).trim();
  if (!own) return ours;
  // Too long for JDK 8 already: the program runs on a later Java, which reads it all.
  if (byteLength(own) > JAVA_OPTIONS_MAX_BYTES + 23) return `${own} ${ours}`;
  for (const value of [`${own} ${ours}`, `${own} ${withoutAgent(ours)}`]) {
    if (javaOptionsFit(value)) return value;
  }
  return ours;
}

/**
 * `value` without Wirescry's agent option, wherever it came from: for a container, which can't
 * reach the host's file (a JVM whose agent jar isn't there doesn't start).
 */
export function withoutWirescryAgent(value: string): string {
  return value
    .replace(
      /(^|\s)-javaagent:(?:"[^"]*[\\/]wirescry-agent\.jar(?:=[^"]*)?"|\S*[\\/]wirescry-agent\.jar(?:=\S*)?)(?=\s|$)/g,
      '$1',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export type TerminalPlatform = 'darwin' | 'win32' | 'linux' | 'other';

export function terminalEnv(
  proxyPort: number,
  { caPath, bundlePath, phpIniDir, curlHome, javaTrustStore }: TerminalEnvPaths,
  platform: TerminalPlatform,
  /** Wirescry's Java agent, when its startup setting is on: the stub's path. */
  javaAgent?: string,
): Record<string, string> {
  const proxy = `http://127.0.0.1:${proxyPort}`;
  const windows = platform === 'win32';
  const javaProperties = javaToolOptions(proxyPort, javaTrustStore);
  const withAgent =
    javaAgent && !javaAgentPathProblem(javaAgent, platform)
      ? `${javaProperties} ${javaAgentOption(javaAgent, proxyPort)}`
      : javaProperties;
  return {
    // Most tools read one case or the other (curl reads only lowercase http_proxy).
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    // Node.js 24+ (and 22.21+) uses the variables above only when asked.
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: caPath,
    // OpenSSL users: Python, Ruby, and Go on Linux. (Go on macOS and Windows uses only the
    // system's own trust store.)
    SSL_CERT_FILE: bundlePath,
    // gRPC's C core (Python, Ruby, PHP, C++) trusts only the CAs in this file; Node's gRPC uses it
    // in place of Node's own. Either way it's the whole list, so it's the bundle: the usual public
    // CAs as well as Wirescry's.
    GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: bundlePath,
    // Python requests, curl and git each have their own variable.
    REQUESTS_CA_BUNDLE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
    // PHP builds hardcode a CA file that wins over SSL_CERT_FILE, so PHP also reads an
    // .ini from this folder. The leading separator keeps PHP's usual folder as well.
    PHP_INI_SCAN_DIR: `${windows ? ';' : ':'}${phpIniDir}`,
    // curl.exe on Windows ignores CURL_CA_BUNDLE and reads its CA from a config file instead.
    ...(windows ? { CURL_HOME: curlHome } : {}),
    // Java ignores the proxy variables; JVMs read these options at startup. The agent comes last,
    // and only if JDK 8 would read it all; the properties work without it.
    JAVA_TOOL_OPTIONS: javaOptionsFit(withAgent) ? withAgent : javaProperties,
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

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lines that set `env` in the given shell. JAVA_TOOL_OPTIONS keeps the terminal's own value in
 * front of Wirescry's, as withUserJavaOptions does: set up twice, only the part before Wirescry's
 * is kept. The length checks count the terminal's value in characters, not bytes, and not its
 * options. Fish's line has no length check, and replaces a value that holds Wirescry's. Command
 * Prompt sets it outright.
 */
export function shellSnippet(env: Record<string, string>, shell: ShellKind): string {
  const entries = Object.entries(env);
  const line = (
    key: string,
    value: string,
    plain: (k: string, v: string) => string,
    java: (v: string) => string,
  ) => (key === 'JAVA_TOOL_OPTIONS' ? java(value) : plain(key, value));
  switch (shell) {
    case 'posix':
      return entries
        .map(([key, value]) =>
          line(
            key,
            value,
            (k, v) => `export ${k}=${posixQuote(v)}`,
            (v) =>
              // __w: the terminal's own part (before Wirescry's, if it's set up twice).
              `__w=\${JAVA_TOOL_OPTIONS-}; case "$__w" in *${posixQuote(wirescryJavaMark(v))}*) ` +
              `__w=\${__w%%${posixQuote(WIRESCRY_JAVA_START)}*' -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort='*${posixQuote(wirescryJavaMark(v))}*}; ` +
              `__w=\${__w%"\${__w##*[! ]}"} ;; esac; ` +
              `if [ -z "$__w" ]; then export JAVA_TOOL_OPTIONS=${posixQuote(v)}; ` +
              `elif [ $((\${#__w} + ${byteLength(v) + 1})) -le ${JAVA_OPTIONS_MAX_BYTES} ] || [ \${#__w} -gt ${JAVA_OPTIONS_MAX_BYTES + 23} ]; then export JAVA_TOOL_OPTIONS="$__w "${posixQuote(v)}; ` +
              `elif [ $((\${#__w} + ${byteLength(withoutAgent(v)) + 1})) -le ${JAVA_OPTIONS_MAX_BYTES} ]; then export JAVA_TOOL_OPTIONS="$__w "${posixQuote(withoutAgent(v))}; ` +
              `else export JAVA_TOOL_OPTIONS=${posixQuote(v)}; fi; unset __w`,
          ),
        )
        .join('\n');
    case 'fish':
      return entries
        .map(([key, value]) =>
          line(
            key,
            value,
            (k, v) => `set -gx ${k} ${fishQuote(v)}`,
            (v) =>
              `if test -z "$JAVA_TOOL_OPTIONS"; or string match -q -r -- ${fishQuote(regexEscape(wirescryJavaMark(v)))} "$JAVA_TOOL_OPTIONS"; set -gx JAVA_TOOL_OPTIONS ${fishQuote(v)}; else; set -gx JAVA_TOOL_OPTIONS "$JAVA_TOOL_OPTIONS "${fishQuote(v)}; end`,
          ),
        )
        .join('\n');
    case 'powershell':
      return entries
        .map(([key, value]) =>
          line(
            key,
            value,
            (k, v) => `$env:${k} = ${powershellQuote(v)}`,
            (v) =>
              `$__w = $env:JAVA_TOOL_OPTIONS; $__m = ${powershellQuote(wirescryJavaMark(v))}; ` +
              `if ($__w -and $__w.Contains($__m)) { $__w = $__w.Substring(0, [Math]::Max(0, $__w.LastIndexOf(${powershellQuote(WIRESCRY_JAVA_START)}, $__w.IndexOf($__m)))).Trim() }; ` +
              `$env:JAVA_TOOL_OPTIONS = if (-not $__w) { ${powershellQuote(v)} } ` +
              `elseif ($__w.Length + ${byteLength(v) + 1} -le ${JAVA_OPTIONS_MAX_BYTES} -or $__w.Length -gt ${JAVA_OPTIONS_MAX_BYTES + 23}) { $__w + ' ' + ${powershellQuote(v)} } ` +
              `elseif ($__w.Length + ${byteLength(withoutAgent(v)) + 1} -le ${JAVA_OPTIONS_MAX_BYTES}) { $__w + ' ' + ${powershellQuote(withoutAgent(v))} } ` +
              `else { ${powershellQuote(v)} }; Remove-Variable __w, __m`,
          ),
        )
        .join('\n');
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
 * Whether a script for this shell can hold these values safely. Command Prompt reads
 * .cmd files in the console's code page and treats % & ^ | < > as syntax even in
 * values, so it only gets a script when every value is plain ASCII without them.
 */
export function shellScriptSupported(env: Record<string, string>, shell: ShellKind): boolean {
  if (shell !== 'cmd') return true;
  return Object.values(env).every((value) => /^[\x20-\x7e]*$/.test(value) && !/[%&^|<>!]/.test(value));
}

/**
 * One line to paste into a terminal that runs the script. PowerShell reads the file and
 * runs its text, because Windows' default execution policy refuses to run .ps1 scripts;
 * -Encoding UTF8 because Windows PowerShell 5.1 otherwise reads it in the ANSI code page.
 */
export function sourceLine(shell: ShellKind, scriptPath: string): string {
  switch (shell) {
    case 'posix':
      return `. ${posixQuote(scriptPath)}`;
    case 'fish':
      return `source ${fishQuote(scriptPath)}`;
    case 'powershell':
      return `Get-Content -Raw -Encoding UTF8 -LiteralPath ${powershellQuote(scriptPath)} | Invoke-Expression`;
    case 'cmd':
      return `call "${scriptPath}"`;
  }
}
