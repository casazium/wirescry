import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as mockttp from 'mockttp';
import type {
  BodyContent,
  BodyRange,
  BodySide,
  ExchangeAnnotation,
  ExchangeDetail,
  ExchangeSummary,
  HandledBy,
  PluginStatus,
} from '../shared/api';
import type {
  BackendPlugin,
  PassThroughTransforms,
  PluginRule,
  UpstreamTargetResult,
} from '../plugin-api/backend';
import { PLUGIN_API_VERSION } from '../plugin-api/version';
import { MOCKTTP_BUFFER_LIMIT } from './proxy';
import { createSecureStore, type Encryptor } from './secure-store';

const NAME = /^[a-z0-9-]{1,32}$/;
const TONES = new Set(['ok', 'warn', 'info']);
// Characters that could disguise the request's path beside a badge, or break its line:
// control characters, line and paragraph separators, bidi controls, and invisible spaces
// and marks. Joiners (U+200C, U+200D), which emoji and many scripts need, are fine.
const UNSAFE_TEXT =
  /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, 'gu');
/** Characters as people count them (code points), not UTF-16 units. */
const length = (text: string): number => [...text].length;

/** Checks a badge from a plugin, and returns a clean copy. */
export function validateAnnotation(annotation: unknown): ExchangeAnnotation {
  if (!annotation || typeof annotation !== 'object') throw new Error('An annotation must be an object.');
  // Each field read once, so a getter can't pass the checks and then return something else.
  const { label, tone, title } = annotation as Partial<Record<keyof ExchangeAnnotation, unknown>>;
  if (typeof label !== 'string' || label.trim() === '' || length(label) > 16 || UNSAFE_TEXT.test(label)) {
    throw new Error(
      'An annotation label must be 1 to 16 characters, without control characters, bidi controls or invisible spaces.',
    );
  }
  if (typeof tone !== 'string' || !TONES.has(tone)) {
    throw new Error("An annotation's tone must be ok, warn or info.");
  }
  if (title !== undefined && typeof title !== 'string') throw new Error('An annotation title must be text.');
  // A title is shown only on hover and read out: tidied rather than refused, so a stray
  // newline from a spec or a request doesn't lose the badge.
  const cleanTitle =
    typeof title === 'string'
      ? [...title.replace(UNSAFE_TEXT_ALL, ' ').replace(/\s+/g, ' ').trim()].slice(0, 200).join('')
      : '';
  return {
    label,
    tone: tone as ExchangeAnnotation['tone'],
    ...(cleanTitle ? { title: cleanTitle } : {}),
  };
}
/** Mockttp steps that end a request without a response. */
const SILENT_STEPS = new Set(['close-connection', 'reset-connection', 'timeout']);

export interface PluginHostOptions {
  plugins: BackendPlugin[];
  /** Whether plugins may run at all (licensing). */
  enabled: boolean;
  disabledReason: string;
  /** Wirescry's data folder; each plugin gets `plugins/<name>` inside it. */
  dataDir: string;
  /** Encrypts plugins' secure stores; undefined where the OS has no keychain to use. */
  encryptor?: Encryptor;
  /** This Wirescry's version and build date, passed to plugins. */
  app: { version: string; releaseDate: string };
  /** Reapplies the proxy's rules, e.g. after a plugin changes its own. */
  refreshRules(): Promise<void>;
  passThroughStep(transforms?: PassThroughTransforms): mockttp.RequestStep;
  emit(plugin: string, event: string, data: unknown): void;
  /** Called when a plugin's status changes. */
  onStatusChange(): void;
  getExchange(exchangeId: string): ExchangeDetail | undefined;
  getBody(exchangeId: string, side: BodySide): Promise<BodyContent | null>;
  readBody(exchangeId: string, side: BodySide, offset: number, maxBytes: number): Promise<BodyRange | null>;
  upstreamTarget(exchangeId: string): UpstreamTargetResult | null;
  /** Sets or removes a plugin's badge on an exchange (already validated). */
  annotate(plugin: string, exchangeId: string, annotation: ExchangeAnnotation | undefined): void;
  /** Removes all of a plugin's badges, e.g. when it fails. */
  clearAnnotations(plugin: string): void;
  startTimeoutMs?: number;
  /** How long one call from the UI may take; a plugin that never answers mustn't hang the UI. */
  callTimeoutMs?: number;
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
  // How often each plugin's exchangeCompleted has failed, to keep the log readable.
  private readonly completionErrors = new Map<string, number>();

  constructor(private readonly options: PluginHostOptions) {
    const seen = new Set<string>();
    for (const plugin of options.plugins) {
      let reason: string | undefined;
      if (!NAME.test(plugin.name) || seen.has(plugin.name)) reason = 'Invalid or duplicate plugin name.';
      else if (plugin.apiVersion !== PLUGIN_API_VERSION) {
        reason = `Built for plugin API version ${plugin.apiVersion}; this Wirescry has version ${PLUGIN_API_VERSION}.`;
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
        const log = (message: string): void =>
          // eslint-disable-next-line no-control-regex -- stripping control characters is the point
          console.log(`[${plugin.name}] ${String(message).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
        starting = (async () =>
          plugin.start({
            dataDir,
            app: { ...this.options.app },
            secureStore: createSecureStore(dataDir, this.options.encryptor, log),
            setProxyRules: (rules) => this.setRules(plugin, rules),
            passThroughStep: (transforms) => this.options.passThroughStep(transforms),
            maxBufferedRequestBody: MOCKTTP_BUFFER_LIMIT,
            emit: (event, data) => {
              if (this.isRunning(plugin)) this.options.emit(plugin.name, event, data);
            },
            // Copies, so a plugin can't change what the rest of Wirescry sees.
            getExchange: (exchangeId) => {
              if (!this.hasStarted(plugin)) return undefined;
              const detail = this.options.getExchange(String(exchangeId));
              return detail ? structuredClone(detail) : undefined;
            },
            getBody: async (exchangeId, side) => {
              if (side !== 'request' && side !== 'response')
                throw new Error('side must be request or response');
              if (!this.hasStarted(plugin)) return null;
              return this.options.getBody(String(exchangeId), side);
            },
            readBody: async (exchangeId, side, range) => {
              if (side !== 'request' && side !== 'response')
                throw new Error('side must be request or response');
              const { offset, maxBytes } = (range ?? {}) as { offset?: unknown; maxBytes?: unknown };
              if (typeof offset !== 'number' || typeof maxBytes !== 'number')
                throw new Error('offset and maxBytes must be numbers');
              if (!this.hasStarted(plugin)) return null;
              return this.options.readBody(String(exchangeId), side, offset, maxBytes);
            },
            upstreamTarget: (exchangeId) => {
              if (!this.hasStarted(plugin)) return null;
              // Made afresh for each call, so a plugin can't change what the next one gets.
              return this.options.upstreamTarget(String(exchangeId));
            },
            annotate: (exchangeId, annotation) => {
              if (!this.hasStarted(plugin)) return;
              const clean = annotation === undefined ? undefined : validateAnnotation(annotation);
              this.options.annotate(plugin.name, String(exchangeId), clean);
            },
            log,
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
            .catch((stopError: unknown) => console.error(`[wirescry] plugin ${plugin.name}:`, stopError));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    this.options.onStatusChange();
  }

  /** Tells running plugins an exchange has finished. Their errors are logged, never thrown. */
  exchangeCompleted(summary: ExchangeSummary): void {
    for (const plugin of this.options.plugins) {
      // Only once it has finished starting, and never once it has stopped.
      if (!plugin.exchangeCompleted || !this.hasStarted(plugin)) continue;
      const report = (error: unknown): void => {
        // A plugin failing on every exchange mustn't flood the log: the first few, then now and then.
        const count = (this.completionErrors.get(plugin.name) ?? 0) + 1;
        this.completionErrors.set(plugin.name, count);
        if (count <= 5 || count % 1000 === 0) {
          console.error(`[wirescry] plugin ${plugin.name} exchangeCompleted (error ${count}):`, error);
        }
      };
      try {
        const result: unknown = plugin.exchangeCompleted(structuredClone(summary));
        if (result instanceof Promise) result.catch(report);
      } catch (error) {
        report(error);
      }
    }
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
    const timeoutMs = this.options.callTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        plugin.handle(callName, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name} took too long to answer ${callName}.`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.options.plugins) {
      if (!this.isRunning(plugin)) continue;
      // From now on it hears and does nothing more: no completions, badges or body reads.
      this.states.set(plugin, { state: 'failed', reason: 'Stopped.' });
      // An async wrapper catches synchronous throws too.
      await (async () => plugin.stop?.())().catch((error: unknown) => {
        console.error(`[wirescry] plugin ${plugin.name} failed to stop:`, error);
      });
    }
  }

  /** Finished starting, and not stopped: what reading and badging exchanges need. */
  private hasStarted(plugin: BackendPlugin): boolean {
    return this.states.get(plugin)?.state === 'running';
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
      // ahead of Wirescry's own setup page.
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
    console.error(`[wirescry] plugin ${name}: ${reason}`);
    this.states.set(plugin, { state: 'failed', reason });
    this.rulesByPlugin.delete(name);
    for (const key of [...this.labels.keys()]) if (key.startsWith(`${name}/`)) this.labels.delete(key);
    this.options.clearAnnotations(name);
    await this.options.refreshRules().catch(() => undefined);
  }
}
