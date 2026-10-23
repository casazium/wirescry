/**
 * What a UI plugin (such as Wirescry Pro) can do. Part of the open-source app;
 * plugins import these types.
 */
import type { ComponentType } from 'react';
import type { OpenTextFileResult, SaveTextFileResult } from '../shared/ipc';

export interface UiPluginApi {
  /** Calls the plugin's backend half. */
  call(name: string, args?: unknown): Promise<unknown>;
  /** Listens for events from the plugin's backend half. Returns a function that stops listening. */
  on(event: string, listener: (data: unknown) => void): () => void;
  /**
   * Asks where to save `text` in a system dialog, then saves it. Resolves with the file
   * name, or nothing if the user cancelled. Up to 16 MB.
   */
  saveFile(options: { text: string; defaultName: string; extensions: string[] }): Promise<SaveTextFileResult>;
  /** Asks the user to pick a file, then resolves with its name and text (or nothing). Up to 16 MB. */
  openFile(options: { extensions: string[] }): Promise<OpenTextFileResult>;
  /**
   * Shows a short badge (e.g. a count) on one of this plugin's tabs, or clears it with
   * undefined. For things that need attention while the tab isn't open.
   */
  setBadge(viewId: string, text: string | undefined): void;
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
}
