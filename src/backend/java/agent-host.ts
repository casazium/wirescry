import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  caSha256,
  installAgentJars,
  pruneAgentJars,
  writeControl,
  type AgentControl,
  type FileOps,
} from './agent-files';

/** The agent's folder in the data folder. */
export const JAVA_AGENT_DIR = 'java-agent';

/** The built agent's jars (scripts/build-java-agent.mjs). */
export interface AgentJars {
  stub: string;
  impl: string;
  weaver: string;
  /** The attacher, run from where it is (it isn't copied into the data folder). */
  attach: string;
}

export const JAR_NAMES: AgentJars = {
  stub: 'wirescry-agent.jar',
  impl: 'wirescry-agent-impl.jar',
  weaver: 'wirescry-agent-weaver.jar',
  attach: 'wirescry-attach.jar',
};

/**
 * Where the agent is: in the app's resources once packaged (electron-builder.cjs), else where
 * scripts/build-java-agent.mjs builds it. Undefined if any jar is missing.
 */
export function findAgentJars(
  resources: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
): AgentJars | undefined {
  const built = path.join('native', 'java-agent', 'build');
  const dirs = [
    ...(resources ? [path.join(resources, 'java-agent')] : []),
    // The built backend (out/main or out/main/chunks), and the source (src/backend/java) under tests.
    path.join(__dirname, '..', '..', built),
    path.join(__dirname, '..', '..', '..', built),
  ];
  for (const dir of dirs) {
    const jars = {
      stub: path.join(dir, JAR_NAMES.stub),
      impl: path.join(dir, JAR_NAMES.impl),
      weaver: path.join(dir, JAR_NAMES.weaver),
      attach: path.join(dir, JAR_NAMES.attach),
    };
    if (Object.values(jars).every((file) => existsSync(file))) return jars;
  }
  return undefined;
}

/** The `detached` ids in the control file an earlier Wirescry left, or none. */
export async function readDetached(dir: string): Promise<string[]> {
  const text = await readFile(path.join(dir, 'control.properties'), 'utf8').catch(() => '');
  const line = /^detached=(.*)$/m.exec(text);
  if (!line?.[1]) return [];
  return line[1]
    .replace(/\r$/, '')
    .split(',')
    .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))
    .slice(0, 1000);
}

/** What the agents follow, from Wirescry's own state. */
export interface AgentSettings {
  proxyPort: number;
  /** Wirescry's CA certificate: its PEM file, and the PEM itself. */
  caPath: string;
  caPem: string;
  /** Whether agents loaded at startup (not attached) are on. */
  startup: boolean;
}

export interface JavaAgentHostOptions {
  /** `<data folder>/java-agent`. */
  dir: string;
  jars: AgentJars;
  /** This Wirescry's version, in the agent's file name. */
  version: string;
  /** How often the heartbeat moves (default 5 s; agents count 15 reads without a move as gone). */
  heartbeatMs?: number;
  /** The process agents check is alive (default this one). */
  pid?: number;
  ops?: FileOps;
}

/**
 * Wirescry's side of its Java agents while it runs (see native/java-agent): puts the agent's jars
 * in the data folder, and keeps the control file every agent reads current. Its heartbeat moves
 * every few seconds; agents turn off when it stops (or, on Java 9+, when this process is gone),
 * and on a clean stop it says off at once.
 */
export class JavaAgentHost {
  private settings: AgentSettings;
  private ca: string;
  // Numbers that a Wirescry started later never repeats: agents in long-lived JVMs compare them.
  private config = Date.now();
  private seq = Date.now();
  private enabled = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private heartbeatFailed = false;
  private detached: Set<string>;

  private constructor(
    private readonly options: JavaAgentHostOptions,
    private readonly impl: string,
    settings: AgentSettings,
    detached: Iterable<string>,
  ) {
    this.settings = settings;
    this.ca = caSha256(settings.caPem);
    this.detached = new Set(detached);
  }

  /**
   * Installs the jars, writes the control file and starts the heartbeat. Then deletes pairs of
   * jars that no Wirescry has used for a week.
   */
  static async start(options: JavaAgentHostOptions, settings: AgentSettings): Promise<JavaAgentHost> {
    const impl = await installAgentJars(
      options.dir,
      { ...options.jars, version: options.version },
      options.ops,
    );
    // Attached agents the user turned off stay off when Wirescry starts again.
    const host = new JavaAgentHost(options, impl, settings, await readDetached(options.dir));
    await host.write();
    host.timer = setInterval(() => host.beat(), options.heartbeatMs ?? 5000);
    host.timer.unref();
    const deleted = await pruneAgentJars(options.dir, impl).catch(() => []);
    if (deleted.length > 0) console.log(`[wirescry] java agent: deleted unused ${deleted.join(', ')}`);
    return host;
  }

  private beat(): void {
    this.seq++;
    this.write().then(
      () => {
        if (this.heartbeatFailed) console.log('[wirescry] java agent: heartbeat written again');
        this.heartbeatFailed = false;
      },
      (error: unknown) => {
        // Once per failure: a full disk would otherwise log every few seconds. Agents turn off on
        // their own when the heartbeat stops.
        if (!this.heartbeatFailed) console.error('[wirescry] java agent: heartbeat not written:', error);
        this.heartbeatFailed = true;
      },
    );
  }

  /** The stub that `-javaagent:` names: a path that never changes. */
  get stubPath(): string {
    return path.join(this.options.dir, 'wirescry-agent.jar');
  }

  /** Follows a change in Wirescry's port, CA or the startup setting. */
  async update(settings: AgentSettings): Promise<void> {
    // Once stopped, it stays off: a late update must not turn agents back on.
    if (!this.enabled) return;
    const ca = caSha256(settings.caPem);
    const before = this.settings;
    if (
      before.proxyPort === settings.proxyPort &&
      before.caPath === settings.caPath &&
      this.ca === ca &&
      before.startup === settings.startup
    ) {
      return;
    }
    // `config` tells agents (and the status they write back) which settings they have applied; the
    // startup setting doesn't change what an applied agent does, so it keeps the number.
    if (before.proxyPort !== settings.proxyPort || before.caPath !== settings.caPath || this.ca !== ca) {
      this.config++;
    }
    this.settings = settings;
    this.ca = ca;
    await this.write();
  }

  /** The control file's `config` now: agents report it back once they've applied it. */
  get currentConfig(): number {
    return this.config;
  }

  /** Attached agents turned off, by id. */
  get detachedIds(): ReadonlySet<string> {
    return this.detached;
  }

  /**
   * Turns attached agents off (`off`), or back on, by id, and forgets ids no agent reports any
   * more (`keep`: the ids of agents alive now), so the list doesn't grow for good.
   */
  async setDetached(change: { off?: string[]; on?: string[]; keep?: ReadonlySet<string> }): Promise<void> {
    if (!this.enabled) return;
    const next = new Set(this.detached);
    for (const id of change.on ?? []) next.delete(id);
    for (const id of change.off ?? []) next.add(id);
    if (change.keep)
      for (const id of next) if (!change.keep.has(id) && !change.off?.includes(id)) next.delete(id);
    if (next.size === this.detached.size && [...next].every((id) => this.detached.has(id))) return;
    this.detached = next;
    // Agents re-read on a `config` change; detaching doesn't change what an applied agent sends
    // where, so it keeps the number, like the startup setting.
    await this.write();
  }

  /** Says off to every agent, and stops the heartbeat. Wirescry is quitting. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.enabled) return;
    this.enabled = false;
    this.config++;
    await this.write();
  }

  /** One write at a time, each with the latest state, so an older one never lands last. */
  private write(): Promise<void> {
    const next = this.writes.then(() => writeControl(this.options.dir, this.control(), this.options.ops));
    this.writes = next.catch(() => undefined);
    return next;
  }

  private control(): AgentControl {
    return {
      impl: this.impl,
      enabled: this.enabled,
      startup: this.settings.startup,
      proxyPort: this.settings.proxyPort,
      config: this.config,
      seq: this.seq,
      wirescryPid: this.options.pid ?? process.pid,
      caSha256: this.ca,
      caPath: this.settings.caPath,
      detached: [...this.detached].sort(),
    };
  }
}
