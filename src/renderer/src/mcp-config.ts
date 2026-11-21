import type { McpStatus } from '../../shared/api';

/** The section's id, so the toolbar's "Agent active" badge can bring it into view. */
export const MCP_SECTION_ID = 'mcp-section';

/** How long after an agent's last call it counts as active, for the toolbar badge. */
export const ACTIVE_MS = 60_000;

/** Whether an agent made a call in the last minute. */
export function agentActive(mcp: McpStatus | undefined, now: number): boolean {
  const last = mcp?.activity[0]?.at;
  return mcp?.listening === true && last !== undefined && now - last < ACTIVE_MS;
}

/** Ready-to-paste settings for the common AI coding agents. */
export function agentConfigs(url: string, token: string): Array<{ name: string; text: string }> {
  const header = `Bearer ${token}`;
  return [
    {
      name: 'Claude Code (run in a terminal)',
      text: `claude mcp add --transport http wirescry ${url} --header "Authorization: ${header}"`,
    },
    {
      name: 'Cursor (.cursor/mcp.json)',
      text: JSON.stringify(
        { mcpServers: { wirescry: { url, headers: { Authorization: header } } } },
        null,
        2,
      ),
    },
    {
      name: 'VS Code (.vscode/mcp.json)',
      text: JSON.stringify(
        { servers: { wirescry: { type: 'http', url, headers: { Authorization: header } } } },
        null,
        2,
      ),
    },
  ];
}
