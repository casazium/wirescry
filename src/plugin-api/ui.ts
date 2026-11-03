/**
 * What a UI plugin (such as Wirescry Pro) can do. Part of the open-source app;
 * plugins import these types.
 */
import type { ComponentType } from 'react';
import type { BodyContent, BodySide, ExchangeDetail, ExchangeSummary } from '../shared/api';
import type { ChooseFilePathResult, OpenTextFileResult, SaveTextFileResult } from '../shared/ipc';

export type { BodyContent, BodySide, ExchangeDetail, ExchangeSummary };

export interface UiPluginApi {
  /** Calls the plugin's backend half. */
  call(name: string, args?: unknown): Promise<unknown>;
  /** Listens for events from the plugin's backend half. Returns a function that stops listening. */
  on(event: string, listener: (data: unknown) => void): () => void;
  /**
   * Asks where to save `text` in a system dialog, then saves it. Resolves with the file
   * name, or nothing if the user canceled. Up to 16 MB.
   */
  saveFile(options: { text: string; defaultName: string; extensions: string[] }): Promise<SaveTextFileResult>;
  /** Asks the user to pick a file, then resolves with its name and text (or nothing). Up to 16 MB. */
  openFile(options: { extensions: string[] }): Promise<OpenTextFileResult>;
  /**
   * Asks the user to pick a file, then resolves with its full path (or nothing), without
   * reading it. For settings that point at a file, such as a rule's reply file.
   */
  chooseFile(options?: { extensions?: string[] }): Promise<ChooseFilePathResult>;
  /**
   * Shows a short badge on one of this plugin's tabs, or clears it with undefined. By
   * default it's a count of things waiting (read out as "3 waiting"), for what needs
   * attention while the tab isn't open. With `tag`, it's a quiet label instead, such as
   * "PRO" on a locked feature, read out as `label` (or the text).
   */
  setBadge(viewId: string, text: string | undefined, options?: BadgeOptions): void;
  /** Switches the window to one of this plugin's tabs. */
  showView(viewId: string): void;
  /** A captured exchange's headers and timing. Rejects if it's no longer in the list. */
  getExchange(exchangeId: string): Promise<ExchangeDetail>;
  /**
   * One body of a captured exchange, decoded where possible, or null if it has none.
   * Large bodies are cut short (`truncated`). Rejects if the exchange is no longer in the list.
   */
  getBody(exchangeId: string, side: BodySide): Promise<BodyContent | null>;
}

/**
 * Something a plugin offers to do with a captured exchange, such as "Mock…". It's shown
 * in the exchange's details and in the right-click menu on its row in the traffic list.
 */
export interface UiExchangeAction {
  id: string;
  /** Short, e.g. "Mock…" (with an ellipsis when it opens something to finish first). */
  label: string;
  /** Whether to offer it for this exchange. Offered for every exchange if left out. */
  appliesTo?(exchange: ExchangeSummary): boolean;
  /** Runs it. A rejected promise's message is shown to the user. */
  run(exchange: ExchangeSummary, api: UiPluginApi): void | Promise<void>;
}

export interface UiPluginView {
  id: string;
  /** Shown as a tab in the toolbar, next to Traffic and Setup. */
  label: string;
  component: ComponentType<{ api: UiPluginApi }>;
}

export interface UiPlugin {
  /** Must match the backend plugin's name. */
  name: string;
  /** The PLUGIN_API_VERSION this plugin was built against. */
  apiVersion: number;
  views: UiPluginView[];
  /** Actions on a captured exchange, offered in the order given. */
  exchangeActions?: UiExchangeAction[];
}

/** How a tab badge looks and is read out; see UiPluginApi.setBadge. */
export interface BadgeOptions {
  /** A label rather than a count: outlined, not filled, and not read as "waiting". */
  tag?: boolean;
  /** What screen readers say for it, e.g. "Wirescry Pro feature". */
  label?: string;
}
