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
  McpReadTool,
  PassThroughTransforms,
  PluginRule,
  UpstreamTargetResult,
} from '../plugin-api/backend';
import { PLUGIN_API_VERSION } from '../plugin-api/version';
import { INVISIBLE } from '../shared/visible';
import { ResultError } from './mcp/plugin-result';
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
const TOOL_NAME = /^[a-z][a-z0-9_]{1,39}$/;
export const MAX_PLUGIN_TOOLS = 32;
const MAX_SCHEMA_BYTES = 64 * 1024;
/** All of one plugin's schemas together: they're sent with each list of tools. */
export const MAX_SCHEMAS_BYTES = 256 * 1024;
/** One plugin's MCP reads at once, counted until each really ends, even if the agent has gone. */
export const MAX_TOOL_READS = 8;
// Characters that can spell out hidden text, one per letter or byte: the tag characters and
// supplementary variation selectors (U+E0000 to U+E0FFF), the variation selectors, and the
// Mongolian ones. Dropped from a tool's title and description; every other INVISIBLE character
// (bidi controls, zero-width spaces, separators, controls, unassigned), tab and newline become a
// space.
const CARRIERS_ALL = /[\u{E0000}-\u{E0FFF}]|[\uFE00-\uFE0F]|[\u180B-\u180D]|\u180F/gu;
const UNSEEN_OR_BREAK_ALL = new RegExp(`[\\t\\n]|${INVISIBLE.source}`, 'gu');

/** Whether any key or string in a parsed JSON value holds an INVISIBLE character. */
function holdsInvisible(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') {
      if (INVISIBLE.test(next)) return true;
    } else if (next && typeof next === 'object') {
      for (const [key, item] of Object.entries(next)) {
        if (INVISIBLE.test(key)) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

/** A plugin's MCP tool as the host keeps it: checked, copied, and its plugin's name. */
export interface PluginTool {
  plugin: string;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  contains: 'traffic' | 'rules';
}

type HeldTool = PluginTool & { read: McpReadTool['read'] };

/**
 * Checks a plugin's MCP tools and returns clean copies. Throws on the first problem. `taken` holds
 * names the app or another plugin already uses.
 */
export function validateTools(plugin: string, tools: unknown, taken: ReadonlySet<string>): HeldTool[] {
  if (!Array.isArray(tools)) throw new Error('MCP tools must be a list.');
  if (tools.length > MAX_PLUGIN_TOOLS) throw new Error(`At most ${MAX_PLUGIN_TOOLS} MCP tools.`);
  const names = new Set<string>();
  let schemaBytes = 0;
  return tools.map((tool: unknown, i) => {
    if (!tool || typeof tool !== 'object') throw new Error(`MCP tool ${i + 1} must be an object.`);
    // Each field read once, so a getter can't pass the checks and then return something else.
    const { name, title, description, inputSchema, contains, read, kind } = tool as Partial<
      Record<keyof McpReadTool | 'kind', unknown>
    >;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      throw new Error(
        `MCP tool ${i + 1}'s name must be 2 to 40 lowercase letters, digits and underscores, starting with a letter.`,
      );
    }
    if (taken.has(name) || names.has(name)) throw new Error(`The MCP tool name ${name} is taken.`);
    // A newer kind of tool mustn't be offered here as a read-only one.
    if (kind !== undefined && kind !== 'read') throw new Error('This Wirescry only takes read tools.');
    names.add(name);
    const text = (value: unknown, max: number, what: string): string => {
      const clean =
        typeof value === 'string' ? value.replace(CARRIERS_ALL, '').replace(UNSEEN_OR_BREAK_ALL, ' ') : '';
      if (clean.trim() === '' || length(clean) > max) {
        throw new Error(`MCP tool ${name}'s ${what} must be 1 to ${max} characters.`);
      }
      return clean;
    };
    const cleanTitle = text(title, 100, 'title');
    const cleanDescription = text(description, 2000, 'description');
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new Error(`MCP tool ${name}'s inputSchema must be a JSON Schema object.`);
    }
    let schema: Record<string, unknown>;
    try {
      const json = JSON.stringify(inputSchema);
      const bytes = Buffer.byteLength(json);
      schemaBytes += bytes;
      if (bytes > MAX_SCHEMA_BYTES || schemaBytes > MAX_SCHEMAS_BYTES) throw new Error('not allowed');
      schema = JSON.parse(json) as Record<string, unknown>;
      // Checked parsed, not as JSON, where a control or lone surrogate is already an escape that
      // a client decodes.
      if (holdsInvisible(schema)) throw new Error('not allowed');
    } catch {
      throw new Error(
        `MCP tool ${name}'s inputSchema must be JSON without hidden characters, at most 64 KB (256 KB for all of a plugin's).`,
      );
    }
    if (schema.type !== 'object') throw new Error(`MCP tool ${name}'s inputSchema must have type: 'object'.`);
    if (contains !== undefined && contains !== 'traffic' && contains !== 'rules') {
      throw new Error(`MCP tool ${name}'s contains must be traffic or rules.`);
    }
    if (typeof read !== 'function') throw new Error(`MCP tool ${name} needs a read function.`);
    return {
      plugin,
      name,
      title: cleanTitle,
      description: cleanDescription,
      inputSchema: schema,
      contains: (contains ?? 'traffic') as 'traffic' | 'rules',
      read: read as McpReadTool['read'],
    };
  });
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
  /** MCP tool names the app itself uses (and keeps for later): no plugin may take them. */
  reservedToolNames?: readonly string[];
  /** How long a plugin's MCP tool may take to answer. */
  toolTimeoutMs?: number;
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
  // Each plugin's MCP tools, checked, by plugin name.
  private readonly toolsByPlugin = new Map<string, HeldTool[]>();
  // Each plugin's MCP calls in progress, to end when it stops.
  private readonly liveCalls = new Map<string, Set<AbortController>>();
  // Each plugin's reads that haven't ended yet.
  private readonly toolReads = new Map<string, number>();

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
            mcp: {
              version: 1,
              setTools: (tools) => this.setTools(plugin, tools),
            },
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

  /** Started plugins' MCP tools, in plugin order. */
  tools(): PluginTool[] {
    return this.options.plugins.flatMap((plugin) =>
      this.hasStarted(plugin)
        ? (this.toolsByPlugin.get(plugin.name) ?? []).map((tool) => ({
            plugin: tool.plugin,
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
            contains: tool.contains,
          }))
        : [],
    );
  }

  /**
   * Runs a plugin's MCP tool and returns a copy of its result. Rejects if that started plugin has
   * no such tool, if it throws, if it takes too long, if the agent gives up, or if the plugin stops
   * first. The tool's signal is aborted in the last three.
   */
  async callTool(pluginName: string, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const plugin = this.options.plugins.find((p) => p.name === pluginName);
    const tool =
      plugin && this.hasStarted(plugin)
        ? this.toolsByPlugin.get(plugin.name)?.find((t) => t.name === name)
        : undefined;
    if (!plugin || !tool) throw new Error(`No tool called ${name}.`);
    if ((this.toolReads.get(plugin.name) ?? 0) >= MAX_TOOL_READS) {
      throw new Error(`${name} is busy. Try again shortly.`);
    }
    const timeoutMs = this.options.toolTimeoutMs ?? 10_000;
    const call = new AbortController();
    const ended = new Promise<never>((_, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error(String(call.signal.reason))), {
        once: true,
      });
    });
    const cancelled = (): void => call.abort('The call was cancelled.');
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    const live = this.liveCalls.get(plugin.name) ?? new Set<AbortController>();
    this.liveCalls.set(plugin.name, live);
    live.add(call);
    const timer = setTimeout(() => call.abort(`${name} took too long to answer.`), timeoutMs);
    try {
      const result = await Promise.race([
        ended,
        // A copy of the arguments, so the plugin can't change what the server holds.
        (async () => {
          if (call.signal.aborted) return undefined;
          this.toolReads.set(plugin.name, (this.toolReads.get(plugin.name) ?? 0) + 1);
          try {
            return await tool.read(structuredClone(args), { signal: call.signal });
          } finally {
            this.toolReads.set(plugin.name, this.toolReads.get(plugin.name)! - 1);
          }
        })(),
      ]);
      if (call.signal.aborted) throw new Error(String(call.signal.reason));
      try {
        // A copy now, so the plugin can't change it while it's masked; getters are read once.
        return structuredClone(result);
      } catch {
        // Its own message would quote the plugin's code.
        throw new ResultError('The result isn’t plain JSON.');
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      live.delete(call);
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.options.plugins) {
      if (!this.isRunning(plugin)) continue;
      // From now on it hears and does nothing more: no completions, badges or body reads.
      this.states.set(plugin, { state: 'failed', reason: 'Stopped.' });
      this.toolsByPlugin.delete(plugin.name);
      this.endCalls(plugin.name);
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

  /** Ends a plugin's MCP calls in progress: their answers won't be used. */
  private endCalls(name: string): void {
    for (const call of this.liveCalls.get(name) ?? []) call.abort(`${name} stopped.`);
    this.liveCalls.delete(name);
  }

  private setTools(plugin: BackendPlugin, tools: unknown): void {
    if (!this.isRunning(plugin)) return; // A failed or stopped plugin can't add tools back.
    const taken = new Set(this.options.reservedToolNames ?? []);
    for (const other of this.options.plugins) {
      // A plugin that failed or stopped has no tools here, so it holds no names.
      if (other === plugin) continue;
      for (const tool of this.toolsByPlugin.get(other.name) ?? []) taken.add(tool.name);
    }
    this.toolsByPlugin.set(plugin.name, validateTools(plugin.name, tools, taken));
  }

  private async fail(plugin: BackendPlugin, reason: string): Promise<void> {
    const { name } = plugin;
    console.error(`[wirescry] plugin ${name}: ${reason}`);
    this.states.set(plugin, { state: 'failed', reason });
    this.toolsByPlugin.delete(name);
    this.endCalls(name);
    this.rulesByPlugin.delete(name);
    for (const key of [...this.labels.keys()]) if (key.startsWith(`${name}/`)) this.labels.delete(key);
    this.options.clearAnnotations(name);
    await this.options.refreshRules().catch(() => undefined);
  }
}
