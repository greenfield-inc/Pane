import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { logsManager } from './panels/logPanel/logsManager';

/** Panes whose run script Pause stopped, so Resume starts it again. In memory, like the script itself. */
const stoppedByPause = new Set<string>();

/** Pausing a Pane stops its run script (the Logs panel process) too. */
export async function stopRunScriptsForPause(registry: PaneCommandRegistry, paneIds: readonly string[]): Promise<void> {
  for (const paneId of paneIds) {
    // The live process is the truth; the Logs panel's saved flag can lag a script that just restarted.
    const running = (await logsManager.getRunningProcess(paneId)) !== undefined || (await logsManager.isRunning(paneId));
    if (!running) continue;
    await registry.invoke('sessions:stop-script', [paneId]);
    stoppedByPause.add(paneId);
  }
}

/** Resuming a Pane runs the script Pause stopped again. */
export async function restartRunScriptsAfterResume(registry: PaneCommandRegistry, paneIds: readonly string[]): Promise<void> {
  for (const paneId of paneIds) {
    if (!stoppedByPause.delete(paneId)) continue;
    await registry.invoke('sessions:run-script', [paneId]);
  }
}
