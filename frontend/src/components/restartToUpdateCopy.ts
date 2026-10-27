import type { RestartToUpdateState, UpdateBusyState, UpdateRestoreResult } from '../../../shared/types/updater';

/** What the restart-to-update toast is showing. */
export type RestartToUpdateToastView =
  /** Main found everything idle for 5 minutes. */
  | { kind: 'idle'; version: string; paneCount: number }
  /** The user clicked the pill while nothing runs. */
  | { kind: 'clicked-idle'; version: string; paneCount: number }
  | { kind: 'busy'; version: string; busy: UpdateBusyState }
  | { kind: 'tonight'; version: string };

export interface RestartToUpdateToastCopy {
  title: string;
  body: string;
  note?: string;
}

const COMES_BACK = 'Restart now and everything comes back: Panes, tabs, splits and agents.';
const RUNPANE_NOTE = 'Brings Pane up to date with the runpane your agents use.';

function idleSentence(paneCount: number, held: boolean): string {
  if (paneCount === 0) return held ? 'Pane has been idle for 5 minutes.' : 'Pane is idle.';
  if (paneCount === 1) return held ? 'Your Pane has been idle for 5 minutes.' : 'Your Pane is idle.';
  return held ? `All ${paneCount} Panes have been idle for 5 minutes.` : `All ${paneCount} Panes are idle.`;
}

function busySentence(busy: UpdateBusyState): string {
  switch (busy.reason) {
    case 'agents':
      return busy.agentCount === 1
        ? '1 agent is still working or waiting for you.'
        : `${busy.agentCount} agents are still working or waiting for you.`;
    case 'run-script':
      return 'A run script is still running.';
    case 'archive':
      return 'Worktree removal is still running.';
  }
}

export function restartToUpdateToastCopy(view: RestartToUpdateToastView): RestartToUpdateToastCopy {
  switch (view.kind) {
    case 'idle':
    case 'clicked-idle':
      return {
        title: `Pane ${view.version} is ready`,
        body: `${idleSentence(view.paneCount, view.kind === 'idle')} ${COMES_BACK}`,
        note: RUNPANE_NOTE,
      };
    case 'busy':
      return {
        title: `Pane ${view.version} is ready`,
        body: `${busySentence(view.busy)} Restarting ends what is running and any pending approval. Conversations come back after the restart.`,
      };
    case 'tonight':
      return {
        title: `Pane ${view.version} restarts tonight`,
        body: 'Between 2:00 and 5:00, once everything has been idle for an hour and nobody has used the computer for 30 minutes. Everything comes back: Panes, tabs, splits and agents.',
      };
  }
}

function panesBack(paneCount: number, withCount: boolean): string {
  if (paneCount === 0) return '';
  if (paneCount === 1) return ' Your Pane is back.';
  return withCount ? ` ${paneCount} Panes are back.` : ' Your Panes are back.';
}

/** The one-line notice on the launch after a restart to update. */
export function restoredToastMessage(result: UpdateRestoreResult): string {
  if (result.installed) return `Pane updated to ${result.toVersion}.${panesBack(result.panesRestored, true)}`;
  return `Pane restarted, but the update did not install.${panesBack(result.panesRestored, false)} To try again, open Settings and choose Check Now.`;
}

/** The pill's label; null when there is no pill. A ready download wins over a release that can only be installed by hand. */
export function restartPillLabel(state: RestartToUpdateState | null): string | null {
  if (state?.readyVersion) return state.tonight ? 'Restarts tonight' : 'Restart to update';
  if (state?.availableVersion) return 'Update available';
  return null;
}

/** The pill's label plus the version, for the collapsed rail's tooltip and the pill's accessible name. */
export function restartPillDescription(state: RestartToUpdateState | null): string | null {
  if (state?.readyVersion) {
    return state.tonight
      ? `Restarts tonight to update to Pane ${state.readyVersion}`
      : `Restart to update to Pane ${state.readyVersion}`;
  }
  if (state?.availableVersion) return `Update available: Pane ${state.availableVersion}`;
  return null;
}

/** Every label the pill can show; the pill sizes itself to the widest. */
export const RESTART_PILL_LABELS = ['Restart to update', 'Restarts tonight', 'Update available'] as const;
