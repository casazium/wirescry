/**
 * What a UI plugin (such as Leverframe Pro) can do. Part of the open-source app;
 * plugins import these types.
 */
import type { ComponentType } from 'react';

export interface UiPluginApi {
  /** Calls the plugin's backend half. */
  call(name: string, args?: unknown): Promise<unknown>;
  /** Listens for events from the plugin's backend half. Returns a function that stops listening. */
  on(event: string, listener: (data: unknown) => void): () => void;
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
  views: UiPluginView[];
}
