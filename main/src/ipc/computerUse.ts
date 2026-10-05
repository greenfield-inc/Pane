import { pathToFileURL } from 'node:url';
import type { ConfigManager } from '../services/configManager';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { getComputerUseEngine } from '../services/computerUse/activeEngine';
import { reportedStepSchema, saveStep, writeReplay } from '../services/computerUse/replay';
import { showComputerUseForegroundNotice } from '../services/computerUse/foregroundNotice';
import { ScriptHosts, type ScriptRunResult } from '../services/computerUse/scriptHosts';
import type { AppConfig } from '../types/config';
import { getAppSubdirectory } from '../utils/appDirectory';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

const COMPUTER_USE_OFF_MESSAGE = "Computer use is off on this machine. Turn it on in Pane's Remote Access settings.";
const REMOTE_REFUSAL = 'Only this machine is supported yet.';

const runRequestSchema = boundary.object({
  connectionId: boundary.nonEmptyString,
  code: boundary.string,
  /** The calling agent's Pane (its PANE_SESSION_ID); runs without one leave no replay. */
  sessionId: boundary.optional(boundary.string),
  /** The MCP client's name, such as "Claude Code", for the foreground notice. */
  agent: boundary.optional(boundary.string),
});
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPLAY_TITLE = 'Computer use replay';
const resetRequestSchema = boundary.object({ connectionId: boundary.nonEmptyString });

const isEnabled = (config: AppConfig) => config.computerUse?.enabled === true;

/** Which agent each connection belongs to, as its latest run said. */
const agentsByConnection = new Map<string, string>();

const defaultHosts = () =>
  new ScriptHosts({
    getEngine: getComputerUseEngine,
    showForegroundNotice: ({ connectionId, app }) =>
      showComputerUseForegroundNotice({ agent: agentsByConnection.get(connectionId) ?? 'An agent', app }),
  });

/**
 * The `js` and `js_reset` MCP tools land here. Each agent connection gets its own script host;
 * turning computer use off stops every script and the engine.
 */
export function registerComputerUseHandlers(
  commandRegistry: PaneCommandRegistry,
  configManager: Pick<ConfigManager, 'getConfig' | 'on'>,
  hosts = defaultHosts(),
  /** Where a Pane's steps and replay live; archiving the Pane deletes its artifacts folder. */
  replayDir = (sessionId: string) => getAppSubdirectory('artifacts', sessionId, 'computer-use'),
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
    const { connectionId, code, sessionId, agent } = decodeBoundary(request, runRequestSchema);
    if (agent) agentsByConnection.set(connectionId, agent);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return hosts.run(connectionId, code);
    return runWithReplay(connectionId, code, sessionId);
  });

  /** Saves each step the run reports, then rebuilds the Pane's replay and shows it in a tab. */
  async function runWithReplay(connectionId: string, code: string, sessionId: string): Promise<ScriptRunResult> {
    const dir = replayDir(sessionId);
    const run = `${Date.now().toString(36)}-${connectionId.slice(0, 8)}`;
    let count = 0;
    let saving = Promise.resolve();
    const onStep = (value: JsonValue) => {
      const reported = decodeOptionalBoundary(value, reportedStepSchema);
      if (!reported) return;
      const step = { ...reported, index: reported.index ?? count, args: reported.args ?? {}, result: reported.result ?? null, at: reported.at ?? new Date().toISOString() };
      count += 1;
      saving = saving.then(() => saveStep(dir, run, step)).catch((error) => console.error('[computer-use] Failed to save a step:', error));
    };
    const result = await hosts.run(connectionId, code, onStep);
    if (count === 0) return result;
    await saving;
    try {
      const replay = await writeReplay(dir);
      await openReplayTab(sessionId, pathToFileURL(replay).href);
      return { ...result, text: `${result.text}\n\nReplay (${count} ${count === 1 ? 'step' : 'steps'} this run): ${replay}` };
    } catch (error) {
      console.error('[computer-use] Failed to write the replay:', error);
      return result;
    }
  }

  /** Opens the replay as a tab in the agent's Pane without taking focus, or reloads the open one. */
  async function openReplayTab(sessionId: string, url: string): Promise<void> {
    try {
      await commandRegistry.invoke('runpane:panels:open', [{ paneId: sessionId, url, title: REPLAY_TITLE, placement: 'tab', noFocus: true, source: 'agent' }]);
    } catch (error) {
      console.error('[computer-use] Failed to open the replay tab:', error);
    }
  }

  commandRegistry.register('computer-use:reset', (request: PaneCommandValue) => {
    if (isRemotePaneCommand()) return { ok: false, reset: false };
    const { connectionId } = decodeBoundary(request, resetRequestSchema);
    agentsByConnection.delete(connectionId);
    return { ok: true, reset: hosts.reset(connectionId) };
  });

  // Connection ids are the only key to a script's state, so they stay on this machine.
  commandRegistry.register('computer-use:status', () => (
    isRemotePaneCommand() ? { enabled, hosts: [] } : { enabled, hosts: hosts.summaries() }
  ));
}
