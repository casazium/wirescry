/**
 * What a backend plugin (such as Leverframe Pro) can do. This file is part of the
 * open-source app; plugins import its types. Keep it small and stable, and bump
 * PLUGIN_API_VERSION (./version.ts) for breaking changes.
 */
import type { RequestRuleData, RequestStep } from 'mockttp';

/** A proxy rule from a plugin. `id` should be stable; `label` names it in the traffic list. */
export interface PluginRule extends Pick<RequestRuleData, 'matchers' | 'steps'> {
  id: string;
  label: string;
}

export interface BackendPluginHost {
  /** A folder for this plugin's own files, inside Leverframe's data folder. */
  dataDir: string;
  /**
   * Replaces this plugin's proxy rules. They run in order, after Leverframe's own setup
   * page and before its normal pass-through, so the first matching rule handles the request.
   */
  setProxyRules(rules: PluginRule[]): Promise<void>;
  /**
   * A step that passes the request on to the real server with Leverframe's own
   * settings (trusted CAs, and later upstream proxies). Use it instead of building one.
   */
  passThroughStep(): RequestStep;
  /**
   * The most request body, in bytes, that the proxy buffers. A matcher must not read a
   * longer body (or one without a Content-Length): the read stops at this size and the
   * request would then be passed on without its body.
   */
  maxBufferedRequestBody: number;
  /** Sends an event to this plugin's UI. */
  emit(event: string, data: unknown): void;
  /** Writes to Leverframe's log. */
  log(message: string): void;
}

export interface BackendPlugin {
  /** Unique name, shared with the plugin's UI half: lowercase letters, digits and hyphens. */
  name: string;
  /** The PLUGIN_API_VERSION this plugin was built against. */
  apiVersion: number;
  /** Called once. Rejecting, or taking too long, marks the plugin as failed. */
  start(host: BackendPluginHost): Promise<void> | void;
  /**
   * Handles a call from the plugin's UI. `args` comes from the UI and must be validated.
   * Throw to send an error back.
   */
  handle(name: string, args: unknown): Promise<unknown>;
  stop?(): Promise<void> | void;
}
