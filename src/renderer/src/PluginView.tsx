import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { PluginStatus } from '../../shared/api';
import type { UiPluginApi, UiPluginView } from '../../plugin-api/ui';

/** Keeps a crashing plugin view from taking the rest of the app down with it. */
class PluginErrorBoundary extends Component<{ label: string; children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[leverframe] ${this.props.label} view failed:`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="plugin-locked" role="alert">
        <h2>{this.props.label}</h2>
        <p>This view stopped working: {this.state.error.message}</p>
        <button type="button" className="secondary" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}

/** A plugin's view, or a locked panel explaining why the plugin isn't running. */
export function PluginView({
  view,
  status,
  api,
}: {
  view: UiPluginView;
  status: PluginStatus | undefined;
  api: UiPluginApi;
}): React.JSX.Element {
  if (!status?.active) {
    return (
      <div className="plugin-locked">
        <h2>{view.label}</h2>
        <p>{status?.reason ?? 'This feature isn’t available.'}</p>
        {status?.reason !== 'Starting…' && (
          <p className="muted">Everything else in Leverframe keeps working without it.</p>
        )}
      </div>
    );
  }
  const View = view.component;
  return (
    <div className="plugin-view">
      <PluginErrorBoundary label={view.label}>
        <View api={api} />
      </PluginErrorBoundary>
    </div>
  );
}
