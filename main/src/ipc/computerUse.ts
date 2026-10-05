import type { ConfigManager } from '../services/configManager';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { getComputerUseEngine } from '../services/computerUse/activeEngine';
import { ScriptHosts, type ScriptRunResult } from '../services/computerUse/scriptHosts';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const COMPUTER_USE_OFF_MESSAGE = "Computer use is off on this machine. Turn it on in Pane's Remote Access settings.";
const REMOTE_REFUSAL = 'Only this machine is supported yet.';

const runRequestSchema = boundary.object({ connectionId: boundary.nonEmptyString, code: boundary.string });
const resetRequestSchema = boundary.object({ connectionId: boundary.nonEmptyString });

const isEnabled = (config: AppConfig) => config.computerUse?.enabled === true;

/**
 * The `js` and `js_reset` MCP tools land here. Each agent connection gets its own script host;
 * turning computer use off stops every script and the engine.
 */
export function registerComputerUseHandlers(
  commandRegistry: PaneCommandRegistry,
  configManager: Pick<ConfigManager, 'getConfig' | 'on'>,
  hosts = new ScriptHosts({ getEngine: getComputerUseEngine }),
): void {
  let enabled = isEnabled(configManager.getConfig());
  configManager.on('config-updated', (config: AppConfig) => {
    const wasEnabled = enabled;
    enabled = isEnabled(config);
    if (wasEnabled && !enabled) void stopEverything();
  });

  async function stopEverything(): Promise<void> {
    try {
      await hosts.stopAll(COMPUTER_USE_OFF_MESSAGE);
    } catch (error) {
      console.error('[computer-use] Failed to stop the engine:', error);
    }
  }

  commandRegistry.register('computer-use:run', async (request: PaneCommandValue): Promise<ScriptRunResult> => {
    if (isRemotePaneCommand()) return { ok: false, text: REMOTE_REFUSAL, images: [] };
    if (!enabled) return { ok: false, text: COMPUTER_USE_OFF_MESSAGE, images: [] };
    const { connectionId, code } = decodeBoundary(request, runRequestSchema);
    return hosts.run(connectionId, code);
  });

  commandRegistry.register('computer-use:reset', (request: PaneCommandValue) => {
    if (isRemotePaneCommand()) return { ok: false, reset: false };
    const { connectionId } = decodeBoundary(request, resetRequestSchema);
    return { ok: true, reset: hosts.reset(connectionId) };
  });

  // Connection ids are the only key to a script's state, so they stay on this machine.
  commandRegistry.register('computer-use:status', () => (
    isRemotePaneCommand() ? { enabled, hosts: [] } : { enabled, hosts: hosts.summaries() }
  ));
}
