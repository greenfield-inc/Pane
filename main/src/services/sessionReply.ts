/**
 * Did a terminal Session agent's turn end with a message the person can read? (T-117 D-1.) Only
 * such a turn makes its Session unread, whatever started it: the person, a worker report, a
 * `[From Pane …]`, watcher or Autopilot line. Chat tabs answer this themselves at the turn's end
 * (ChatTranscript.endTurn); this probe is for terminal tabs.
 *
 * - Claude and Codex: when the turn starts, the probe marks where the agent's transcript ends; when
 *   it ends, it reads the turn's rows from there (agentTranscripts.turnEndedWithText), by row order,
 *   never by the clock. A transcript written just after the tab went idle is read again, and a
 *   positive read is believed only when a read a second later agrees (the turn's last tool call
 *   can land after its progress text). Without evidence the turn does not count.
 * - Any other terminal agent has no transcript Pane can read, so each finished turn counts. That
 *   is a known limit (D-2, docs/SESSIONS.md).
 */

import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { agentTranscripts, isTranscriptAgent, type TranscriptLocator, type TranscriptMark, type TurnStart } from './agentTranscript';
import { panelTranscriptLocator } from './agentTranscript/panelLocator';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';

interface TurnWindow {
  startedAtMs: number;
  endedAtMs: number;
}

export interface ReplyProbe {
  /** The Session agent's tab started a turn: mark where its transcript ends now. */
  turnStarted(panelId: string): void;
  /** Whether the tab's turn in `turn` ended with text the person can read. */
  turnEnded(panelId: string, turn: TurnWindow): Promise<boolean>;
}

export interface ReplyProbeSources {
  /** The CLI agent in the tab; undefined when Pane did not recognise one. */
  agentTypeOf(panelId: string): string | undefined;
  /** Where the tab's transcript is; undefined when Pane cannot tell. */
  locatorOf(panelId: string): TranscriptLocator | undefined;
  mark(locator: TranscriptLocator): Promise<TranscriptMark | undefined>;
  readTurn(locator: TranscriptLocator, since: TurnStart): Promise<boolean | undefined>;
  wait(ms: number): Promise<void>;
}

/** Reads after the tab went idle: at once, then after these waits. A positive read needs the next one to agree. */
const TRANSCRIPT_READ_WAITS_MS = [1_000, 1_000, 2_000];

export function createReplyProbe(sources: ReplyProbeSources): ReplyProbe {
  const starts = new Map<string, Promise<TranscriptMark | undefined>>();
  return {
    turnStarted(panelId) {
      const locator = isTranscriptAgent(sources.agentTypeOf(panelId)) ? sources.locatorOf(panelId) : undefined;
      if (!locator) {
        starts.delete(panelId);
        return;
      }
      starts.set(panelId, sources.mark(locator).catch(() => undefined));
    },
    async turnEnded(panelId, turn) {
      const started = starts.get(panelId);
      starts.delete(panelId);
      if (!isTranscriptAgent(sources.agentTypeOf(panelId))) return true;
      const locator = sources.locatorOf(panelId);
      if (!locator) return false;
      const since: TurnStart = (await started) ?? { startedAtMs: turn.startedAtMs };
      let previous: boolean | undefined;
      for (const delay of [0, ...TRANSCRIPT_READ_WAITS_MS]) {
        if (delay > 0) await sources.wait(delay);
        let read: boolean | undefined;
        try {
          read = await sources.readTurn(locator, since);
        } catch (error) {
          console.warn(`[Sessions] Could not read panel ${panelId}'s transcript, so its turn does not mark the Session unread:`, error);
          return false;
        }
        if (read === true && previous === true) return true;
        previous = read;
      }
      return false;
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
    mark: agentTranscripts.mark,
    readTurn: agentTranscripts.turnEndedWithText,
    wait: ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }),
  };
}
