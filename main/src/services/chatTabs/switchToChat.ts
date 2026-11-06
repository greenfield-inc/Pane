import type { ToolPanel, TerminalPanelState } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabSwitchResult } from '../../../../shared/types/chatTab';
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
 * The conversation a terminal is running, only from an ID tied to that terminal: the one Pane
 * started or resumed it with, or the one its launch reported (Agent Farm). Pane never infers it
 * from the folder, since another terminal there can be writing a different conversation.
 */
export function terminalConversation(state: Pick<TerminalPanelState, 'agentType' | 'agentSessionId'>, reportedId: string | undefined): { id: string } | { problem: string } {
  const id = state.agentSessionId ?? reportedId;
  if (id) return { id };
  return { problem: state.agentType === 'codex' ? 'Codex reports its conversation ID only when it exits, and this terminal has not reported one yet' : 'this terminal has no saved conversation ID' };
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
    /** The ID of the conversation this terminal is running, or why it is not known. Sends the agent nothing. */
    conversationId(panelId: string): Promise<{ id: string } | { problem: string }>;
    /** Ends the agent once it is idle, with its conversation saved. */
    stop(panelId: string): Promise<void>;
    /** Starts the agent again on the same conversation, and waits until it is ready. */
    restart(panelId: string): Promise<void>;
    close(panelId: string): Promise<void>;
  };
  chat: {
    /** Adds a chat tab right after the terminal it replaces, in that tab's position, not yet shown or started. */
    create(replaces: ToolPanel, state: ChatPanelState): Promise<string>;
    /** Starts its agent; throws a PaneError when it does not start or cannot load the conversation. */
    start(panelId: string): Promise<void>;
    close(panelId: string): Promise<void>;
    activate(panelId: string): Promise<void>;
  };
  /** A Session's orchestrator tab moves to the chat; any other tab has nothing to move. A throw means the owner is unknown. */
  adoptSessionPanel(fromPanelId: string, toPanelId: string): Promise<SessionAdoption>;
  /** The launch command a Session saved for its orchestrator tab; undefined for any other tab. */
  sessionLaunchCommand(panelId: string): string | undefined;
}

const RESUMED = 'Switched from a terminal tab. The conversation continues here.';
const NOTHING_SWITCHED = 'Keep working in the terminal.';

/**
 * Switch to chat (D-129, D-184): reopens a terminal Claude or Codex tab's conversation in a chat
 * tab with ACP session/load, or fails cleanly: the actual reason, in the log and to the person, the
 * terminal running the same conversation again, and no chat tab left behind. It never sends
 * anything to the person's agent.
 */
export async function switchToChat(panelId: string, ports: SwitchToChatPorts): Promise<ChatTabSwitchResult> {
  if (!ports.chatTabsEnabled()) throw new PaneError('CHAT_TABS_DISABLED', 'Chat tabs are turned off on this machine. Nothing was switched.', 'Turn on Chat tabs in Settings > Advanced > Experimental, then try again.');
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
  const conversation = await ports.terminal.conversationId(panelId);
  if ('problem' in conversation) {
    console.warn(`[ChatTabs] Did not switch ${panelId} to chat: ${conversation.problem}.`);
    throw new PaneError('CHAT_SWITCH_NO_CONVERSATION', `Pane could not tell which conversation this terminal is running: ${conversation.problem}. Nothing was switched.`, NOTHING_SWITCHED);
  }
  const chatState: ChatPanelState = { agent, launch: converted.launch, cwd, status: 'starting', acpSessionId: conversation.id, notice: RESUMED };
  if (converted.settings) chatState.settings = converted.settings;
  if (state.orchestrationSessionId) chatState.orchestrationSessionId = state.orchestrationSessionId;
  if (state.sessionFolder) chatState.sessionFolder = state.sessionFolder;

  try { await ports.terminal.stop(panelId); }
  catch (error) { throw new PaneError('CHAT_SWITCH_BUSY', `The agent could not be stopped cleanly: ${reasonOf(error)}. Nothing was switched.`, 'Wait for it to finish, or stop it (Esc in the terminal), then switch again.'); }

  /** The clean failure: says why, leaves no chat tab, and brings the terminal back. */
  const fail = async (reason: string, next: string, chatId?: string): Promise<never> => {
    console.warn(`[ChatTabs] Could not reopen conversation ${conversation.id} of ${panelId} in a chat: ${reason}`);
    const notes: string[] = [];
    if (chatId) {
      await ports.chat.close(chatId).catch(error => {
        console.warn(`[ChatTabs] Could not remove chat tab ${chatId}: ${reasonOf(error)}`);
        notes.push('Close the leftover chat tab yourself.');
      });
    }
    try {
      await ports.terminal.restart(panelId);
      notes.unshift('The terminal is running the same conversation again.');
    } catch (error) {
      console.warn(`[ChatTabs] Could not restart ${panelId}: ${reasonOf(error)}`);
      notes.unshift(`The terminal did not start again (${reasonOf(error)}); its conversation is saved.`);
    }
    throw new PaneError('CHAT_SWITCH_FAILED', `Pane could not reopen this conversation in a chat: ${reason}. ${notes.join(' ')}`, next);
  };

  let chatId: string;
  try { chatId = await ports.chat.create(panel, chatState); }
  catch (error) { return fail(reasonOf(error), NOTHING_SWITCHED); }
  try { await ports.chat.start(chatId); }
  catch (error) {
    // A stopped chat's own next step (Restart, Retry) is about a tab that is being removed.
    const next = error instanceof PaneError && error.next && !/\b(restart|retry)\b/i.test(error.next) ? error.next : NOTHING_SWITCHED;
    return fail(reasonOf(error), next, chatId);
  }

  // The chat holds the conversation now. Only a chat that nothing depends on may be removed.
  let adoption: SessionAdoption;
  try { adoption = await ports.adoptSessionPanel(panelId, chatId); }
  catch (error) {
    console.warn(`[ChatTabs] Could not tell who owns the Session of ${panelId}: ${reasonOf(error)}`);
    return { panelId: chatId, terminalKept: true, reason: `The conversation is open in the chat tab, but Pane could not tell whether the Session moved to it: ${reasonOf(error)}. Keep both tabs, and restart Pane before closing either one.` };
  }
  if (adoption.owner === 'terminal') {
    if (adoption.chatReleased) return fail(`the Session could not move to the chat (${adoption.reason})`, NOTHING_SWITCHED, chatId);
    console.warn(`[ChatTabs] Session of ${panelId} stayed on its terminal, and chat ${chatId} could not be released: ${adoption.reason}`);
    return { panelId: chatId, terminalKept: true, reason: `The conversation is open in the chat tab, but the Session could not move to it, and the tab could not be removed: ${adoption.reason}. Keep both tabs, and restart Pane before closing either one.` };
  }
  await ports.chat.activate(chatId).catch(error => console.warn(`[ChatTabs] Could not show ${chatId}: ${reasonOf(error)}`));
  try { await ports.terminal.close(panelId); }
  catch (error) {
    console.warn(`[ChatTabs] Could not close ${panelId} after the switch: ${reasonOf(error)}`);
    return { panelId: chatId, terminalKept: true, reason: `The conversation continues in the chat tab, but the terminal tab could not be closed: ${reasonOf(error)}. Close it yourself; its agent is stopped.` };
  }
  return { panelId: chatId, terminalKept: false };
}
