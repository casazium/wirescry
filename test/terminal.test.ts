import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { childEnv, detectTerminals, posixStartScript } from '../src/backend/terminals';
import type { ProxyStatus } from '../src/shared/api';
import { curlrcContent, phpIniContent, shellSnippet, terminalEnv } from '../src/shared/terminal-env';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const exec = promisify(execFile);

/** The first of `names` that runs, or undefined. */
function findTool(names: string[], versionArgs = ['--version']): string | undefined {
  return names.find(
    (name) => spawnSync(name, versionArgs, { stdio: 'ignore', timeout: 20_000 }).status === 0,
  );
}

const python = findTool(['python3', 'python']);
const hasRequests = python && spawnSync(python, ['-c', 'import requests'], { stdio: 'ignore' }).status === 0;
// macOS's own Python (/usr/bin/python3) uses LibreSSL and, like its Ruby, ignores SSL_CERT_FILE.
const pythonUsesSystemTrust =
  python !== undefined &&
  /LibreSSL/.test(
    spawnSync(python, ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'], { encoding: 'utf8' }).stdout,
  );
const curl = findTool(['curl']);
const ruby = findTool(['ruby']);
// macOS's own Ruby uses LibreSSL patched to trust only the macOS keychain, and ignores SSL_CERT_FILE.
const rubyUsesSystemTrust =
  ruby !== undefined &&
  /LibreSSL/.test(
    spawnSync(ruby, ['-ropenssl', '-e', 'print OpenSSL::OPENSSL_VERSION'], { encoding: 'utf8' }).stdout,
  );
const go = findTool(['go'], ['version']);
const php = findTool(['php']);
const hasPhpCurl = php && spawnSync(php, ['-r', 'exit(function_exists("curl_init") ? 0 : 1);']).status === 0;
// Single-file programs (`java Main.java`) need Java 11 or later.
const java = [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java'), 'java']
  .filter((j): j is string => Boolean(j))
  .find((j) =>
    /version "(1[1-9]|[2-9]\d)/.test(spawnSync(j, ['-version'], { encoding: 'utf8' }).stderr ?? ''),
  );

const URL = 'https://leverframe.internal/check';

describe('terminal interception', () => {
  let dataDir: string;
  let backend: RunningBackend;
  let env: NodeJS.ProcessEnv;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let goFile: string;
  let javaFile: string;

  beforeAll(async () => {
    // A space in the path, like macOS's "Application Support", which tools must cope with.
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'leverframe terminal-test-'));
    backend = await startBackend({ dataDir, token: TOKEN, allowedOrigins: [UI_ORIGIN] });
    api = await apiClient(backend.apiPort);
    const status = (api.messages[0] as { status: ProxyStatus }).status;
    // Exactly what a launched terminal gets, on top of this process's environment.
    env = childEnv(process.env, status.terminalEnv);
    goFile = path.join(dataDir, 'main.go');
    await writeFile(
      goFile,
      'package main\nimport ("fmt"; "net/http"; "os")\nfunc main() {\n  r, err := http.Get(os.Args[1])\n  if err != nil { fmt.Println("ERR", err); return }\n  fmt.Print(r.StatusCode)\n}\n',
    );
    javaFile = path.join(dataDir, 'Main.java');
    await writeFile(
      javaFile,
      [
        'import java.net.*;',
        'import java.net.http.*;',
        'public class Main {',
        '  public static void main(String[] args) throws Exception {',
        '    if (args[0].equals("urlconnection")) {',
        '      HttpURLConnection c = (HttpURLConnection) new URL(args[1]).openConnection();',
        '      System.out.println(c.getResponseCode());',
        '    } else {',
        '      HttpResponse<Void> r = HttpClient.newHttpClient().send(',
        '        HttpRequest.newBuilder(URI.create(args[1])).build(), HttpResponse.BodyHandlers.discarding());',
        '      System.out.println(r.statusCode());',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Runs a tool with the terminal environment and checks the request was intercepted. */
  const expectIntercepted = async (command: string, args: string[], marker: string): Promise<void> => {
    const { stdout } = await exec(command, args, { env, timeout: 90_000 });
    expect(stdout.trim().split(/\s+/).pop()).toBe('200');
    await expect
      .poll(() =>
        exchangesIn(api.messages).some((e) => e.path === `/check?from=${marker}` && e.status === 200),
      )
      .toBe(true);
  };

  it('writes a CA bundle with Leverframe first, then the usual roots', async () => {
    const status = (api.messages[0] as { status: ProxyStatus }).status;
    const bundle = await readFile(status.terminalEnv.SSL_CERT_FILE!, 'utf8');
    const ca = await readFile(backend.caCertPath, 'utf8');
    expect(bundle.startsWith(ca.trim())).toBe(true);
    expect(bundle.match(/BEGIN CERTIFICATE/g)!.length).toBeGreaterThan(100);
  });

  it('Node.js fetch', async () => {
    await expectIntercepted(
      process.execPath,
      [
        '-e',
        'fetch(process.argv[1]).then(r => console.log(r.status), e => console.log("ERR", e.cause?.code))',
        `${URL}?from=node-fetch`,
      ],
      'node-fetch',
    );
  });

  it('Node.js https', async () => {
    await expectIntercepted(
      process.execPath,
      [
        '-e',
        'require("https").get(process.argv[1], r => { console.log(r.statusCode); r.resume() }).on("error", e => console.log("ERR", e.code))',
        `${URL}?from=node-https`,
      ],
      'node-https',
    );
  });

  it.skipIf(!curl)('curl', async () => {
    await expectIntercepted(
      curl!,
      ['-sS', '-o', os.devNull, '-w', '%{http_code}', `${URL}?from=curl`],
      'curl',
    );
  });

  it.skipIf(!python || pythonUsesSystemTrust)('Python urllib', async () => {
    await expectIntercepted(
      python!,
      [
        '-c',
        'import sys, urllib.request; print(urllib.request.urlopen(sys.argv[1]).status)',
        `${URL}?from=py-urllib`,
      ],
      'py-urllib',
    );
  });

  it.skipIf(!hasRequests)('Python requests', async () => {
    await expectIntercepted(
      python!,
      ['-c', 'import sys, requests; print(requests.get(sys.argv[1]).status_code)', `${URL}?from=py-requests`],
      'py-requests',
    );
  });

  it.skipIf(!ruby || rubyUsesSystemTrust)('Ruby Net::HTTP', async () => {
    await expectIntercepted(
      ruby!,
      ['-rnet/http', '-e', 'puts Net::HTTP.get_response(URI(ARGV[0])).code', `${URL}?from=ruby`],
      'ruby',
    );
  });

  // Go on Windows reads only the Windows certificate store, so it needs the CA installed there.
  // The first `go run` compiles, which can take a while on a fresh machine.
  it.skipIf(!go || process.platform === 'win32')(
    'Go net/http',
    async () => {
      await expectIntercepted(go!, ['run', goFile, `${URL}?from=go`], 'go');
    },
    180_000,
  );

  it.skipIf(!java)(
    'Java HttpURLConnection',
    async () => {
      await expectIntercepted(
        java!,
        [javaFile, 'urlconnection', `${URL}?from=java-urlconnection`],
        'java-urlconnection',
      );
    },
    120_000,
  );

  it.skipIf(!java)(
    'Java HttpClient',
    async () => {
      await expectIntercepted(
        java!,
        [javaFile, 'httpclient', `${URL}?from=java-httpclient`],
        'java-httpclient',
      );
    },
    120_000,
  );

  it.skipIf(!hasPhpCurl)('PHP curl', async () => {
    await expectIntercepted(
      php!,
      [
        '-r',
        '$c = curl_init($argv[1]); curl_setopt($c, CURLOPT_RETURNTRANSFER, true); curl_exec($c); echo curl_getinfo($c, CURLINFO_HTTP_CODE);',
        `${URL}?from=php`,
      ],
      'php',
    );
  });
});

describe('terminal setup', () => {
  const paths = {
    caPath: "/tmp/it's/ca.pem",
    bundlePath: '/tmp/bundle.pem',
    phpIniDir: '/tmp/php',
    curlHome: '/tmp/curl',
    javaTrustStore: '/tmp/Application Support/trust.jks',
  };
  const env = terminalEnv(8123, paths, 'linux');

  it('points every proxy variable at Leverframe', () => {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      expect(env[key]).toBe('http://127.0.0.1:8123');
    }
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/it's/ca.pem");
  });

  it('adds the PHP settings folder after the usual one, and curl config only on Windows', () => {
    expect(env.PHP_INI_SCAN_DIR).toBe(':/tmp/php');
    expect(env.CURL_HOME).toBeUndefined();
    const windows = terminalEnv(
      8123,
      { ...paths, phpIniDir: 'C:\\lf\\php', curlHome: 'C:\\lf\\curl' },
      'win32',
    );
    expect(windows.PHP_INI_SCAN_DIR).toBe(';C:\\lf\\php');
    expect(windows.CURL_HOME).toBe('C:\\lf\\curl');
  });

  it('writes PHP and curl config that point at the bundle', () => {
    expect(phpIniContent('/x/ca-bundle.pem')).toContain('curl.cainfo = "/x/ca-bundle.pem"');
    expect(phpIniContent('/x/ca-bundle.pem')).toContain('openssl.cafile = "/x/ca-bundle.pem"');
    const curlrc = curlrcContent('C:\\Users\\me\\ca-bundle.pem');
    expect(curlrc).toContain('cacert = "C:\\\\Users\\\\me\\\\ca-bundle.pem"');
    expect(curlrc).toContain('ssl-no-revoke');
  });

  it('gives Java the proxy and a quoted trust store path', () => {
    expect(env.JAVA_TOOL_OPTIONS).toBe(
      '-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=8123 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=8123 ' +
        '-Djavax.net.ssl.trustStore="/tmp/Application Support/trust.jks" -Djavax.net.ssl.trustStorePassword=changeit ' +
        '-Djavax.net.ssl.trustStoreType=JKS',
    );
  });

  it('quotes values for each shell', () => {
    expect(shellSnippet(env, 'posix')).toContain(`export NODE_EXTRA_CA_CERTS='/tmp/it'\\''s/ca.pem'`);
    expect(shellSnippet(env, 'fish')).toContain(`set -gx NODE_EXTRA_CA_CERTS '/tmp/it\\'s/ca.pem'`);
    expect(shellSnippet(env, 'powershell')).toContain(`$env:NODE_EXTRA_CA_CERTS = '/tmp/it''s/ca.pem'`);
    const cmd = shellSnippet(env, 'cmd');
    expect(cmd).toContain(`set "HTTP_PROXY=http://127.0.0.1:8123"`);
    expect(cmd).not.toContain('set "http_proxy='); // Same variable on Windows.
  });

  it.skipIf(process.platform === 'win32')(
    'builds a start script that sets the variables, deletes itself and starts the shell',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-script-test-'));
      const script = path.join(dir, 'start.command');
      await writeFile(script, posixStartScript(env, '127.0.0.1:8123'), { mode: 0o700 });
      // Stand in for the user's shell: print what it was given.
      const fakeShell = path.join(dir, 'fake-shell');
      await writeFile(fakeShell, '#!/bin/sh\necho "proxy=$HTTPS_PROXY ca=$NODE_EXTRA_CA_CERTS args=$*"\n', {
        mode: 0o755,
      });
      const { stdout } = await exec('/bin/sh', [script], { env: { ...process.env, SHELL: fakeShell } });
      expect(stdout).toContain('sends HTTP and HTTPS traffic through Leverframe (127.0.0.1:8123)');
      expect(stdout).toContain("proxy=http://127.0.0.1:8123 ca=/tmp/it's/ca.pem args=-l");
      await expect(stat(script)).rejects.toThrow();
      await rm(dir, { recursive: true, force: true });
    },
  );

  it('strips Electron variables from the inherited environment', () => {
    const merged = childEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', HOME: '/h' }, { HTTP_PROXY: 'x' });
    expect(merged).toEqual({ PATH: '/bin', HOME: '/h', HTTP_PROXY: 'x' });
  });

  it('finds terminals for each platform', async () => {
    expect((await detectTerminals('darwin', { HOME: '/nonexistent' })).map((t) => t.id)).toContain(
      'terminal',
    );
    expect((await detectTerminals('win32', { PATH: '' })).map((t) => t.id)).toEqual(['powershell', 'cmd']);
    if (process.platform !== 'win32') {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'leverframe-path-test-'));
      await writeFile(path.join(dir, 'xterm'), '#!/bin/sh\n', { mode: 0o755 });
      expect(await detectTerminals('linux', { PATH: dir })).toMatchObject([
        { id: 'xterm', execFlag: ['-e'] },
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
