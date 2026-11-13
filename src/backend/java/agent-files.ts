import { createHash, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Wirescry's side of the Java agent's files (native/java-agent), in `<data folder>/java-agent/`:
 *
 * - `wirescry-agent.jar`: the stub, at a path that never changes, so a `-javaagent:` option copied
 *   into an IDE keeps working across updates.
 * - `jars/wirescry-agent-impl-<version>-<sha8>.jar`, with its weaver (Byte Buddy) beside it as
 *   `…-<sha8>-weaver.jar`: the agent, one pair per build. A running JVM
 *   keeps the copy it loaded open, so copies are added, never replaced, and Windows updates can
 *   still replace the app's own files.
 * - `control.properties`: Wirescry's settings for every agent, read before a program's main and
 *   then every second.
 * - `status/<pid>-<id>.properties`: each agent's report.
 *
 * Only this user may write any of it: the agent refuses files others can change (they could run
 * code in, or redirect the traffic of, every Java program the user starts), and stays off.
 */

/**
 * The format both sides speak; the agent's Control.PROTOCOL. In each file, `protocol` is the oldest
 * protocol a reader must speak to use it. Adding keys keeps the number (readers ignore keys they
 * don't know), so agents already running in JVMs, which keep the agent they loaded, keep working.
 * Raise it only for a change an older reader would misread; older agents then turn off.
 */
export const AGENT_PROTOCOL = 1;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMPL = /^jars\/wirescry-agent-impl-[0-9A-Za-z.+_-]{1,64}\.jar$/;

export interface AgentControl {
  /** The implementation jar, as `installAgentJars` returns it. */
  impl: string;
  enabled: boolean;
  /** Whether agents loaded at startup (not attached) are on. */
  startup: boolean;
  proxyPort: number;
  /** Changes when the port, the CA or `enabled` change. */
  config: number;
  /** The heartbeat: changed every few seconds while Wirescry runs. */
  seq: number;
  /** Wirescry's backend process: agents on Java 9+ stop within a second when it's gone. */
  wirescryPid?: number;
  /** How long a startup agent waits before writing its status file (default 5 s). */
  statusDelayMs?: number;
  /** Wirescry's CA: its SHA-256 (see caSha256) and its PEM file's absolute path. */
  caSha256?: string;
  caPath?: string;
  /** Attached agents switched off, by id. */
  detached: string[];
}

export interface AgentStatus {
  agentVersion: string;
  route: 'startup' | 'attach';
  id: string;
  pid: number;
  java: string;
  enabled: boolean;
  /** Why it's on or off: on, off, startup-off, detached, wirescry-gone, bad-control, no-control, unsafe-files. */
  reason: string;
  /** The control file's `config` the agent has applied, or -1 before any good read. */
  appliedConfig: number;
  port?: number;
  caSha256?: string;
  hooks: string[];
  /** Goes up each time the agent writes: a live agent writes at least every 5 s. */
  beat: number;
}

/** The control file's text. Throws if a setting is out of range (a bug in Wirescry). */
export function formatControl(control: AgentControl): string {
  const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!IMPL.test(control.impl)) throw new Error(`Bad agent jar name: ${control.impl}`);
  if (!Number.isInteger(control.proxyPort) || control.proxyPort < 1 || control.proxyPort > 65535) {
    throw new Error(`Bad proxy port: ${control.proxyPort}`);
  }
  if (!count(control.config) || !count(control.seq)) throw new Error('Bad config or seq');
  if (control.wirescryPid !== undefined && !count(control.wirescryPid)) throw new Error('Bad pid');
  const delay = control.statusDelayMs;
  if (delay !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > 60_000)) {
    throw new Error(`Bad status delay: ${delay}`);
  }
  if (control.caSha256 !== undefined && !/^[0-9a-f]{64}$/.test(control.caSha256))
    throw new Error('Bad CA hash');
  if (control.caPath !== undefined) {
    const ca = control.caPath;
    // One line, and a path the agent takes as absolute on this system.
    if (!path.isAbsolute(ca) || ca.length > 1024 || /[\r\n\0]/.test(ca))
      throw new Error(`Bad CA path: ${ca}`);
  }
  for (const id of control.detached) if (!ID.test(id)) throw new Error(`Bad agent id: ${id}`);
  const lines = [
    `protocol=${AGENT_PROTOCOL}`,
    `impl=${control.impl}`,
    `enabled=${control.enabled}`,
    `startup=${control.startup}`,
    `proxyPort=${control.proxyPort}`,
    `config=${control.config}`,
    `seq=${control.seq}`,
    ...(control.wirescryPid !== undefined ? [`wirescryPid=${control.wirescryPid}`] : []),
    ...(delay !== undefined ? [`statusDelayMs=${delay}`] : []),
    ...(control.caSha256 ? [`caSha256=${control.caSha256}`] : []),
    ...(control.caPath ? [`caPath=${control.caPath}`] : []),
    `detached=${control.detached.join(',')}`,
    'end=1',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The SHA-256, in hex, of a CA certificate's DER encoding: what the control file's `caSha256` is.
 * The agent checks the CA it reads against it, and takes a change as a new CA.
 */
export function caSha256(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}

/** A status file's contents, or undefined if it's half-written, damaged or from another protocol. */
export function parseStatus(text: string): AgentStatus | undefined {
  const fields = new Map<string, string>();
  let ended = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (ended) return undefined;
    const eq = line.indexOf('=');
    if (eq <= 0) return undefined;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'end') {
      if (value !== '1') return undefined;
      ended = true;
    } else if (!fields.has(key)) {
      fields.set(key, value);
    } else {
      return undefined;
    }
  }
  const protocol = Number(fields.get('protocol'));
  if (!ended || !Number.isInteger(protocol) || protocol < 1 || protocol > AGENT_PROTOCOL) return undefined;
  const number = (key: string, min = 0) => {
    const value = fields.get(key);
    if (value === undefined || !/^-?\d{1,18}$/.test(value)) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= min ? n : undefined;
  };
  const route = fields.get('route');
  const id = fields.get('id') ?? '';
  const enabled = fields.get('enabled');
  const reason = fields.get('reason') ?? '';
  const pid = number('pid', 1);
  const appliedConfig = number('appliedConfig', -1);
  const beat = number('beat', 1);
  const portText = fields.get('port');
  const port = portText === undefined ? undefined : number('port', 1);
  const ca = fields.get('caSha256');
  const printable = (value: string | undefined) => value !== undefined && /^[!-<>-~]{0,64}$/.test(value);
  if (
    (route !== 'startup' && route !== 'attach') ||
    !ID.test(id) ||
    (enabled !== 'true' && enabled !== 'false') ||
    !/^[a-z-]{1,32}$/.test(reason) ||
    pid === undefined ||
    appliedConfig === undefined ||
    beat === undefined ||
    (portText !== undefined && (port === undefined || port > 65535)) ||
    (ca !== undefined && !/^[0-9a-f]{64}$/.test(ca)) ||
    !printable(fields.get('agentVersion')) ||
    !printable(fields.get('java'))
  ) {
    return undefined;
  }
  const hooks = fields.get('hooks') ?? '';
  if (!/^[a-z0-9:,-]{0,256}$/.test(hooks)) return undefined;
  return {
    agentVersion: fields.get('agentVersion') ?? '',
    route,
    id,
    pid,
    java: fields.get('java') ?? '',
    enabled: enabled === 'true',
    reason,
    appliedConfig,
    ...(port !== undefined ? { port } : {}),
    ...(ca !== undefined ? { caSha256: ca } : {}),
    hooks: hooks ? hooks.split(',') : [],
    beat,
  };
}

export interface FileOps {
  rename: typeof rename;
  /** Waits between rename tries. */
  sleep: (ms: number) => Promise<void>;
}

const realOps: FileOps = { rename, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** Codes Windows gives a rename while another process has the file open. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Writes `data` to `file` whole: to a temporary file, then renamed over it, so a reader sees the
 * old contents or the new, never half. On Windows a reader holding the file blocks the rename, so
 * it's tried a few times.
 */
export async function writeWhole(file: string, data: string | Buffer, ops: FileOps = realOps): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await chmod(temp, 0o600);
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!BUSY.has(code) || attempt >= 4) {
        await rm(temp, { force: true });
        throw error;
      }
      await ops.sleep(50 * 2 ** attempt);
    }
  }
}

/** Makes `dir` and its `jars` and `status` folders, each this user's alone (0700). */
export async function makeAgentFolder(dir: string): Promise<void> {
  for (const folder of [dir, path.join(dir, 'jars'), path.join(dir, 'status')]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing folder's mode as it was.
    await chmod(folder, 0o700);
  }
}

export async function writeControl(dir: string, control: AgentControl, ops?: FileOps): Promise<void> {
  await writeWhole(path.join(dir, 'control.properties'), formatControl(control), ops);
}

/**
 * Puts the stub and this build's agent in `dir`: the stub replaced only when it differs, the agent
 * added under a name of its own. Returns the agent's name for the control file's `impl`.
 */
export async function installAgentJars(
  dir: string,
  built: { stub: string; impl: string; weaver: string; version: string },
  ops?: FileOps,
): Promise<string> {
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(built.version)) throw new Error(`Bad version: ${built.version}`);
  await makeAgentFolder(dir);
  const stub = await readFile(built.stub);
  const stubFile = path.join(dir, 'wirescry-agent.jar');
  const current = await readFile(stubFile).catch(() => undefined);
  if (!current?.equals(stub)) {
    try {
      await writeWhole(stubFile, stub, ops);
    } catch (error) {
      // On Windows a running JVM holds the stub it loaded. The one there still works: it only reads
      // the control file's `impl`, a format that doesn't change. It's replaced next time.
      if (!current || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const impl = await readFile(built.impl);
  const weaver = await readFile(built.weaver);
  // Named by both: a pair a running JVM may hold is never overwritten, even when only the weaver
  // (a Byte Buddy update) changed.
  const sha8 = createHash('sha256').update(impl).update(weaver).digest('hex').slice(0, 8);
  const name = `jars/wirescry-agent-impl-${built.version}-${sha8}.jar`;
  const implFile = path.join(dir, name);
  // The agent finds its weaver by its own name (Hooks.weaverJar).
  const weaverFile = implFile.replace(/\.jar$/, '-weaver.jar');
  for (const [file, bytes] of [
    [implFile, impl],
    [weaverFile, weaver],
  ] as const) {
    if (!(await readFile(file).catch(() => undefined))?.equals(bytes)) await writeWhole(file, bytes);
    // The agent refuses jars others can write. Same bytes restored with looser permissions (from a
    // backup, say) would leave it off for good, so they're set every time.
    await chmod(file, 0o600);
  }
  await chmod(stubFile, 0o600);
  // Marks the pair as in use now: pruneAgentJars keeps pairs a Wirescry used lately.
  const now = new Date();
  await utimes(implFile, now, now);
  await utimes(weaverFile, now, now);
  return name;
}

/** How long a pair no Wirescry has installed stays: long enough for the JVMs that loaded it. */
export const AGENT_JARS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deletes the agent pairs in `dir/jars` other than `current` (installAgentJars' name) that no
 * Wirescry has installed for `keptMs`, so each update doesn't leave a few MB behind for good. A
 * JVM still running one keeps the files it has open (on Windows, the delete fails and it's left
 * for next time); it only loses the weaver if it never needed it in all that time. Returns the
 * names deleted.
 */
export async function pruneAgentJars(
  dir: string,
  current: string,
  keptMs = AGENT_JARS_KEPT_MS,
  now = Date.now(),
): Promise<string[]> {
  const jars = path.join(dir, 'jars');
  const deleted: string[] = [];
  for (const name of await readdir(jars).catch(() => [] as string[])) {
    const pair = /^(wirescry-agent-impl-[0-9A-Za-z.+_-]{1,64}?)(-weaver)?\.jar$/.exec(name);
    if (!pair || `jars/${pair[1]}.jar` === current) continue;
    const file = path.join(jars, name);
    // A pair goes by its agent's time, so its weaver never goes first.
    const used = await stat(path.join(jars, `${pair[1]}.jar`)).catch(() => undefined);
    if (used && now - used.mtimeMs < keptMs) continue;
    try {
      await rm(file);
      deleted.push(name);
    } catch {
      // Held open (Windows), or gone already.
    }
  }
  return deleted;
}

/** Every readable status file in `dir/status`. Half-written or damaged ones are left out. */
export async function readStatuses(dir: string): Promise<AgentStatus[]> {
  const folder = path.join(dir, 'status');
  const names = await readdir(folder).catch(() => [] as string[]);
  const statuses: AgentStatus[] = [];
  for (const name of names) {
    const match = /^(\d{1,18})-([A-Za-z0-9_-]{1,64})\.properties$/.exec(name);
    if (!match) continue;
    const status = parseStatus(await readFile(path.join(folder, name), 'utf8').catch(() => ''));
    // The file's name must agree with what it says.
    if (status && String(status.pid) === match[1] && status.id === match[2]) statuses.push(status);
  }
  return statuses;
}
