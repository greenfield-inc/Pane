import fs from 'fs/promises';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { PANE_CLAUDE_PLUGIN_NAME } from './paneMcpNames';

const enabledPluginsSchema = boundary.object({ enabledPlugins: boundary.optional(boundary.jsonObject) });

/**
 * Whether the user turned on Pane's Claude plugin in Claude Code's user settings
 * (`<config dir>/settings.json`, `enabledPlugins` keyed `pane@<marketplace>`: the plugin
 * directory's, or `synced` when installed from claude.ai). The plugin brings Pane's MCP server
 * and its two skills, so Pane's own Claude copies step aside while it is on.
 */
export async function isPanePluginEnabled(settingsPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const plugins = decodeOptionalBoundary(parsed, enabledPluginsSchema)?.enabledPlugins ?? {};
  return Object.entries(plugins).some(([id, enabled]) => enabled === true && id.startsWith(`${PANE_CLAUDE_PLUGIN_NAME}@`));
}
