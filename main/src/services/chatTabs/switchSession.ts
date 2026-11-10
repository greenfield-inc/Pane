import type { ToolPanel } from '../../../../shared/types/panels';
import type { SessionChatSwitchItem, SessionChatSwitchOutcome, SessionChatSwitchPreview, SessionChatSwitchResult, SessionChatSwitchSkip } from '../../../../shared/types/chatTab';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { prepareSwitch, switchPrepared, type PreparedSwitch, type SwitchToChatPorts } from './switchToChat';

/** What a whole-Session switch needs beyond one tab's switch. */
export interface SessionSwitchPorts extends SwitchToChatPorts {
  /** The Session's terminal tabs, its own Pane's first, then each of its Panes'; undefined when there is no such Session. */
  sessionTerminals(sessionId: string): Array<{ panel: ToolPanel; paneName: string }> | undefined;
}

/** The short kind of each refusal `prepareSwitch` can make before it touches the agent. */
function skipKind(code: string | undefined, panel: ToolPanel): SessionChatSwitchSkip {
  if (code === 'CHAT_SWITCH_BUSY') return 'busy';
  if (code === 'CHAT_SWITCH_UNSUPPORTED') return 'not-agent';
  if (code === 'CHAT_SWITCH_LAUNCH_UNSUPPORTED') return 'launch';
  if (code === 'CHAT_SWITCH_NO_CONVERSATION') {
    // SAFETY: only terminal panels reach this refusal, and they persist TerminalPanelState.
    const agent = (panel.state.customState as { agentType?: string } | undefined)?.agentType;
    return agent === 'codex' ? 'plain-codex' : 'no-conversation';
  }
  return 'other';
}

function terminalsOf(sessionId: string, ports: SessionSwitchPorts): Array<{ panel: ToolPanel; paneName: string }> {
  const terminals = ports.sessionTerminals(sessionId);
  if (!terminals) throw new PaneError('CHAT_SESSION_MISSING', 'That Session no longer exists. Nothing was switched.', 'Pick the Session again in the sidebar.');
  return terminals;
}

/** One tab's checks, as the switch makes them: the prepared switch, or why it will not switch. */
async function check(panel: ToolPanel, paneName: string, ports: SessionSwitchPorts): Promise<{ item: SessionChatSwitchItem; prepared?: PreparedSwitch }> {
  const item: SessionChatSwitchItem = { panelId: panel.id, title: panel.title, paneName };
  try {
    return { item, prepared: await prepareSwitch(panel.id, ports) };
  } catch (error) {
    // The preview and the summary already say the tab is skipped.
    const reason = reasonOf(error).replace(/\s*Nothing was switched\.?$/, '');
    return { item: { ...item, skip: { kind: skipKind(error instanceof PaneError ? error.code : undefined, panel), reason } } };
  }
}

/**
 * What Switch to chat would do to every terminal tab of a Session: its orchestrator and the tabs
 * of its Panes. Runs each tab's own checks and sends no agent anything.
 */
export async function previewSessionSwitch(sessionId: string, ports: SessionSwitchPorts): Promise<SessionChatSwitchPreview> {
  const items: SessionChatSwitchItem[] = [];
  // One at a time, like the switch itself.
  for (const { panel, paneName } of terminalsOf(sessionId, ports)) items.push((await check(panel, paneName, ports)).item);
  return { sessionId, items };
}

/**
 * Switches a Session's tabs to chat one by one through the single-tab switch, so each one that
 * fails is put back the way that switch puts it back, and the rest carry on. `panelIds` limits it
 * to the tabs the person confirmed; any others are reported as skipped.
 */
export async function switchSessionToChat(sessionId: string, panelIds: readonly string[] | undefined, ports: SessionSwitchPorts): Promise<SessionChatSwitchResult> {
  const items: SessionChatSwitchOutcome[] = [];
  for (const { panel, paneName } of terminalsOf(sessionId, ports)) {
    // Checked just before its own switch: the tabs before it took time, and an agent may have started a turn.
    const { item, prepared } = await check(panel, paneName, ports);
    if (!prepared) { items.push({ ...item, result: 'skipped' }); continue; }
    if (panelIds && !panelIds.includes(item.panelId)) {
      items.push({ ...item, result: 'skipped', skip: { kind: 'unconfirmed', reason: 'It was not on the list when you confirmed (it was busy then, or opened later), so it was left as it is. Switch it from its tab\'s menu.' } });
      continue;
    }
    try {
      const switched = await switchPrepared(prepared, ports);
      items.push(switched.reason ? { ...item, result: 'switched', note: switched.reason } : { ...item, result: 'switched' });
    } catch (error) {
      console.warn(`[ChatTabs] Session ${sessionId}: ${item.panelId} did not switch to chat: ${reasonOf(error)}`);
      items.push({ ...item, result: 'failed', skip: { kind: skipKind(error instanceof PaneError ? error.code : undefined, prepared.panel), reason: reasonOf(error) } });
    }
  }
  return { sessionId, items };
}
