/** The name agents know Pane's MCP server by, over stdio and HTTP alike. */
export const PANE_MCP_SERVER_NAME = 'pane';
/** Pane's Claude plugin (`claude-plugin/` in the Pane repository). */
export const PANE_CLAUDE_PLUGIN_NAME = 'pane';
/** A tab Pane points at its MCP endpoint carries the URL and the tab's token under these names. */
export const PANE_MCP_URL_ENV = 'PANE_MCP_URL';
export const PANE_MCP_TOKEN_ENV = 'PANE_MCP_TOKEN';
/**
 * Claude settings that hide the `pane` server the `pane` Claude plugin brings (Claude names it
 * `plugin:<plugin>:<server>`), for a tab or chat that reaches Pane's tools over HTTP.
 */
export const PANE_MCP_PLUGIN_DENY_SETTINGS = { deniedMcpServers: [{ serverName: `plugin:${PANE_CLAUDE_PLUGIN_NAME}:${PANE_MCP_SERVER_NAME}` }] };
