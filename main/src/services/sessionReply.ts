/**
 * Did a terminal Session agent's turn end with a message the person can read? (T-117 D-1.) Only
 * such a turn makes its Session unread, whatever started it: the person, a worker report, a
 * `[From Pane …]`, watcher or Autopilot line. Chat tabs answer this themselves at the turn's end
 * (ChatTranscript.endTurn); this probe is for terminal tabs.
 *
 * - Claude and Codex: the agent's own transcript, read for the turn's window only. The turn counts
 *   when its last reply-or-tool-call row is non-blank reply text. A transcript written just after
 *   the tab went idle is read again a few times; without evidence the turn does not count.
 * - Any other terminal agent has no transcript Pane can read, so each finished turn counts. That
 *   is a documented limit (docs/SESSIONS.md).
 */

import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { agentTranscripts, isTranscriptAgent, type TranscriptLocator } from './agentTranscript';
import { panelTranscriptLocator } from './agentTranscript/panelLocator';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';

interface TurnWindow {
  startedAtMs: number;
  endedAtMs: number;
}

/** Asks whether `panelId`'s turn in `turn` ended with text the person can read. */
export type ReplyProbe = (panelId: string, turn: TurnWindow) => Promise<boolean>;

export interface ReplyProbeSources {
  /** The CLI agent in the tab; undefined when Pane did not recognise one. */
  agentTypeOf(panelId: string): string | undefined;
  /** Where the tab's transcript is; undefined when Pane cannot tell. */
  locatorOf(panelId: string): TranscriptLocator | undefined;
  readTurn(locator: TranscriptLocator, startedAtMs: number, endedAtMs: number): Promise<boolean | undefined>;
  wait(ms: number): Promise<void>;
}

/** The transcript's last lines can land after the tab went idle: read again after these waits. */
const TRANSCRIPT_RETRY_WAITS_MS = [1_000, 2_000];

export function createReplyProbe(sources: ReplyProbeSources): ReplyProbe {
  return async (panelId, turn) => {
    if (!isTranscriptAgent(sources.agentTypeOf(panelId))) return true;
    const locator = sources.locatorOf(panelId);
    if (!locator) return false;
    for (const delay of [0, ...TRANSCRIPT_RETRY_WAITS_MS]) {
      if (delay > 0) await sources.wait(delay);
      try {
        if (await sources.readTurn(locator, turn.startedAtMs, turn.endedAtMs)) return true;
      } catch (error) {
        console.warn(`[Sessions] Could not read panel ${panelId}'s transcript, so its turn does not mark the Session unread:`, error);
        return false;
      }
    }
    return false;
  };
}

const savedAgentType = boundary.object({ agentType: boundary.optional(boundary.string) });

/** The agent the terminal shows, else the one Pane saved on the tab (as the workspace journal reads it). */
function terminalAgentType(panelId: string): string | undefined {
  const saved = decodeOptionalBoundary(panelManager.getPanel(panelId)?.state.customState ?? {}, savedAgentType)?.agentType;
  return terminalPanelManager.getTerminalSnapshot(panelId)?.agentType ?? saved;
}

/** The host's sources: `worktreeOf` gives a Pane's working directory, where its agent's transcript is kept. */
export function hostReplyProbeSources(worktreeOf: (paneId: string) => string | undefined): ReplyProbeSources {
  return {
    agentTypeOf: terminalAgentType,
    locatorOf: panelId => {
      const panel = panelManager.getPanel(panelId);
      return panel ? panelTranscriptLocator(panel, worktreeOf(panel.sessionId), terminalAgentType(panelId)) : undefined;
    },
    readTurn: agentTranscripts.turnEndedWithText,
    wait: ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }),
  };
}
