import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adbServerVersion, DEFAULT_ADB_PORT, type AdbEndpoint } from './adb-client';

/**
 * Finding the user's adb and starting its server when none runs. Wirescry doesn't bundle adb
 * (the SDK licence doesn't allow it): it uses the server Android Studio and the emulator use,
 * and never kills or restarts it, never makes it listen beyond localhost, and never turns on
 * Wi-Fi debugging.
 */

/** Shown when no adb is found. Homebrew's android-platform-tools is a macOS cask. */
export function noAdb(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'Install Android platform tools: they come with Android Studio, or with Homebrew (android-platform-tools).'
    : 'Install Android platform tools: they come with Android Studio, or as SDK Platform Tools from developer.android.com.';
}

export interface FindAdbOptions {
  /** The user's own choice, from Wirescry's settings. */
  setting?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Whether this is an executable file. For tests. */
  isExecutable?: (file: string) => boolean;
}

/**
 * Where to look, in order. The SDK's adb comes before Homebrew's and PATH's: two adb versions
 * would make one kill the other's server, and Android Studio uses the SDK's.
 * Source for the variables: https://developer.android.com/tools/variables (ANDROID_HOME;
 * ANDROID_SDK_ROOT is deprecated). Default SDK folders are Android Studio's.
 */
export function adbCandidates(options: FindAdbOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const inSdk = (sdk: string | undefined) => (sdk?.trim() ? [p.join(sdk.trim(), 'platform-tools', exe)] : []);
  const defaultSdk =
    platform === 'darwin'
      ? p.join(home, 'Library', 'Android', 'sdk')
      : platform === 'win32'
        ? env.LOCALAPPDATA
          ? p.join(env.LOCALAPPDATA, 'Android', 'Sdk')
          : undefined
        : p.join(home, 'Android', 'Sdk');
  const homebrew =
    platform === 'darwin'
      ? ['/opt/homebrew/bin/adb', '/usr/local/bin/adb']
      : platform === 'linux'
        ? ['/home/linuxbrew/.linuxbrew/bin/adb']
        : [];
  const onPath = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((dir) => dir && p.isAbsolute(dir))
    .map((dir) => p.join(dir, exe));
  const all = [
    ...(options.setting?.trim() ? [options.setting.trim()] : []),
    ...inSdk(env.ANDROID_HOME),
    ...inSdk(env.ANDROID_SDK_ROOT),
    ...inSdk(defaultSdk),
    ...homebrew,
    ...onPath,
  ];
  // Only absolute paths: a relative one would depend on the folder Wirescry started in.
  return [...new Set(all.filter((file) => p.isAbsolute(file)))];
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first adb found, as an absolute path, or undefined. */
export function findAdb(options: FindAdbOptions = {}): string | undefined {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  return adbCandidates(options).find((file) => isExecutable(file));
}

export type RunFile = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

const runFile: RunFile = (file, args, env) =>
  new Promise((resolve, reject) => {
    // No shell: the path and arguments go to the program as they are.
    execFile(file, args, { env, timeout: 30_000, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

/**
 * Starts the server with `adb start-server`, on the port Wirescry will use. It listens on
 * localhost only unless given -a, which Wirescry never passes.
 */
export async function startAdbServer(
  adbPath: string,
  endpoint: AdbEndpoint,
  run: RunFile = runFile,
): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // adb reads the same variables to find its server; make it start the one we'll talk to.
  delete env.ADB_SERVER_SOCKET;
  if (endpoint.port === DEFAULT_ADB_PORT) delete env.ANDROID_ADB_SERVER_PORT;
  else env.ANDROID_ADB_SERVER_PORT = String(endpoint.port);
  await run(adbPath, ['start-server'], env);
}

export type AdbServerState =
  | { state: 'running'; version: number; started: boolean; adbPath?: string }
  | { state: 'no-adb' }
  /** None running, and not asked to start one. */
  | { state: 'not-running' }
  | { state: 'failed'; error: string; adbPath?: string };

export interface EnsureOptions {
  endpoint: AdbEndpoint;
  /** Finds adb, if a server has to be started. */
  findAdb: () => string | undefined;
  /** Whether to start a server when none answers. */
  start: boolean;
  run?: RunFile;
  timeoutMs?: number;
}

/**
 * Checks for a running server, starting one with the user's adb only if nothing is listening.
 * A server that answers is never restarted, even an old one.
 */
export async function ensureAdbServer(options: EnsureOptions): Promise<AdbServerState> {
  const version = () => adbServerVersion(options.endpoint, { timeoutMs: options.timeoutMs });
  try {
    return { state: 'running', version: await version(), started: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ECONNREFUSED') return { state: 'failed', error: (error as Error).message };
  }
  if (!options.start) return { state: 'not-running' };
  const adbPath = options.findAdb();
  if (!adbPath) return { state: 'no-adb' };
  try {
    await startAdbServer(adbPath, options.endpoint, options.run);
    return { state: 'running', version: await version(), started: true, adbPath };
  } catch (error) {
    return {
      state: 'failed',
      error: `Couldn’t start the ADB server with ${adbPath}: ${(error as Error).message}`,
      adbPath,
    };
  }
}
