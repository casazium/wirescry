import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JavaProgram } from '../../shared/api';
import { parseStatus, type AgentStatus } from './agent-files';
import type { ListedJvm } from './attacher';

/**
 * Which Java programs run Wirescry's agent, from the status files the agents write
 * (`<java-agent>/status/<pid>-<id>.properties`), and which status files are left over.
 *
 * A live agent writes its file at least every 5 s, raising `beat` (Agent.STATUS_EVERY_POLLS). A file
 * whose beat stops is from a program that ended, or one that's stuck: it isn't shown, so a pid a
 * new program reuses isn't taken for the old one with its agent.
 */

/** How long a status file's beat may stand still before it's taken as gone. */
export const STATUS_STALE_MS = 20_000;
/** How long a leftover temporary file, or a damaged status file, stays before it's deleted. */
export const STATUS_DELETE_MS = 120_000;

interface Seen {
  beat: number;
  /** When its beat last moved (or, first seen, the file's time). */
  movedAt: number;
}

export interface StatusReaderOptions {
  now?: () => number;
  /** Whether a process runs: by default process.kill(pid, 0). */
  alive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class StatusReader {
  private readonly seen = new Map<string, Seen>();
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;

  constructor(
    private readonly dir: string,
    options: StatusReaderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? processAlive;
  }

  /**
   * The status files of agents that are alive (`live`), and the ids of every agent whose program
   * still runs (`present`), live or not: one stopped at a debugger's breakpoint stops writing, but
   * must stay detached when it goes on. Deletes the files of agents whose program is gone, and
   * temporary files an agent left behind.
   */
  async read(): Promise<{ live: AgentStatus[]; present: Set<string> | undefined }> {
    const folder = path.join(this.dir, 'status');
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      // No folder yet: no agents. Unreadable: nothing is known, so nothing is taken as gone.
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return { live: [], present: missing ? new Set() : undefined };
    }
    const now = this.now();
    const live: AgentStatus[] = [];
    const present = new Set<string>();
    const keys = new Set<string>();
    for (const name of names) {
      const file = path.join(folder, name);
      const temp = /^(\d{1,18})-[A-Za-z0-9_-]{1,64}\.tmp$/.exec(name);
      if (temp) {
        const info = await stat(file).catch(() => undefined);
        if (info && now - info.mtimeMs > STATUS_DELETE_MS)
          await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      const match = /^(\d{1,18})-([A-Za-z0-9_-]{1,64})\.properties$/.exec(name);
      if (!match) continue;
      const [info, text] = await Promise.all([
        stat(file).catch(() => undefined),
        readFile(file, 'utf8').catch(() => undefined),
      ]);
      if (!info || text === undefined) continue;
      const status = parseStatus(text);
      // The file's name must agree with what it says.
      if (!status || String(status.pid) !== match[1] || status.id !== match[2]) {
        // Half-written ones are replaced whole, so a damaged one that stays is left over.
        if (now - info.mtimeMs > STATUS_DELETE_MS) await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      keys.add(name);
      const before = this.seen.get(name);
      const seen: Seen =
        before && before.beat === status.beat
          ? before
          : // First seen: the file's time says how long ago it was written.
            { beat: status.beat, movedAt: before ? now : Math.min(now, info.mtimeMs) };
      this.seen.set(name, seen);
      if (!this.alive(status.pid)) {
        await rm(file, { force: true }).catch(() => undefined);
        keys.delete(name);
        continue;
      }
      present.add(status.id);
      // A program whose agent stopped writing (stuck, or paused) isn't shown; nor is one a reused
      // pid now names, whose file is the old program's.
      if (now - seen.movedAt <= STATUS_STALE_MS) live.push(status);
    }
    for (const key of this.seen.keys()) if (!keys.has(key)) this.seen.delete(key);
    return { live, present };
  }
}

export interface ProgramsInput {
  /** The attacher's list, or undefined when it couldn't list. */
  listed: ListedJvm[] | undefined;
  /** Live agents (StatusReader.read). */
  statuses: AgentStatus[];
  /** The control file's `config` now: an agent that applied it is up to date. */
  config: number;
  /** This Wirescry's agent version. */
  version: string;
  /** Attached agents Wirescry has turned off. */
  detached: ReadonlySet<string>;
}

/**
 * The Setup page's list: every JVM the attacher lists, and every live agent's program even if it
 * isn't listed (another user's, or one the attacher can't see), by pid. A program with two agents
 * (started with one, then attached) shows the one that runs: the first to start.
 */
export function programsOf(input: ProgramsInput): JavaProgram[] {
  const byPid = new Map<number, JavaProgram>();
  for (const jvm of input.listed ?? []) byPid.set(jvm.pid, { pid: jvm.pid, name: jvm.name });
  // An agent that's on wins over one that's off (a second attach starts nothing: Agent.start).
  const ordered = [...input.statuses].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  for (const status of ordered) {
    const program = byPid.get(status.pid) ?? { pid: status.pid, name: '' };
    if (program.agent) continue;
    program.agent = {
      id: status.id,
      route: status.route,
      on: status.enabled,
      reason: input.detached.has(status.id) && status.reason !== 'detached' ? 'detaching' : status.reason,
      java: status.java,
      current: status.appliedConfig === input.config,
      hooks: status.hooks,
      ...(status.agentVersion !== input.version ? { outdated: true as const } : {}),
    };
    byPid.set(status.pid, program);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}
