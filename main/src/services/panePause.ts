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
 * Pauses whole Panes: their terminal tabs and their run script (the Logs panel process). A run
 * script Pause stopped is recorded in the tabs' saved marks, so Resume runs it again even after
 * Pane restarts. Each Pane is paused on its own: one that fails is reported and the rest still pause.
 */
export async function pausePanes(registry: PaneCommandRegistry, paneIds: readonly string[], mark: TerminalPausedMark): Promise<PauseOutcome> {
  const outcomes = await Promise.all(paneIds.map(async (paneId): Promise<PauseOutcome> => {
    try {
      const scriptStopped = await stopRunScript(registry, paneId);
      return await terminalPanelManager.pausePanels(terminalPanelIdsOf([paneId]), scriptStopped ? { ...mark, runScript: true } : mark);
    } catch (error) {
      console.error(`[Pause] Pane ${paneId} could not be paused:`, error);
      return { paused: [], failed: [{ panelId: paneId, error: reasonOf(error) }] };
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

async function stopRunScript(registry: PaneCommandRegistry, paneId: string): Promise<boolean> {
  // The live process is the truth; the Logs panel's saved flag can lag a script that just restarted.
  const running = (await logsManager.getRunningProcess(paneId)) !== undefined || (await logsManager.isRunning(paneId));
  if (!running) return false;
  await registry.invoke('sessions:stop-script', [paneId]);
  return true;
}
