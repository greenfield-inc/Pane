import { randomUUID } from 'crypto';
import type { ToolPanel } from '../../../shared/types/panels';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type {
  RunpanePanelBlockedState, RunpanePanelLastMessageResult, RunpanePanelOutputResult, RunpanePanelScreenResult,
  RunpanePanelStateSummary, RunpanePanelSubmitResult, RunpanePanelWaitRequest, RunpanePanelWaitResult,
} from '../../../shared/types/runpaneOrchestration';
import { PaneError } from '../../../shared/paneError';
import type { ChatTabManager } from '../services/chatTabs/manager';

/**
 * runpane on chat tabs (package 5): the same commands orchestrators use on
 * terminal agent tabs, answered from the host's ACP session. Nothing here
 * copies the whole transcript per poll: state comes from the view without its
 * transcript, and text is read only when a command returns it.
 */

export function chatTabNoTerminal(panel: ToolPanel, command: 'input' | 'submit-composer'): PaneError {
  return new PaneError('CHAT_TAB_NO_TERMINAL', `Panel ${panel.id} is a chat tab, which has no terminal, so \`panels ${command}\` sent nothing.`, `Send a prompt with \`runpane panels submit --panel ${panel.id} --text "<message>"\`.`);
}

function messageText(message: AgentChatMessage): string {
  return message.parts.flatMap(part => {
    if (part.type === 'text') return [part.text];
    if (part.type === 'tool') return [`[${part.title}: ${part.status}]`];
    return [];
  }).join('\n');
}

/** The newest `chars` characters of the conversation, as "role: text" blocks, read backwards a page at a time. */
interface TranscriptTail { text: string; hasMore: boolean }

function transcriptTail(manager: ChatTabManager, panelId: string, chars: number): TranscriptTail {
  const blocks: string[] = [];
  let length = 0;
  let before = manager.view(panelId, 0, false).messageCount;
  while (before > 0 && length < chars) {
    const page = manager.history(panelId, before, 100);
    if (!page.length) break;
    for (let index = page.length - 1; index >= 0 && length < chars; index--) {
      const block = `${page[index].role}: ${messageText(page[index])}`;
      blocks.unshift(block);
      length += block.length + 2;
    }
    before -= page.length;
  }
  const text = blocks.join('\n\n');
  return { text: text.slice(-chars), hasMore: length > chars || before > 0 };
}

/** Whether something the agent wrote from index `since` up to `count` contains `text`, read a page at a time. */
function textSince(manager: ChatTabManager, panelId: string, since: number, count: number, text: string): boolean {
  for (let before = count; before > since;) {
    const page = manager.history(panelId, before, before - since);
    if (!page.length) return false;
    if (page.some(message => message.role !== 'user' && messageText(message).includes(text))) return true;
    before -= page.length;
  }
  return false;
}

function chatTabState(view: ChatTabView): RunpanePanelStateSummary {
  const running = view.status !== 'stopped';
  return {
    initialized: view.status !== 'starting', running, isCliPanel: true, isCliReady: view.status === 'idle', agentType: view.agent,
    activityStatus: view.status === 'working' || view.status === 'blocked' || view.status === 'starting' ? 'active' : 'idle',
  };
}

function blockedState(panel: ToolPanel, view: ChatTabView): RunpanePanelBlockedState | undefined {
  if (view.permissions.length) return { kind: 'agent-prompt', message: `${view.permissions.map(permission => permission.title).join('; ')}. Answer it in the chat tab, in Notify or on the phone.` };
  if (view.questions.length) return { kind: 'agent-prompt', message: `${view.questions.map(question => question.message).join('; ')}. Answer it in the chat tab, in Notify or on the phone.` };
  if (view.status === 'stopped' && view.problem) return { kind: 'unknown', message: `${view.problem.message} ${view.problem.next}`, suggestedCommand: `runpane panels resume --panel ${panel.id} --json` };
  return undefined;
}

export function chatTabScreen(manager: ChatTabManager, panel: ToolPanel, limit: number): RunpanePanelScreenResult {
  const view = manager.view(panel.id, 0);
  const lines = transcriptTail(manager, panel.id, 200_000).text.split('\n');
  const shown = lines.slice(-limit);
  return {
    ok: true, panelId: panel.id, paneId: panel.sessionId, source: 'acpTranscript', limit,
    returnedLineCount: shown.length, hasMore: lines.length > shown.length, text: shown.join('\n'),
    state: chatTabState(view), composer: { isPresent: view.status !== 'stopped', hasUndeliveredText: false },
    nextCommand: `runpane panels last-message --panel ${panel.id} --json`,
  };
}

export function chatTabOutput(manager: ChatTabManager, panel: ToolPanel, limit: number): RunpanePanelOutputResult {
  const { text, hasMore } = transcriptTail(manager, panel.id, Math.min(limit * 1000, 200_000));
  return { ok: true, panelId: panel.id, paneId: panel.sessionId, limit, returnedCount: text ? 1 : 0, hasMore, outputs: text ? [{ type: 'acp-transcript', data: text, timestamp: new Date().toISOString() }] : [], text };
}

export async function submitChatTab(manager: ChatTabManager, panel: ToolPanel, text: string, options: { interrupt: boolean; operationId?: string }): Promise<RunpanePanelSubmitResult> {
  const operationId = options.operationId ?? randomUUID();
  if (options.interrupt && manager.isRunning(panel.id)) {
    const view = manager.view(panel.id, 0, false);
    if (view.status === 'working' || view.status === 'blocked') {
      await manager.cancel(panel.id);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && ['working', 'blocked'].includes(manager.view(panel.id, 0, false).status)) await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const receipt = manager.send(panel.id, { operationId, text });
  const queued = manager.view(panel.id, 0, false).queue.some(item => item.operationId === operationId);
  return {
    ok: receipt.state !== 'failed', panelId: panel.id, paneId: panel.sessionId, inputBytes: Buffer.byteLength(text),
    enter: 'none', sequenceName: 'acp', verifiedSubmitted: true, verification: 'observed',
    delivery: queued
      ? { state: 'queued', evidence: 'acp-receipt', message: 'The agent is working; Pane queued this prompt and sends it when the turn ends. Do not resend it.' }
      : { state: 'taken', evidence: 'acp-receipt', message: 'The host accepted this prompt for the agent.' },
    operationId: receipt.operationId, sentAt: new Date().toISOString(), nextCommand: `runpane panels wait --panel ${panel.id} --for idle --json`,
  };
}

export function chatTabLastMessage(manager: ChatTabManager, panel: ToolPanel, limit: number): RunpanePanelLastMessageResult {
  const view = manager.view(panel.id, 0);
  const message = manager.lastMessage(panel.id, 'assistant', entry => entry.parts.some(part => part.type === 'text' && part.text.trim().length > 0));
  if (!message) return { ok: false, panelId: panel.id, paneId: panel.sessionId, reason: 'transcript-unavailable', message: view.status === 'starting' ? 'The chat tab is still starting; wait for it, then ask again.' : 'The agent has not replied yet.' };
  const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
  return { ok: true, panelId: panel.id, paneId: panel.sessionId, agentType: view.agent, text: text.slice(-limit), length: text.length, limit, truncated: text.length > limit };
}

/** `ready`/`idle`: a turn ended and nothing is queued. A pending approval or question returns at once as blocked. */
export async function waitForChatTab(manager: ChatTabManager, panel: ToolPanel, request: RunpanePanelWaitRequest): Promise<RunpanePanelWaitResult> {
  const started = Date.now();
  const timeout = request.timeoutMs ?? 30_000;
  const interval = Math.max(25, request.intervalMs ?? 250);
  const condition = request.condition ?? 'idle';
  // Text waits search only what the agent writes after the wait starts, plus a reply still streaming
  // then, so no prompt (sent or queued) and no finished reply matches, and no poll rereads the transcript.
  const start = manager.view(panel.id, 0, false);
  const streaming = start.status === 'working' || start.status === 'blocked';
  const since = streaming && start.messageCount > 0 ? start.messageCount - 1 : start.messageCount;
  while (true) {
    const view = manager.view(panel.id, 0);
    const state = chatTabState(view);
    const blocked = blockedState(panel, view);
    const idle = view.status === 'idle' && view.queue.length === 0;
    const matched = condition === 'text'
      ? textSince(manager, panel.id, since, view.messageCount, request.contains ?? '')
      : condition === 'initialized' ? state.initialized : idle;
    const timedOut = !matched && Date.now() - started >= timeout;
    if (matched || timedOut || blocked || view.status === 'stopped') {
      const screen = transcriptTail(manager, panel.id, 20_000);
      return {
        ok: matched && !blocked, panelId: panel.id, paneId: panel.sessionId, condition, matched, timedOut, elapsedMs: Date.now() - started, state, blocked,
        stopped: view.status === 'stopped' ? true : undefined,
        screen: { source: 'acpTranscript', text: screen.text, hasMore: screen.hasMore },
        nextCommand: view.status === 'stopped' ? `runpane panels resume --panel ${panel.id} --json` : `runpane panels last-message --panel ${panel.id} --json`,
      };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(25, timeout - (Date.now() - started)))));
  }
}
