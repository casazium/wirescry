/**
 * What a backend plugin (such as Leverframe Pro) can do. This file is part of the
 * open-source app; plugins import its types. Keep it small and stable.
 */
import type { RequestRuleData } from 'mockttp';

export interface BackendPluginHost {
  /** A folder for this plugin's own files, inside Leverframe's data folder. */
  dataDir: string;
  /**
   * Replaces this plugin's proxy rules. They run in order, before Leverframe's
   * normal pass-through, so the first matching rule handles the request.
   */
  setProxyRules(rules: RequestRuleData[]): Promise<void>;
  /** Sends an event to this plugin's UI. */
  emit(event: string, data: unknown): void;
  /** Writes to Leverframe's log. */
  log(message: string): void;
}

export interface BackendPlugin {
  /** Unique name, shared with the plugin's UI half. */
  name: string;
  start(host: BackendPluginHost): Promise<void> | void;
  /** Handles a call from the plugin's UI. Throw to send an error back. */
  handle(name: string, args: unknown): Promise<unknown>;
  stop?(): Promise<void> | void;
}
