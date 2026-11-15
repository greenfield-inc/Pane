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
 * on `runpane watch`, `panels wait` or `notify` is waiting, not working: a terminal tab while
 * any such call from it is open, a chat tab only while the tool call it is running is that
 * wait (a wait sent to the background must not hide real work, D-386). Anything unsure is
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
  /** A tool call other than a runpane wait is pending or in progress. */
  toolRunning: boolean;
  /** The only tool calls running are runpane waits (isRunpaneWait). */
  waiting: boolean;
}

export function chatMidTurn(input: ChatMidTurnInput, now: number, stallMs: number = CHAT_STALL_MS): boolean {
  if (input.status !== 'working' || input.waiting) return false;
  if (input.toolRunning) return true;
  const since = input.lastUpdateAt ?? input.turnStartedAt;
  return since !== undefined && now - since < stallMs;
}

// `runpane`, by name, path, `npx runpane@…` or $PANE_RUNPANE_BIN, as a command of its own
// (at the start or after a shell separator), then a subcommand that waits for the person or an event.
const RUNPANE = String.raw`(?:npx\s+(?:-y\s+|--yes\s+)?)?(?:["']?\$\{?PANE_RUNPANE_BIN\}?["']?|["']?(?:\S*\/)?runpane(?:@\S+)?["']?)`;
const WAIT_COMMAND = new RegExp(String.raw`(?:^|[;&|(\n])\s*${RUNPANE}\s+(?:watch|notify|panels\s+wait|secrets\s+request)\b`);
// The pane MCP's waiting tools, as agents title them (mcp__pane__notify, pane.notify, pane/notify).
const WAIT_TOOL = /(?:^|__|[\s.:/])pane(?:__|[./])(?:notify|watch|panels_wait|secrets_request)\b/;

/** An ACP tool call, as much of it as says what it runs. */
export interface ToolCallInput {
  title?: string | null;
  rawInput?: unknown;
}

/**
 * Is this tool call itself a runpane wait in the foreground (a watch, a panel wait, a card or a
 * secret request)? A command sent to the background returns at once and is not one.
 */
export function isRunpaneWait(call: ToolCallInput): boolean {
  if (call.title && WAIT_TOOL.test(call.title)) return true;
  const input = call.rawInput;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  if ('run_in_background' in input && input.run_in_background === true) return false;
  const command = 'command' in input ? input.command : undefined;
  const candidates = typeof command === 'string' ? [command]
    : Array.isArray(command) ? [...command.filter((part): part is string => typeof part === 'string'), command.join(' ')]
      : [];
  return candidates.some(candidate => WAIT_COMMAND.test(candidate));
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
