/**
 * Is this agent tab really in a turn right now? A stricter, Session-only test that sits
 * beside the published per-tab state (agentStatusMonitor), which it never changes.
 *
 * The published state counts any output as working, which suits a Pane dot but not the
 * Session icon: a dev server, a typing echo or a resize would spin it. Here output alone
 * never counts. A terminal agent needs its own working chrome on screen, and that screen
 * must still be animating (Claude and Codex animate a spinner or timer for the whole turn,
 * a long silent tool call included), so a frozen spinner stops counting. A chat agent needs
 * an open turn that is still sending updates, or a tool call still running. A tab waiting
 * on `runpane watch`, `panels wait` or `notify` is waiting, not working. Anything unsure is
 * not mid-turn: the Session shows idle rather than a false spinner.
 */

import type { AgentDetectionResult } from '../../../../shared/types/agentStatus';
import type { ChatTabStatus } from '../../../../shared/types/chatTab';

/** Working chrome counts only while the screen changed this recently. */
export const SCREEN_FRESH_MS = 15_000;
/** A chat turn with no update and no tool running for this long has stalled. */
export const CHAT_STALL_MS = 5 * 60_000;

export interface TerminalMidTurnInput {
  /** The tab runs a known CLI agent; plain shells never count. */
  agentKnown: boolean;
  detection: AgentDetectionResult;
  /** When the screen (text or title) last changed; undefined before the first change. */
  screenChangedAt: number | undefined;
  /** A runpane waiting call from this tab is open. */
  waiting: boolean;
}

export function terminalMidTurn(input: TerminalMidTurnInput, now: number): boolean {
  if (!input.agentKnown || input.waiting) return false;
  const { detection } = input;
  if (detection.state !== 'working' || !detection.visibleWorking) return false;
  return input.screenChangedAt !== undefined && now - input.screenChangedAt < SCREEN_FRESH_MS;
}

export interface ChatMidTurnInput {
  status: ChatTabStatus;
  /** The agent's last update in this turn; undefined before the first. */
  lastUpdateAt: number | undefined;
  /** When the turn began, the stall clock's start until the first update. */
  turnStartedAt?: number;
  /** A tool call is pending or in progress. */
  toolRunning: boolean;
  waiting: boolean;
}

export function chatMidTurn(input: ChatMidTurnInput, now: number, stallMs: number = CHAT_STALL_MS): boolean {
  if (input.status !== 'working' || input.waiting) return false;
  if (input.toolRunning) return true;
  const since = input.lastUpdateAt ?? input.turnStartedAt;
  return since !== undefined && now - since < stallMs;
}

/**
 * Open runpane waiting calls per caller tab. Every runpane request carries its tab's id;
 * the daemon marks a waiting call here for as long as it is open, and its end (finished,
 * failed or the caller gone) clears it. Overlapping calls count separately.
 */
export class RunpaneWaits {
  private readonly open = new Map<string, number>();

  /** Mark a call open for this tab; the returned function ends it, once. */
  begin(panelId: string | undefined): () => void {
    if (!panelId) return () => undefined;
    this.open.set(panelId, (this.open.get(panelId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.open.get(panelId) ?? 1) - 1;
      if (left > 0) this.open.set(panelId, left);
      else this.open.delete(panelId);
    };
  }

  isWaiting(panelId: string): boolean {
    return this.open.has(panelId);
  }
}

/** The host's one record of open runpane waiting calls. */
export const runpaneWaits = new RunpaneWaits();
