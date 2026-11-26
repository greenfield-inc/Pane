/**
 * Did a terminal Session agent's turn end with a message the person can read? (T-117 D-1.) Only
 * such a turn makes its Session unread, whatever started it: the person, a worker report, a
 * `[From Pane …]`, watcher or Autopilot line. Chat tabs answer this themselves at the turn's end
 * (ChatTranscript.endTurn); this probe is for terminal tabs.
 *
 * - Claude and Codex: the agent's own transcript, split into turns at its own prompt rows
 *   (agentTranscripts.readFinishedTurns). The probe keeps, per tab, where its last judgment stopped,
 *   and judges the turns finished since: never a turn still working, never one already judged, and
 *   never by the clock. A transcript written just after the tab went idle is read again, and a
 *   positive read is believed only when the next read agrees (a turn's last tool call can land
 *   after its progress text). Without evidence the turn does not count.
 * - Any other terminal agent has no transcript Pane can read, so each finished turn counts. That
 *   is a known limit (D-2, docs/SESSIONS.md).
 */

import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { agentTranscripts, isTranscriptAgent, type FinishedTurns, type TranscriptCursor, type TranscriptLocator } from './agentTranscript';
import { panelTranscriptLocator } from './agentTranscript/panelLocator';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';

export interface ReplyProbe {
  /** Whether the tab's turn that just ended (with any others finished since the last judgment) ended with text the person can read. */
  turnEnded(panelId: string): Promise<boolean>;
}

export interface ReplyProbeSources {
  /** The CLI agent in the tab; undefined when Pane did not recognise one. */
  agentTypeOf(panelId: string): string | undefined;
  /** Where the tab's transcript is; undefined when Pane cannot tell. */
  locatorOf(panelId: string): TranscriptLocator | undefined;
  /** The tab's agent is idle now, so its last turn has finished. */
  isIdle(panelId: string): boolean;
  readTurns(locator: TranscriptLocator, cursor: TranscriptCursor | undefined, idleNow: boolean): Promise<FinishedTurns>;
  wait(ms: number): Promise<void>;
}

/** Reads after the tab went idle: at once, then after these waits. A positive read needs the next one to agree. */
const TRANSCRIPT_READ_WAITS_MS = [1_000, 1_000, 2_000];

export function createReplyProbe(sources: ReplyProbeSources): ReplyProbe {
  const cursors = new Map<string, TranscriptCursor>();
  return {
    async turnEnded(panelId) {
      if (!isTranscriptAgent(sources.agentTypeOf(panelId))) return true;
      const locator = sources.locatorOf(panelId);
      if (!locator) return false;
      const from = cursors.get(panelId);
      let previous: boolean | undefined;
      let last: FinishedTurns | undefined;
      let settled = false;
      for (const delay of [0, ...TRANSCRIPT_READ_WAITS_MS]) {
        if (delay > 0) await sources.wait(delay);
        try {
          last = await sources.readTurns(locator, from, sources.isIdle(panelId));
        } catch (error) {
          console.warn(`[Sessions] Could not read panel ${panelId}'s transcript, so its turn does not mark the Session unread:`, error);
          return false;
        }
        settled = last.endedWithText === true && previous === true;
        if (settled) break;
        previous = last.endedWithText;
      }
      // Judged: the next turn is read from where this judgment stopped. Nothing found leaves the cursor.
      if (last?.endedWithText !== undefined && last.cursor) cursors.set(panelId, last.cursor);
      return settled;
    },
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
    isIdle: panelId => terminalPanelManager.getAgentStatus(panelId) === 'idle',
    readTurns: agentTranscripts.readFinishedTurns,
    wait: ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }),
  };
}
