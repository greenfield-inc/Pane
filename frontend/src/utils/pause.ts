import type { TerminalPausedMark } from '../../../shared/types/panels';
import { DEFAULT_AUTO_PAUSE_HOURS } from '../../../shared/types/autoPause';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { showActionError, useErrorStore } from '../stores/errorStore';
import { useConfigStore } from '../stores/configStore';
import { formatDistanceToNow } from './timestampUtils';

/** What Pause and Resume act on: one tab, a Pane (its terminal tabs), or a Session (the terminal tabs of its chat and Panes). */
export type PauseTarget = { kind: 'panel' | 'pane' | 'session'; id: string };

/** "Paused 2 days ago". */
export function pausedLabel(mark: TerminalPausedMark): string {
  return `Paused ${formatDistanceToNow(mark.at)}`;
}

/** Why an auto-pause happened, with the threshold that applied; nothing for a manual pause. */
export function pausedReason(mark: TerminalPausedMark): string | null {
  return mark.by === 'auto' ? `Auto-paused after ${mark.idleHours ?? DEFAULT_AUTO_PAUSE_HOURS} h idle` : null;
}

const CHANNELS = {
  panel: { pause: 'runpane:panels:pause', resume: 'runpane:panels:resume', key: 'panelId' },
  pane: { pause: 'runpane:panes:pause', resume: 'runpane:panes:resume', key: 'paneId' },
  session: { pause: 'runpane:sessions:pause', resume: 'runpane:sessions:resume', key: 'sessionId' },
} as const;

const NOUN = { panel: 'tab', pane: 'Pane', session: 'Session' } as const;

/** A pause or resume that ran but left some tabs stopped answers `ok: false` with a message. */
const resultSchema = boundary.object({ ok: boundary.boolean, message: boundary.optional(boundary.string), chatTabsNotPaused: boundary.optional(boundary.number) });

/** Pauses or resumes on this computer's host. Throws what the host said when it fails. */
async function setPaused(target: PauseTarget, paused: boolean): Promise<void> {
  const channel = CHANNELS[target.kind];
  const result = decodeOptionalBoundary(
    await window.electronAPI.invoke(paused ? channel.pause : channel.resume, { [channel.key]: target.id }),
    resultSchema,
  );
  if (result?.ok === false) throw new Error(result.message ?? 'Some tabs did not start.');
  // Not a failure, but the person must know these agents are still running (D-187).
  if (result?.chatTabsNotPaused && result.message) useErrorStore.getState().showError({ title: 'Chat tabs keep running', error: result.message });
}

/** Runs Pause or Resume from a menu or banner and shows why when it fails. */
export async function runPauseAction(target: PauseTarget, paused: boolean): Promise<void> {
  try {
    await setPaused(target, paused);
  } catch (error) {
    showActionError(`Could not ${paused ? 'pause' : 'resume'} the ${NOUN[target.kind]}`, error);
  }
}

/**
 * A person selecting a paused Pane or Session chat resumes it when Settings asks for that
 * (`resumePausedOnOpen`, off by default). Call it only from a person's selection: background
 * mounts, retries and remote reads never count as opening.
 */
export function resumeIfOpenResumes(target: PauseTarget, paused: boolean): void {
  if (!paused || useConfigStore.getState().config?.resumePausedOnOpen !== true) return;
  void runPauseAction(target, false);
}
