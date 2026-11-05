import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { pausedMarkOf, type TerminalPausedMark } from '../../../shared/types/panels';
import { reasonOf } from '../../../shared/paneError';
import { panelManager } from './panelManager';
import { terminalPanelManager, type PauseOutcome } from './terminalPanelManager';
import { logsManager } from './panels/logPanel/logsManager';

/** The terminal tabs of a Pane: what pausing or resuming the Pane acts on. */
export function terminalPanelIdsOf(paneIds: readonly string[]): string[] {
  return paneIds.flatMap(paneId => panelManager.getPanelsForSession(paneId).filter(panel => panel.type === 'terminal').map(panel => panel.id));
}

/**
 * Pauses whole Panes: their terminal tabs and their run script (the Logs panel process). The tabs are
 * marked first, and the script stops only once a mark records it, so Resume runs it again even after
 * Pane restarts. A Pane with no tab paused keeps its script. Each Pane is paused on its own: one that
 * fails is reported and the rest still pause.
 */
export async function pausePanes(registry: PaneCommandRegistry, paneIds: readonly string[], mark: TerminalPausedMark): Promise<PauseOutcome> {
  const outcomes = await Promise.all(paneIds.map(async (paneId): Promise<PauseOutcome> => {
    const panelIds = terminalPanelIdsOf([paneId]);
    try {
      const scriptRunning = panelIds.length > 0 && await runScriptRunning(paneId);
      const outcome = await terminalPanelManager.pausePanels(panelIds, scriptRunning ? { ...mark, runScript: true } : mark);
      if (scriptRunning && outcome.paused.length > 0) await stopRunScript(registry, paneId);
      return outcome;
    } catch (error) {
      console.error(`[Pause] Pane ${paneId} could not be paused:`, error);
      return { paused: [], failed: panelIds.map(panelId => ({ panelId, error: reasonOf(error) })) };
    }
  }));
  return { paused: outcomes.flatMap(outcome => outcome.paused), failed: outcomes.flatMap(outcome => outcome.failed) };
}

/** The Panes whose run script a pause stopped, read from their paused tabs' marks before Resume clears them. */
export function panesWithStoppedRunScripts(paneIds: readonly string[]): string[] {
  return paneIds.filter(paneId => panelManager.getPanelsForSession(paneId).some(panel => pausedMarkOf(panel)?.runScript === true));
}

/** Runs again the run scripts a pause stopped. One that fails to start is logged; the others still run. */
export async function restartRunScripts(registry: PaneCommandRegistry, paneIds: readonly string[]): Promise<void> {
  for (const paneId of paneIds) {
    try {
      await registry.invoke('sessions:run-script', [paneId]);
    } catch (error) {
      console.error(`[Pause] Pane ${paneId}'s run script did not start again on resume:`, error);
    }
  }
}

async function runScriptRunning(paneId: string): Promise<boolean> {
  // The live process is the truth; the Logs panel's saved flag can lag a script that just restarted.
  return (await logsManager.getRunningProcess(paneId)) !== undefined || (await logsManager.isRunning(paneId));
}

async function stopRunScript(registry: PaneCommandRegistry, paneId: string): Promise<void> {
  try {
    await registry.invoke('sessions:stop-script', [paneId]);
  } catch (error) {
    // The tabs are paused and their marks record the script, so Resume restarts it either way.
    console.error(`[Pause] Pane ${paneId}'s tabs paused, but its run script did not stop:`, error);
  }
}
