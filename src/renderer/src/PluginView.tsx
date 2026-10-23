import type { PluginStatus } from '../../shared/api';
import type { UiPluginApi, UiPluginView } from '../../plugin-api/ui';

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
      </div>
    );
  }
  const Component = view.component;
  return (
    <div className="plugin-view">
      <Component api={api} />
    </div>
  );
}
