import type { ToolPanel, TerminalPanelState } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabSwitchBanner, ChatTabSwitchResult } from '../../../../shared/types/chatTab';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { chatLaunchForTerminal } from './launch';

/**
 * Who owns the Session after a switch tried to hand it over. `chat`: the chat does, or no Session
 * is involved. `terminal`: confirmed still the terminal; with `chatReleased` the chat can be closed
 * without touching the Session, and without it the chat must be left alone.
 */
export type SessionAdoption = { owner: 'chat' } | { owner: 'terminal'; chatReleased: boolean; reason: string };

/** The readiness `runpane panels resume --wait-ready` reports, the fields a restored terminal depends on. */
export interface TerminalReadiness {
  ok: boolean;
  blocked?: { message: string };
  reason?: { code: string; message: string };
  state?: { running: boolean };
}

/**
 * Whether the terminal came back. A running agent whose input box could not be confirmed (Codex's
 * check times out on a status line it does not recognize) or that stopped at its own prompt is back.
 */
export function terminalRestored(readiness: TerminalReadiness | undefined): boolean {
  if (!readiness || readiness.ok || readiness.blocked) return true;
  return readiness.reason?.code === 'agent-not-ready' && readiness.state?.running === true;
}

/**
 * What Pane knows about the conversation a terminal is on (D-269). `sure` only from a SessionStart
 * report made during the terminal's current launch: a saved launch ID, or a report from an earlier
 * launch, is what drifted, so it never counts. `messages`: the conversation has a transcript.
 */
export type TerminalConversation = { sure: true; id: string; messages: boolean } | { sure: false; why: string };

/** Whether a Claude conversation has a transcript: `ambiguous` when two share its ID, `unknown` when Pane can't read them. */
export type TranscriptLookup = (id: string) => 'found' | 'missing' | 'ambiguous' | 'unknown';

export function terminalConversation(
  state: Pick<TerminalPanelState, 'agentType' | 'conversationReport'>,
  currentLaunch: string | undefined,
  transcript: TranscriptLookup,
): TerminalConversation {
  if (state.agentType === 'codex') return { sure: false, why: 'Codex terminals do not report their conversation' };
  const report = state.conversationReport;
  if (!report) return { sure: false, why: 'the terminal has not reported its conversation' };
  if (!currentLaunch || report.launchId !== currentLaunch) return { sure: false, why: `its report (${report.id}) is from an earlier launch` };
  const found = transcript(report.id);
  if (found === 'ambiguous') return { sure: false, why: `two transcripts share its conversation ID ${report.id}` };
  return { sure: true, id: report.id, messages: found !== 'missing' };
}

/** What a switch needs from the rest of Pane; ipc/chatTabs.ts wires the real ones. */
export interface SwitchToChatPorts {
  chatTabsEnabled(): boolean;
  panel(panelId: string): ToolPanel | undefined;
  /** The folder the Pane's agents run in. */
  paneDirectory(paneId: string): string | undefined;
  terminal: {
    /** Whether the agent is in the middle of a turn; false when it is not running. */
    busy(panelId: string): Promise<boolean>;
    /** The conversation this terminal is on, if Pane is sure of it. Sends the agent nothing. */
    conversation(panelId: string): Promise<TerminalConversation>;
    /** Ends the agent once it is idle, with its conversation saved. */
    stop(panelId: string): Promise<void>;
    /** Starts the agent again on its saved conversation, and waits until it is ready. */
    restart(panelId: string): Promise<void>;
    close(panelId: string): Promise<void>;
  };
  chat: {
    /** Adds a chat tab right after the terminal it replaces, in that tab's position, not yet shown or started. */
    create(replaces: ToolPanel, state: ChatPanelState): Promise<string>;
    /** Starts its agent; throws a PaneError when it does not start or cannot load the conversation. */
    start(panelId: string): Promise<void>;
    /** The banner the started chat carries: which conversation it opened. */
    banner(panelId: string): ChatTabSwitchBanner | undefined;
    close(panelId: string): Promise<void>;
    activate(panelId: string): Promise<void>;
  };
  /** A Session's orchestrator tab moves to the chat; any other tab has nothing to move. A throw means the owner is unknown. */
  adoptSessionPanel(fromPanelId: string, toPanelId: string): Promise<SessionAdoption>;
  /** The launch command a Session saved for its orchestrator tab; undefined for any other tab. */
  sessionLaunchCommand(panelId: string): string | undefined;
}

/** A switch that passed every check: the terminal, the chat it opens, and what Pane knows of its conversation. */
export interface PreparedSwitch { panel: ToolPanel; chatState: ChatPanelState; conversation: TerminalConversation }

/** Next steps after a failure past the stop: with the terminal back, and with it stopped. */
const TRY_AGAIN_OR_TERMINAL = 'Press Try again, or keep working in the terminal.';
const TRY_AGAIN = 'Press Try again, or open a chat tab from the + menu and type /resume to pick the conversation.';

function shortId(id: string): string { return id.slice(0, 8); }

/** A nested error's first sentence, for quoting in a dialog; the log keeps all of it. */
function firstSentence(reason: string): string {
  const sentence = reason.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '');
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * Switch to chat (D-129, D-184, D-282): opens a terminal Claude or Codex tab's conversation in a chat
 * tab. The chat opens the conversation Pane is sure the terminal is on; when Pane isn't sure, the
 * folder's most recent conversation that no other Pane tab has open (the chat resolves it at start);
 * a known conversation with no messages, or nothing to open, starts new. A failure after the stop
 * restarts the terminal only on a conversation Pane is sure of. It never sends anything to the agent.
 */
export async function switchToChat(panelId: string, ports: SwitchToChatPorts): Promise<ChatTabSwitchResult> {
  const prepared = await prepareSwitch(panelId, ports);
  return switchPrepared(prepared, ports);
}

/**
 * Every check a switch makes before it touches the agent: throws the PaneError the switch would
 * throw, or returns the chat it would open. Sends the agent nothing, so a preview can ask it.
 */
export async function prepareSwitch(panelId: string, ports: SwitchToChatPorts): Promise<PreparedSwitch> {
  if (!ports.chatTabsEnabled()) throw new PaneError('CHAT_TABS_DISABLED', 'Chat tabs are turned off on this machine. Nothing was switched.', 'Turn on Chat tabs in Settings > AI & Agents, then try again.');
  const panel = ports.panel(panelId);
  if (!panel) throw new PaneError('CHAT_PANEL_MISSING', 'That tab no longer exists. Nothing was switched.', 'Open the agent tab again.');
  // SAFETY: terminal panels persist TerminalPanelState as their custom state; checked by type below.
  const state = (panel.type === 'terminal' ? panel.state.customState : undefined) as TerminalPanelState | undefined;
  const agent = state?.agentType;
  if (!state || (agent !== 'claude' && agent !== 'codex')) {
    throw new PaneError('CHAT_SWITCH_UNSUPPORTED', 'Only a terminal tab running Claude or Codex can switch to chat. Nothing was switched.', 'Open a chat tab from the + menu instead.');
  }
  if (await ports.terminal.busy(panelId)) {
    throw new PaneError('CHAT_SWITCH_BUSY', `${agent === 'claude' ? 'Claude' : 'Codex'} is in the middle of a turn. Nothing was switched.`, 'Wait for it to finish, or stop it (Esc in the terminal), then switch again.');
  }
  const cwd = state.resumeDirectory ?? ports.paneDirectory(panel.sessionId);
  if (!cwd) throw new PaneError('CHAT_PANE_MISSING', 'The Pane for this tab was not found. Nothing was switched.', 'Open the Pane, then try again.');
  // A Session keeps its orchestrator's launch in its record; a Pane tab in its state.
  const command = ports.sessionLaunchCommand(panelId) ?? state.launchCommand ?? state.initialCommand;
  const converted = chatLaunchForTerminal(command, agent, { sessionFolder: state.sessionFolder });
  if ('unsupported' in converted) {
    throw new PaneError('CHAT_SWITCH_LAUNCH_UNSUPPORTED', `This tab's launch uses ${converted.unsupported}, which a chat tab cannot run the same way. Nothing was switched.`, 'Keep using the terminal tab, or open a chat tab from the + menu with the launch you want.');
  }
  // Decided before the stop: the report only counts for the launch that is running now.
  const conversation = await ports.terminal.conversation(panelId);
  const chatState: ChatPanelState = { agent, launch: converted.launch, cwd, status: 'starting' };
  if (!conversation.sure) {
    console.log(`[ChatTabs] Switching ${panelId} to chat on the folder's most recent conversation: Pane is not sure which one it is on (${conversation.why}).`);
    chatState.open = 'most-recent';
  } else if (conversation.messages) {
    console.log(`[ChatTabs] Switching ${panelId} to chat on its reported conversation ${conversation.id}.`);
    chatState.acpSessionId = conversation.id;
  } else {
    console.log(`[ChatTabs] Switching ${panelId} to a new chat: its conversation ${conversation.id} has no messages yet.`);
    chatState.banner = { kind: 'known-empty' };
  }
  if (converted.settings) chatState.settings = converted.settings;
  if (state.orchestrationSessionId) chatState.orchestrationSessionId = state.orchestrationSessionId;
  if (state.sessionFolder) chatState.sessionFolder = state.sessionFolder;
  return { panel, chatState, conversation };
}

/** Switches a tab `prepareSwitch` cleared; it checks nothing again. */
export async function switchPrepared({ panel, chatState, conversation }: PreparedSwitch, ports: SwitchToChatPorts): Promise<ChatTabSwitchResult> {
  const panelId = panel.id;
  try { await ports.terminal.stop(panelId); }
  catch (error) { throw new PaneError('CHAT_SWITCH_BUSY', `The agent could not be stopped cleanly: ${reasonOf(error)}. Nothing was switched.`, 'Wait for it to finish, or stop it (Esc in the terminal), then switch again.'); }

  /**
   * The clean failure after the stop: says why and leaves no chat tab. Only a conversation Pane is
   * sure of, with messages, brings the terminal back; any other restart could start a new conversation.
   */
  const fail = async (reason: string, chatId?: string): Promise<never> => {
    console.warn(`[ChatTabs] Switch to chat of ${panelId} failed after its agent stopped: ${reason}`);
    const leftover: string[] = [];
    if (chatId) {
      await ports.chat.close(chatId).catch(error => {
        console.warn(`[ChatTabs] Could not remove chat tab ${chatId}: ${reasonOf(error)}`);
        leftover.push(' Close the leftover chat tab yourself.');
      });
    }
    const what = reason.replace(/\.$/, '');
    const cause = what.charAt(0).toUpperCase() + what.slice(1);
    if (!conversation.sure) {
      throw new PaneError('CHAT_SWITCH_NOT_STARTED', `${cause}. The terminal is stopped, because Pane wasn't sure which conversation to restart it on. Your conversations are saved.${leftover.join('')}`, TRY_AGAIN);
    }
    if (!conversation.messages) {
      throw new PaneError('CHAT_SWITCH_NOT_STARTED', `${cause}. The terminal is stopped: its conversation had no messages yet, so there was nothing to restart it on.${leftover.join('')}`, TRY_AGAIN);
    }
    try {
      await ports.terminal.restart(panelId);
    } catch (error) {
      console.warn(`[ChatTabs] Could not restart ${panelId} on ${conversation.id}: ${reasonOf(error)}`);
      throw new PaneError('CHAT_SWITCH_FAILED', `${cause}. The terminal did not start again (${firstSentence(reasonOf(error))}), so it is stopped. Its conversation (${shortId(conversation.id)}) is saved.${leftover.join('')}`, TRY_AGAIN);
    }
    console.log(`[ChatTabs] Restarted ${panelId} on its conversation ${conversation.id} after the failed switch.`);
    throw new PaneError('CHAT_SWITCH_FAILED', `${cause}. The terminal is back on the same conversation (${shortId(conversation.id)}), with its history.${leftover.join('')}`, TRY_AGAIN_OR_TERMINAL);
  };

  let chatId: string;
  try { chatId = await ports.chat.create(panel, chatState); }
  catch (error) { return fail(reasonOf(error)); }
  try { await ports.chat.start(chatId); }
  catch (error) { return fail(reasonOf(error), chatId); }
  const banner = ports.chat.banner(chatId);
  const outcome: ChatTabSwitchResult['outcome'] = banner?.kind === 'most-recent' ? 'most-recent' : banner ? 'new' : 'known';

  // The chat holds the conversation now. Only a chat that nothing depends on may be removed.
  let adoption: SessionAdoption;
  try { adoption = await ports.adoptSessionPanel(panelId, chatId); }
  catch (error) {
    console.warn(`[ChatTabs] Could not tell who owns the Session of ${panelId}: ${reasonOf(error)}`);
    return { panelId: chatId, terminalKept: true, outcome, reason: `The conversation is open in the chat tab, but Pane could not tell whether the Session moved to it: ${reasonOf(error)}. Keep both tabs, and restart Pane before closing either one.` };
  }
  if (adoption.owner === 'terminal') {
    if (adoption.chatReleased) return fail(`the Session could not move to the chat (${adoption.reason})`, chatId);
    console.warn(`[ChatTabs] Session of ${panelId} stayed on its terminal, and chat ${chatId} could not be released: ${adoption.reason}`);
    return { panelId: chatId, terminalKept: true, outcome, reason: `The conversation is open in the chat tab, but the Session could not move to it, and the tab could not be removed: ${adoption.reason}. Keep both tabs, and restart Pane before closing either one.` };
  }
  await ports.chat.activate(chatId).catch(error => console.warn(`[ChatTabs] Could not show ${chatId}: ${reasonOf(error)}`));
  try { await ports.terminal.close(panelId); }
  catch (error) {
    console.warn(`[ChatTabs] Could not close ${panelId} after the switch: ${reasonOf(error)}`);
    return { panelId: chatId, terminalKept: true, outcome, reason: `The conversation continues in the chat tab, but the terminal tab could not be closed: ${reasonOf(error)}. Close it yourself; its agent is stopped.` };
  }
  return { panelId: chatId, terminalKept: false, outcome };
}
