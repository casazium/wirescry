/**
 * What a backend plugin (such as Wirescry Pro) can do. This file is part of the
 * open-source app; plugins import its types. Keep it small and stable, and bump
 * PLUGIN_API_VERSION (./version.ts) for breaking changes.
 */
import type { RequestRuleData, RequestStep, requestSteps } from 'mockttp';

/** A proxy rule from a plugin. `id` should be stable; `label` names it in the traffic list. */
export interface PluginRule extends Pick<RequestRuleData, 'matchers' | 'steps'> {
  id: string;
  label: string;
}

/**
 * Changes a plugin's pass-through step may make, as Mockttp's PassThroughStep options
 * of the same names. Use either the transforms or the callbacks, not both.
 *
 * `beforeRequest` only sees request bodies up to maxBufferedRequestBody; a longer one
 * reads as empty, so don't replace or re-measure it (keep Content-Length as sent).
 * `beforeResponse` makes Mockttp hold the whole response in memory, with no size limit,
 * so only use it for responses a user asked to stop.
 */
export type PassThroughTransforms = Pick<
  requestSteps.PassThroughStepOptions,
  'transformRequest' | 'transformResponse' | 'beforeRequest' | 'beforeResponse'
>;

/** A value read from a plugin's secure store. */
export interface SecureValue {
  value: unknown;
  /**
   * Whether it was stored encrypted with the OS keychain. A plain value could have been
   * written by anyone who can edit the file, so don't trust it for anything that matters.
   */
  encrypted: boolean;
}

/**
 * One small JSON value per plugin (up to 1 MB), encrypted with the OS keychain where
 * there is one, so it can't be edited on disk. Where there isn't (some Linux setups),
 * it's stored as plain JSON and `encrypted` is false.
 */
export interface PluginSecureStore {
  /** Whether set() encrypts on this computer. */
  readonly encrypted: boolean;
  /**
   * The saved value, or undefined if there's none. Rejects if there is one but it can't be
   * read or decrypted (a reset or locked keychain, for example): the plugin decides what
   * that means, rather than mistaking it for nothing saved.
   */
  get(): Promise<SecureValue | undefined>;
  set(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

export interface BackendPluginHost {
  /** A folder for this plugin's own files, inside Wirescry's data folder. */
  dataDir: string;
  /** This Wirescry: its version, and when this build was made (ISO 8601). */
  app: { version: string; releaseDate: string };
  /** Encrypted storage for this plugin. */
  secureStore: PluginSecureStore;
  /**
   * Replaces this plugin's proxy rules. They run in order, after Wirescry's own setup
   * page and before its normal pass-through, so the first matching rule handles the request.
   */
  setProxyRules(rules: PluginRule[]): Promise<void>;
  /**
   * A step that passes the request on to the real server with Wirescry's own
   * settings (trusted CAs, and later upstream proxies). Use it instead of building one.
   * `transforms` can send it elsewhere or change it on the way, as Mockttp's
   * PassThroughStep options of the same names.
   */
  passThroughStep(transforms?: PassThroughTransforms): RequestStep;
  /**
   * The most request body, in bytes, that the proxy buffers. A matcher must not read a
   * longer body (or one without a Content-Length): the read stops at this size and the
   * request would then be passed on without its body.
   */
  maxBufferedRequestBody: number;
  /** Sends an event to this plugin's UI. */
  emit(event: string, data: unknown): void;
  /** Writes to Wirescry's log. */
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
