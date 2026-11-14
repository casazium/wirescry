/**
 * JAVA_TOOL_OPTIONS for terminals (src/shared/terminal-env.ts, src/backend/terminals.ts): Wirescry's
 * agent after its properties, kept within what JDK 8 reads, and the user's own options kept in
 * front. The shell lines are run in the real shells this machine has.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { childEnv } from '../src/backend/terminals';
import {
  javaAgentOption,
  javaAgentPathProblem,
  javaOptionCount,
  javaOptionsFit,
  javaToolOptions,
  jvmOptionForms,
  shellSnippet,
  terminalEnv,
  withUserJavaOptions,
  withoutWirescryAgent,
} from '../src/shared/terminal-env';

const paths = {
  caPath: '/tmp/ca.pem',
  bundlePath: '/tmp/bundle.pem',
  phpIniDir: '/tmp/php',
  curlHome: '/tmp/curl',
  javaTrustStore: '/tmp/Application Support/trust.jks',
};
const STUB = '/Users/me/Library/Application Support/Wirescry/java-agent/wirescry-agent.jar';
const PROPS = javaToolOptions(8123, paths.javaTrustStore);
const OURS = `${PROPS} -javaagent:"${STUB}=terminalPort=8123"`;

describe('the agent option', () => {
  it('quotes the path, and names the terminal’s port for the agent', () => {
    expect(javaAgentOption(STUB, 8123)).toBe(`-javaagent:"${STUB}=terminalPort=8123"`);
    expect(javaAgentOption(STUB)).toBe(`-javaagent:"${STUB}"`);
  });

  it('leaves the agent out on Windows for a path outside ASCII, until checked there', () => {
    const accented = 'C:\\Users\\José\\AppData\\Roaming\\Wirescry\\java-agent\\wirescry-agent.jar';
    expect(javaAgentPathProblem(accented, 'win32')).toMatch(/outside plain ASCII/);
    expect(javaAgentPathProblem(accented, 'darwin')).toBeUndefined();
    expect(javaAgentPathProblem(accented)).toBeUndefined();
    expect(terminalEnv(8123, paths, 'win32', accented).JAVA_TOOL_OPTIONS).toBe(PROPS);
    expect(terminalEnv(8123, paths, 'linux', accented).JAVA_TOOL_OPTIONS).toContain('-javaagent:');
  });

  it('refuses a path Java can’t take: = splits it, quotes are dropped', () => {
    expect(javaAgentPathProblem(STUB)).toBeUndefined();
    expect(
      javaAgentPathProblem('C:\\Users\\me\\AppData\\Roaming\\Wirescry\\java-agent\\wirescry-agent.jar'),
    ).toBeUndefined();
    for (const bad of [
      '/a=b/wirescry-agent.jar',
      `/it's/wirescry-agent.jar`,
      '/say "hi"/wirescry-agent.jar',
    ]) {
      expect(javaAgentPathProblem(bad)).toMatch(/= or a quote/);
    }
  });

  it('copies in two forms: quoted, and as one argument', () => {
    expect(jvmOptionForms(STUB)).toEqual({ quoted: `"-javaagent:${STUB}"`, plain: `-javaagent:${STUB}` });
    // What a POSIX shell would expand inside double quotes.
    expect(jvmOptionForms('/home/$me/wirescry-agent.jar').quoted).toBe(
      `'-javaagent:/home/$me/wirescry-agent.jar'`,
    );
    expect(jvmOptionForms('C:\\Users\\me\\wirescry-agent.jar').quoted).toBe(
      `"-javaagent:C:\\Users\\me\\wirescry-agent.jar"`,
    );
  });
});

describe('what JDK 8 reads', () => {
  it('counts options as the JVM splits them', () => {
    expect(javaOptionCount('')).toBe(0);
    expect(javaOptionCount('  -Xmx1g   -Da=b ')).toBe(2);
    expect(javaOptionCount(OURS)).toBe(8);
    expect(javaOptionCount(`-Da="x y z" "-Db=1 2" -Dc='p q'`)).toBe(3);
  });

  it('fits up to 1,000 bytes and 64 options, counting bytes, not characters', () => {
    expect(javaOptionsFit('a'.repeat(1000))).toBe(true);
    expect(javaOptionsFit('a'.repeat(1001))).toBe(false);
    expect(javaOptionsFit('é'.repeat(500))).toBe(true);
    expect(javaOptionsFit('é'.repeat(501))).toBe(false);
    expect(javaOptionsFit(Array(64).fill('-Dx').join(' '))).toBe(true);
    expect(javaOptionsFit(Array(65).fill('-Dx').join(' '))).toBe(false);
  });
});

describe('the terminal’s JAVA_TOOL_OPTIONS', () => {
  it('ends with the agent when it’s on', () => {
    expect(terminalEnv(8123, paths, 'linux', STUB).JAVA_TOOL_OPTIONS).toBe(OURS);
  });

  it('has the properties alone when it’s off', () => {
    expect(terminalEnv(8123, paths, 'linux').JAVA_TOOL_OPTIONS).toBe(PROPS);
  });

  it('leaves the agent out, keeping the properties, when the path can’t be used', () => {
    expect(terminalEnv(8123, paths, 'linux', '/a=b/wirescry-agent.jar').JAVA_TOOL_OPTIONS).toBe(PROPS);
  });

  it('leaves the agent out, keeping the properties, when JDK 8 would ignore the whole', () => {
    const long = `/${'x'.repeat(800)}/wirescry-agent.jar`;
    const value = terminalEnv(8123, paths, 'linux', long).JAVA_TOOL_OPTIONS!;
    expect(value).toBe(PROPS);
  });
});

describe('the user’s own JAVA_TOOL_OPTIONS', () => {
  it('stays in front of Wirescry’s', () => {
    expect(withUserJavaOptions(' -Xmx2g -javaagent:/otel.jar ', OURS)).toBe(
      `-Xmx2g -javaagent:/otel.jar ${OURS}`,
    );
  });

  it('is Wirescry’s alone when there’s none', () => {
    expect(withUserJavaOptions(undefined, OURS)).toBe(OURS);
    expect(withUserJavaOptions('   ', OURS)).toBe(OURS);
  });

  it('keeps only the user’s part when it already holds Wirescry’s (set up twice)', () => {
    const before = javaToolOptions(9000, paths.javaTrustStore);
    expect(withUserJavaOptions(`-Xmx2g ${before} -javaagent:"/old/wirescry-agent.jar"`, OURS)).toBe(
      `-Xmx2g ${OURS}`,
    );
    expect(withUserJavaOptions(before, OURS)).toBe(OURS);
    // A company proxy on this computer, before Wirescry's, is the user's.
    const cntlm = '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=3128';
    expect(withUserJavaOptions(`${cntlm} ${before}`, OURS)).toBe(`${cntlm} ${OURS}`);
  });

  it('appends everything to a value already too long for JDK 8: a later Java runs it', () => {
    const huge = `-D${'h'.repeat(1022)}`;
    expect(withUserJavaOptions(huge, OURS)).toBe(`${huge} ${OURS}`);
    const edge = `-D${'h'.repeat(1021)}`;
    expect(withUserJavaOptions(edge, OURS)).toBe(OURS);
  });

  it('leaves out Wirescry’s agent, quoted or not, and nothing else', () => {
    expect(withoutWirescryAgent(`-Xmx2g -javaagent:"${STUB}=terminalPort=1" -javaagent:/otel.jar`)).toBe(
      '-Xmx2g -javaagent:/otel.jar',
    );
    expect(withoutWirescryAgent('-javaagent:/a/wirescry-agent.jar=terminalPort=1 -Da=b')).toBe('-Da=b');
    expect(withoutWirescryAgent('-javaagent:/a/not-wirescry-agent.jar.bak -Da=b')).toBe(
      '-javaagent:/a/not-wirescry-agent.jar.bak -Da=b',
    );
    expect(withoutWirescryAgent('-Da=b')).toBe('-Da=b');
  });

  it('is kept when it only points at a proxy on this computer, such as a company’s cntlm', () => {
    const cntlm = '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=3128';
    expect(withUserJavaOptions(cntlm, OURS)).toBe(`${cntlm} ${OURS}`);
  });

  it('drops the agent first, then the user’s value, to stay within JDK 8’s limits', () => {
    const roomForProps = 1000 - PROPS.length - 1;
    const fitsWithoutAgent = `-D${'u'.repeat(roomForProps - 2)}`;
    expect(withUserJavaOptions(fitsWithoutAgent, OURS)).toBe(`${fitsWithoutAgent} ${PROPS}`);
    const tooLong = `-D${'u'.repeat(roomForProps)}`;
    expect(withUserJavaOptions(tooLong, OURS)).toBe(OURS);
    const many = Array(57).fill('-Dx').join(' ');
    expect(withUserJavaOptions(many, OURS)).toBe(`${many} ${PROPS}`);
  });

  it('is found in any case on Windows, and set once', () => {
    const env = childEnv({ Java_Tool_Options: '-Xmx2g' }, { JAVA_TOOL_OPTIONS: OURS }, true);
    expect(env.JAVA_TOOL_OPTIONS).toBe(`-Xmx2g ${OURS}`);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'JAVA_TOOL_OPTIONS')).toEqual([
      'JAVA_TOOL_OPTIONS',
    ]);
    // Elsewhere names keep their case: another variable, left alone.
    const posix = childEnv({ Java_Tool_Options: '-Xmx2g' }, { JAVA_TOOL_OPTIONS: OURS }, false);
    expect(posix.JAVA_TOOL_OPTIONS).toBe(OURS);
    expect(posix.Java_Tool_Options).toBe('-Xmx2g');
  });

  it('is kept by terminals Wirescry opens', () => {
    const env = childEnv({ JAVA_TOOL_OPTIONS: '-Xmx2g', PATH: '/bin' }, { JAVA_TOOL_OPTIONS: OURS });
    expect(env.JAVA_TOOL_OPTIONS).toBe(`-Xmx2g ${OURS}`);
    expect(childEnv({ PATH: '/bin' }, { JAVA_TOOL_OPTIONS: OURS }).JAVA_TOOL_OPTIONS).toBe(OURS);
    // Nothing of Java's to set, nothing changed.
    expect(childEnv({ JAVA_TOOL_OPTIONS: '-Xmx2g' }, { HTTP_PROXY: 'x' }).JAVA_TOOL_OPTIONS).toBe('-Xmx2g');
  });
});

/** Runs the setup lines in `shell` (with `before` set first) and prints JAVA_TOOL_OPTIONS. */
function inShell(shell: string, args: string[], snippet: string, print: string, before?: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SystemRoot: process.env.SystemRoot,
  };
  if (before !== undefined) env.JAVA_TOOL_OPTIONS = before;
  const result = spawnSync(shell, [...args, `${snippet}\n${print}`], { encoding: 'utf8', env });
  if (result.error) return undefined;
  expect(result.stderr).toBe('');
  return result.stdout.replace(/\r?\n$/, '');
}

const has = (shell: string) => spawnSync(shell, ['-c', 'exit 0']).status === 0;
const posixShells = ['sh', 'bash', 'zsh', 'dash'].filter((s) => process.platform !== 'win32' && has(s));
const ours = { JAVA_TOOL_OPTIONS: OURS, OTHER: 'x' };
const room = 1000 - OURS.length - 1;
const roomForProps = 1000 - PROPS.length - 1;
const cases: Array<[string, string | undefined, string]> = [
  ['the user’s own, as long as fits', `-D${'a'.repeat(room - 2)}`, `-D${'a'.repeat(room - 2)} ${OURS}`],
  ['the user’s own, too long for the agent', `-D${'b'.repeat(room)}`, `-D${'b'.repeat(room)} ${PROPS}`],
  ['the user’s own, too long for anything', `-D${'c'.repeat(roomForProps)}`, OURS],
  [
    'a company proxy on this computer',
    '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=3128',
    `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=3128 ${OURS}`,
  ],
  ['unset', undefined, OURS],
  ['empty', '', OURS],
  ['the user’s own', `-Xmx2g -Dname="a b" -Dq='c'`, `-Xmx2g -Dname="a b" -Dq='c' ${OURS}`],
  ['Wirescry’s already', PROPS, OURS],
  ['set up twice', `-Xmx2g ${PROPS} -javaagent:"/old/wirescry-agent.jar=terminalPort=1"`, `-Xmx2g ${OURS}`],
  ['the user’s own, already too long for JDK 8', `-D${'L'.repeat(1022)}`, `-D${'L'.repeat(1022)} ${OURS}`],
];

describe('the setup lines, in real shells', () => {
  for (const shell of posixShells) {
    for (const [name, before, after] of cases) {
      it(`${shell}: ${name}`, () => {
        expect(
          inShell(shell, ['-c'], shellSnippet(ours, 'posix'), 'printf %s "$JAVA_TOOL_OPTIONS"', before),
        ).toBe(after);
      });
    }
  }

  it.runIf(has('fish'))('fish keeps the user’s own, or replaces Wirescry’s', () => {
    for (const [, before, after] of cases.filter(([n]) => n !== 'empty')) {
      expect(
        inShell('fish', ['-c'], shellSnippet(ours, 'fish'), 'printf %s "$JAVA_TOOL_OPTIONS"', before),
      ).toBe(after);
    }
  });

  const pwsh = ['pwsh', 'powershell'].find(
    (p) => spawnSync(p, ['-NoProfile', '-Command', 'exit 0']).status === 0,
  );
  it.runIf(pwsh)('PowerShell keeps the user’s own, or replaces Wirescry’s', () => {
    for (const [, before, after] of cases.filter(([n]) => n !== 'empty')) {
      expect(
        inShell(
          pwsh!,
          ['-NoProfile', '-Command'],
          shellSnippet(ours, 'powershell'),
          '[Console]::Out.Write($env:JAVA_TOOL_OPTIONS)',
          before,
        ),
      ).toBe(after);
    }
  });

  it('Command Prompt sets it outright', () => {
    expect(shellSnippet(ours, 'cmd')).toContain(`set "JAVA_TOOL_OPTIONS=${OURS}"`);
  });

  it('other variables are set as before', () => {
    expect(shellSnippet(ours, 'posix')).toContain(`export OTHER='x'`);
    expect(shellSnippet(ours, 'fish')).toContain(`set -gx OTHER 'x'`);
    expect(shellSnippet(ours, 'powershell')).toContain(`$env:OTHER = 'x'`);
  });
});
