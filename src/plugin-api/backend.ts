/**
 * What a backend plugin (such as Wirescry Pro) can do. This file is part of the
 * open-source app; plugins import its types. Keep it small and stable, and bump
 * PLUGIN_API_VERSION (./version.ts) for breaking changes.
 */
import type { RequestRuleData, RequestStep, requestSteps } from 'mockttp';
import type {
  BodyContent,
  BodySide,
  ExchangeAnnotation,
  ExchangeDetail,
  ExchangeSummary,
} from '../shared/api';

export type { BodyContent, BodySide, ExchangeAnnotation, ExchangeDetail, ExchangeSummary };

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
  /** A recorded exchange's details (headers, timing, body sizes), or undefined once it's gone. */
  getExchange(exchangeId: string): ExchangeDetail | undefined;
  /**
   * A body as the UI sees it: decoded where Wirescry can, and cut short past a size limit
   * (`truncated`). Null if there's none, or the exchange is gone.
   */
  getBody(exchangeId: string, side: BodySide): Promise<BodyContent | null>;
  /**
   * Puts this plugin's badge on an exchange, replacing its previous one, or removes it
   * (undefined). Ignored for an exchange that's gone. Throws if the badge isn't valid.
   */
  annotate(exchangeId: string, annotation: ExchangeAnnotation | undefined): void;
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
  /**
   * Called once for each HTTP exchange when it has finished: its response recorded (body
   * included), or failed. Not for WebSockets, and not while the plugin is still starting.
   * Includes exchanges imported from HAR files, which can be thousands at once: don't block,
   * do slow work asynchronously, and read only a few bodies at a time. If a body takes over
   * 10 s to be stored, this is called without it (getBody returns null). Errors are logged
   * and otherwise ignored.
   */
  exchangeCompleted?(exchange: ExchangeSummary): void;
  stop?(): Promise<void> | void;
}
