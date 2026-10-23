import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as mockttp from 'mockttp';
import type { HandledBy, PluginStatus } from '../shared/api';
import type { BackendPlugin, PluginRule } from '../plugin-api/backend';
import { PLUGIN_API_VERSION } from '../plugin-api/version';
import { MOCKTTP_BUFFER_LIMIT } from './proxy';

const NAME = /^[a-z0-9-]{1,32}$/;
/** Mockttp steps that end a request without a response. */
const SILENT_STEPS = new Set(['close-connection', 'reset-connection', 'timeout']);

export interface PluginHostOptions {
  plugins: BackendPlugin[];
  /** Whether plugins may run at all (licensing). */
  enabled: boolean;
  disabledReason: string;
  /** Leverframe's data folder; each plugin gets `plugins/<name>` inside it. */
  dataDir: string;
  /** Reapplies the proxy's rules, e.g. after a plugin changes its own. */
  refreshRules(): Promise<void>;
  passThroughStep(): mockttp.RequestStep;
  emit(plugin: string, event: string, data: unknown): void;
  /** Called when a plugin's status changes. */
  onStatusChange(): void;
  startTimeoutMs?: number;
}

type State = { state: 'starting' } | { state: 'running' } | { state: 'failed'; reason: string };

/**
 * Runs plugins such as Pro and keeps them apart from each other and from the core: a
 * plugin that fails, hangs or misbehaves is marked as failed and its rules removed.
 */
export class PluginHost {
  private readonly states = new Map<BackendPlugin, State>();
  private readonly rulesByPlugin = new Map<string, mockttp.RequestRuleData[]>();
  private readonly labels = new Map<string, HandledBy>();
  // Rules that end a request without answering (close or time out), by Mockttp rule id.
  private readonly silentRules = new Set<string>();

  constructor(private readonly options: PluginHostOptions) {
    const seen = new Set<string>();
    for (const plugin of options.plugins) {
      let reason: string | undefined;
      if (!NAME.test(plugin.name) || seen.has(plugin.name)) reason = 'Invalid or duplicate plugin name.';
      else if (plugin.apiVersion !== PLUGIN_API_VERSION) {
        reason = `Built for plugin API version ${plugin.apiVersion}; this Leverframe has version ${PLUGIN_API_VERSION}.`;
      } else if (!options.enabled) reason = options.disabledReason;
      seen.add(plugin.name);
      this.states.set(plugin, reason ? { state: 'failed', reason } : { state: 'starting' });
    }
  }

  /** Every running plugin's rules, in plugin order, ready for the proxy. */
  rules(): mockttp.RequestRuleData[] {
    return this.options.plugins.flatMap((p) => this.rulesByPlugin.get(p.name) ?? []);
  }

  /** Whether a rule closes the connection or never answers, rather than responding. */
  endsWithoutResponse(ruleId: string | undefined): boolean {
    return ruleId !== undefined && this.silentRules.has(ruleId);
  }

  /** Which plugin rule a Mockttp rule id belongs to, if any. */
  describeRule(ruleId: string | undefined): HandledBy | undefined {
    return ruleId === undefined ? undefined : this.labels.get(ruleId);
  }

  statuses(): PluginStatus[] {
    return this.options.plugins.map((plugin) => {
      const { name } = plugin;
      const state = this.states.get(plugin)!;
      if (state.state === 'running') return { name, active: true };
      return { name, active: false, reason: state.state === 'starting' ? 'Starting…' : state.reason };
    });
  }

  async startAll(): Promise<void> {
    const timeoutMs = this.options.startTimeoutMs ?? 10_000;
    for (const plugin of this.options.plugins) {
      if (this.states.get(plugin)?.state !== 'starting') continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let starting: Promise<void> | undefined;
      let timedOut = false;
      try {
        const dataDir = path.join(this.options.dataDir, 'plugins', plugin.name);
        await mkdir(dataDir, { recursive: true });
        starting = (async () =>
          plugin.start({
            dataDir,
            setProxyRules: (rules) => this.setRules(plugin, rules),
            passThroughStep: () => this.options.passThroughStep(),
            maxBufferedRequestBody: MOCKTTP_BUFFER_LIMIT,
            emit: (event, data) => {
              if (this.isRunning(plugin)) this.options.emit(plugin.name, event, data);
            },
            log: (message) =>
              // eslint-disable-next-line no-control-regex -- stripping control characters is the point
              console.log(`[${plugin.name}] ${String(message).replace(/[\x00-\x1f\x7f]/g, ' ')}`),
          }))();
        await Promise.race([
          starting,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`didn't finish starting within ${timeoutMs / 1000} s`));
            }, timeoutMs);
          }),
        ]);
        // It may have been marked failed meanwhile, by the timeout.
        if (this.states.get(plugin)?.state === 'starting') this.states.set(plugin, { state: 'running' });
      } catch (error) {
        await this.fail(plugin, `Couldn't start: ${(error as Error).message}`);
        // A plugin that finishes starting after the deadline still gets stopped, so it
        // doesn't leave watchers or handles open.
        if (timedOut) {
          void starting
            ?.then(async () => plugin.stop?.())
            .catch((stopError: unknown) => console.error(`[leverframe] plugin ${plugin.name}:`, stopError));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    this.options.onStatusChange();
  }

  async call(name: string, callName: string, args: unknown): Promise<unknown> {
    if (typeof name !== 'string' || typeof callName !== 'string' || callName.length > 100) {
      throw new Error('Invalid plugin call.');
    }
    const plugin = this.options.plugins.find((p) => p.name === name);
    if (!plugin) throw new Error(`No plugin called ${name}`);
    const state = this.states.get(plugin)!;
    if (state.state === 'failed') throw new Error(state.reason);
    if (state.state === 'starting') throw new Error(`${name} is still starting.`);
    return plugin.handle(callName, args);
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.options.plugins) {
      if (!this.isRunning(plugin)) continue;
      // An async wrapper catches synchronous throws too.
      await (async () => plugin.stop?.())().catch((error: unknown) => {
        console.error(`[leverframe] plugin ${plugin.name} failed to stop:`, error);
      });
    }
  }

  private isRunning(plugin: BackendPlugin): boolean {
    const state = this.states.get(plugin)?.state;
    return state === 'running' || state === 'starting';
  }

  private async setRules(plugin: BackendPlugin, rules: PluginRule[]): Promise<void> {
    if (!this.isRunning(plugin)) return; // A failed plugin can't add rules back.
    const { name } = plugin;
    const data: mockttp.RequestRuleData[] = [];
    const labels = new Map<string, HandledBy>();
    const silent = new Set<string>();
    for (const [i, rule] of rules.entries()) {
      if (
        !rule ||
        !Array.isArray(rule.matchers) ||
        rule.matchers.length === 0 ||
        !Array.isArray(rule.steps) ||
        rule.steps.length === 0
      ) {
        throw new Error(`Rule ${i + 1} needs at least one matcher and one step.`);
      }
      const ruleId = String(rule.id ?? i);
      const id = `${name}/${ruleId}`;
      if (labels.has(id)) throw new Error(`Duplicate rule id ${ruleId}.`);
      labels.set(id, { plugin: name, ruleId, label: String(rule.label ?? ruleId).slice(0, 200) });
      // Only these fields: in particular no `priority`, which could put a plugin rule
      // ahead of Leverframe's own setup page.
      data.push({ id, matchers: rule.matchers, steps: rule.steps });
      const last = rule.steps[rule.steps.length - 1] as { type?: string } | undefined;
      if (last?.type && SILENT_STEPS.has(last.type)) silent.add(id);
    }
    for (const key of [...this.labels.keys()]) if (key.startsWith(`${name}/`)) this.labels.delete(key);
    for (const [key, value] of labels) this.labels.set(key, value);
    for (const key of [...this.silentRules]) if (key.startsWith(`${name}/`)) this.silentRules.delete(key);
    for (const key of silent) this.silentRules.add(key);
    this.rulesByPlugin.set(name, data);
    await this.options.refreshRules();
  }

  private async fail(plugin: BackendPlugin, reason: string): Promise<void> {
    const { name } = plugin;
    console.error(`[leverframe] plugin ${name}: ${reason}`);
    this.states.set(plugin, { state: 'failed', reason });
    this.rulesByPlugin.delete(name);
    for (const key of [...this.labels.keys()]) if (key.startsWith(`${name}/`)) this.labels.delete(key);
    await this.options.refreshRules().catch(() => undefined);
  }
}
