import { randomBytes } from 'node:crypto';
import type { JavaAttachStatus, JavaProgram } from '../../shared/api';
import type { AgentStatus } from './agent-files';
import type { JavaAgentHost } from './agent-host';
import { attacher as makeAttacher, type Attacher, type ListedJvm, type LoadResult } from './attacher';
import { findJdk, type JdkSearch } from './jdk';
import { programsOf, StatusReader, type StatusReaderOptions } from './programs';

/**
 * Attaching Wirescry's Java agent to programs already running, for the Setup page: finds a JDK
 * that can attach, lists Java programs, loads the agent into one, and turns one off (Detach). The
 * agent then reports through its status file (programs.ts); a program shows as attached only once
 * it does.
 */

export interface JavaAttachOptions {
  /** `<data folder>/java-agent`. */
  dir: string;
  /** The attacher jar (AgentJars.attach). */
  attachJar: string;
  /** This Wirescry's version: agents reporting another are from an earlier one. */
  version: string;
  /** The running host, started if it isn't: attached agents follow its control file. */
  host: () => Promise<JavaAgentHost>;
  /**
   * The host if it runs now, without starting one (once `host` resolves, the same one): the list
   * compares each agent with its settings, and ended programs leave its detached list, from
   * Wirescry's start, not only after an attach.
   */
  running: () => JavaAgentHost | undefined;
  /** Whether the user agreed to Java 21's warning, and saving that they did. */
  warningOk: () => boolean;
  saveWarningOk: () => Promise<void>;
  /** Something the Setup page shows changed. */
  changed: () => void;
  findJdk?: () => Promise<JdkSearch>;
  attacher?: (java: string, jar: string) => Attacher;
  statusReader?: StatusReaderOptions;
  /** How often status files are read while anything has the agent (default 2 s). */
  pollMs?: number;
}

export type AttachReply = { attached: true } | { needsConfirmation: 'java-warning' };

/** What a refusal means for the user, by the attacher's reason. */
export function attachNote(
  result: Extract<LoadResult, { ok: false }>,
  platform: NodeJS.Platform = process.platform,
): string {
  const message = result.message ? ` (${result.message.replace(/[.\s]+$/, '')})` : '';
  switch (result.reason) {
    case 'dynamic-loading-disabled':
      return "This program refuses agents loaded while it runs (it was started with -XX:-EnableDynamicAgentLoading). Start it with Wirescry's JVM option instead.";
    case 'attach-not-supported':
    case 'attach-failed':
      if (/respond within/i.test(result.message ?? '')) {
        return "The program didn't answer in time: it may be paused in a debugger, or very busy. Try again.";
      }
      return platform === 'win32'
        ? `Java didn't let Wirescry attach${message}. Programs run as administrator, or by another user, can't be attached to; nor can ones started with -XX:+DisableAttachMechanism.`
        : `Java didn't let Wirescry attach${message}. Programs started with -XX:+DisableAttachMechanism can't be attached to.`;
    case 'agent-load-failed':
    case 'agent-init-failed':
    case 'load-failed':
      return `The program didn't load Wirescry's agent${message}. Its Java may lack agent support (some trimmed runtimes do).`;
    case 'not-a-jvm':
      return "Java doesn't list this process as a Java program it can attach to: it may have ended, run as another user, or have been started with -XX:-UsePerfData.";
    case 'needs-confirmation':
      return 'This program runs Java 21 or later, which prints a warning when an agent is attached.';
    default:
      return `Attaching failed${message}.`;
  }
}

export class JavaAttach {
  private search: JdkSearch | undefined;
  private searching: Promise<JdkSearch> | undefined;
  private listed: ListedJvm[] | undefined;
  private listError: string | undefined;
  /** Agents writing now (shown), and agents whose program runs, writing or not. */
  private statuses: AgentStatus[] = [];
  private running: AgentStatus[] = [];
  private refreshing: Promise<JavaAttachStatus> | undefined;
  private readonly busy = new Map<number, 'attaching' | 'detaching'>();
  private readonly notes = new Map<number, string>();
  private readonly reader: StatusReader;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private looked = false;
  private last = '';

  constructor(private readonly options: JavaAttachOptions) {
    this.reader = new StatusReader(options.dir, options.statusReader);
  }

  /** What Setup shows, or undefined before anything looked. */
  status(): JavaAttachStatus | undefined {
    if (!this.looked) return undefined;
    const jdk = this.search?.jdk;
    const state: JavaAttachStatus['state'] = this.checking
      ? 'checking'
      : !jdk
        ? 'no-jdk'
        : this.listError
          ? 'failed'
          : 'ready';
    // A program Wirescry is doing something to, or has a note for, is shown even if it isn't listed.
    const extra = [...new Set([...this.busy.keys(), ...this.notes.keys()])]
      .filter((pid) => !this.listed?.some((jvm) => jvm.pid === pid))
      .map((pid) => ({ pid, name: '' }));
    // The host if it runs: started by an attach or detach, or by Wirescry's start.
    const host = this.options.running();
    const programs: JavaProgram[] = programsOf({
      listed: [...(this.listed ?? []), ...extra],
      statuses: this.statuses,
      config: host?.currentConfig ?? -1,
      version: this.options.version,
      detached: host?.detachedIds ?? new Set(),
    }).map((program) => ({
      ...program,
      ...(this.busy.has(program.pid) ? { busy: this.busy.get(program.pid) } : {}),
      ...(this.notes.has(program.pid) ? { note: this.notes.get(program.pid) } : {}),
    }));
    return {
      state,
      ...(jdk ? { jdk: { home: jdk.home, version: jdk.version } } : {}),
      ...(this.listError && jdk ? { error: this.listError } : {}),
      ...(!jdk && this.search && this.search.passed.length > 0 ? { passed: this.search.passed } : {}),
      programs,
      warningOk: this.options.warningOk(),
    };
  }

  /** Looks for a JDK again, lists programs, and reads the status files. One at a time. */
  refresh(): Promise<JavaAttachStatus> {
    this.refreshing ??= this.refreshOnce().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<JavaAttachStatus> {
    this.looked = true;
    this.checking = true;
    this.changed();
    try {
      this.search = undefined;
      await this.jdk();
      await this.list();
      await this.readStatuses();
    } finally {
      this.checking = false;
    }
    this.startPolling();
    this.changed(true);
    return this.status()!;
  }

  /** Loads the agent into `pid`, or turns its detached agent back on. */
  async attach(pid: number, confirmWarning: boolean): Promise<AttachReply> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Not a process id.');
    if (this.busy.has(pid)) throw new Error('Wirescry is already doing something to this program.');
    this.looked = true;
    this.busy.set(pid, 'attaching');
    this.notes.delete(pid);
    this.changed();
    try {
      const host = await this.ensureHost();
      await this.readStatuses();
      // Any agent whose program runs, writing or not (paused in a debugger, say).
      const agent =
        this.running.find((s) => s.pid === pid && s.enabled) ?? this.running.find((s) => s.pid === pid);
      if (agent) {
        if (agent.route === 'startup' && agent.reason === 'startup-off') {
          const note =
            "This program started with Wirescry's agent, which follows the setting for Java programs started from Wirescry terminals: turn that on.";
          this.notes.set(pid, note);
          throw new Error(note);
        }
        // A JVM keeps the first agent it loaded: a second load starts nothing. Turn that one on.
        await host.setDetached({ on: [agent.id] });
        return { attached: true };
      }
      if (confirmWarning && !this.options.warningOk()) await this.options.saveWarningOk();
      const jdk = (await this.jdk()).jdk;
      if (!jdk) throw new Error("Wirescry didn't find a JDK it can attach with.");
      const tool = (this.options.attacher ?? makeAttacher)(jdk.java, this.options.attachJar);
      const id = `a${randomBytes(9).toString('hex')}`;
      const result = await tool.load(pid, host.stubPath, id, this.options.warningOk());
      if (!result.ok) {
        if (result.reason === 'needs-confirmation') return { needsConfirmation: 'java-warning' };
        const note = attachNote(result);
        this.notes.set(pid, note);
        throw new Error(note);
      }
      this.startPolling();
      return { attached: true };
    } finally {
      this.busy.delete(pid);
      await this.readStatuses().catch(() => undefined);
      this.changed(true);
    }
  }

  /** Turns `pid`'s agent off. It stays loaded (agents can't be unloaded), sending nothing. */
  async detach(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Not a process id.');
    if (this.busy.has(pid)) throw new Error('Wirescry is already doing something to this program.');
    this.busy.set(pid, 'detaching');
    this.notes.delete(pid);
    this.changed();
    try {
      const host = await this.ensureHost();
      await this.readStatuses();
      const ids = this.running.filter((s) => s.pid === pid).map((s) => s.id);
      if (ids.length === 0) throw new Error("Wirescry's agent isn't running in this program.");
      await host.setDetached({ off: ids });
    } finally {
      this.busy.delete(pid);
      this.changed(true);
    }
  }

  /** Stops reading status files. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The host, started if it isn't (attach and detach act on it; the list only reads it). */
  private ensureHost(): Promise<JavaAgentHost> {
    return this.options.host();
  }

  private jdk(): Promise<JdkSearch> {
    if (this.search) return Promise.resolve(this.search);
    this.searching ??= (this.options.findJdk ?? findJdk)()
      .catch((error: unknown) => ({ passed: [`Looking for a JDK failed: ${(error as Error).message}`] }))
      .then((search) => {
        this.search = search;
        this.searching = undefined;
        return search;
      });
    return this.searching;
  }

  private async list(): Promise<void> {
    const jdk = this.search?.jdk;
    if (!jdk) {
      this.listed = undefined;
      this.listError = undefined;
      return;
    }
    const tool = (this.options.attacher ?? makeAttacher)(jdk.java, this.options.attachJar);
    const listed = await tool.list();
    if (typeof listed === 'string') {
      this.listed = undefined;
      this.listError = listed;
    } else {
      this.listed = listed;
      this.listError = undefined;
      // Notes are about programs: one that's gone takes its note with it.
      const pids = new Set(listed.map((jvm) => jvm.pid));
      for (const pid of this.notes.keys()) if (!pids.has(pid)) this.notes.delete(pid);
    }
  }

  private async readStatuses(): Promise<void> {
    const { live, running, present } = await this.reader.read();
    this.statuses = live;
    this.running = running;
    // Ids of agents whose program ended leave the control file's detached list.
    const host = this.options.running();
    if (host && present) await host.setDetached({ keep: present });
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.readStatuses().then(
        () => this.changed(),
        () => undefined,
      );
    }, this.options.pollMs ?? 2000);
    this.timer.unref();
  }

  /** Tells Setup, if what it shows changed (or `always`). */
  private changed(always = false): void {
    const now = JSON.stringify(this.status() ?? null);
    if (!always && now === this.last) return;
    this.last = now;
    this.options.changed();
  }
}
