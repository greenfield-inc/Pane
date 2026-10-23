import { randomUUID } from 'crypto';
import type { ToolPanel } from '../../../shared/types/panels';
import type { RunpanePanelStateSummary, RunpanePanelSubmitResult, RunpanePanelWaitRequest, RunpanePanelWaitResult, RunpanePanelLastMessageResult } from '../../../shared/types/runpaneOrchestration';
import { PaneError } from '../../../shared/paneError';
import { agentChatManager } from '../services/agentChat/agentChatManager';
import type { AgentChatView } from '../../../shared/types/agentChat';

export function assertRawTerminal(panelId: string): void {
  const mode = agentChatManager.mode(panelId);
  if (mode && mode !== 'terminal' && !agentChatManager.isNativeStarting(panelId)) throw new PaneError('CHAT_RAW_TERMINAL_UNSUPPORTED', `This conversation is ${mode === 'chat' ? 'in Chat' : 'stopped'}. No live native terminal screen or composer is available.`, 'Use panels submit, wait or last-message, or switch to Terminal.');
}

function chatState(view: AgentChatView): RunpanePanelStateSummary {
  const running = view.conversation?.active === 'chat';
  return { initialized: running, running, isCliPanel: true, isCliReady: running && !view.conversation?.transition, agentType: view.conversation?.provider, activityStatus: view.running || view.permissions.length ? 'active' : 'idle' };
}

export function chatText(view: AgentChatView): string {
  return (view.transcript?.messages ?? []).map(message => `${message.role}: ${message.parts.flatMap(part => part.type === 'text' ? [part.text] : part.type === 'tool' ? [`[${part.title}: ${part.status}]`] : []).join('\n')}`).join('\n\n');
}

export async function submitChat(panel: ToolPanel, text: string, interrupt: boolean, operationId: string = randomUUID()): Promise<RunpanePanelSubmitResult> {
  let view = agentChatManager.view(panel.id);
  const generation = view.conversation?.generation ?? 0;
  if (interrupt && view.running) {
    await agentChatManager.cancel(panel.id, generation);
    const deadline = Date.now() + 30_000;
    while (view.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      view = agentChatManager.view(panel.id);
    }
    if (view.running) throw new PaneError('CHAT_CANCEL_UNCONFIRMED', 'The active turn has not finished cancellation. No replacement prompt was sent.', 'Wait for the turn to stop, then retry explicitly.');
  }
  const receipt = agentChatManager.send(panel.id, { operationId, generation, text });
  return {
    ok: receipt.state !== 'failed', panelId: panel.id, paneId: panel.sessionId, inputBytes: Buffer.byteLength(text),
    enter: 'none', sequenceName: 'acp', verifiedSubmitted: true, verification: 'observed',
    delivery: { state: 'taken', evidence: 'acp-receipt', message: 'The owning host durably accepted this operation.' },
    operationId: receipt.operationId, sentAt: new Date().toISOString(), nextCommand: `runpane panels wait --panel ${panel.id} --for idle --json`,
  };
}

export function chatLastMessage(panel: ToolPanel, limit: number): RunpanePanelLastMessageResult {
  const view = agentChatManager.view(panel.id);
  if (view.error) throw new PaneError('CHAT_TURN_FAILED', view.error, 'Inspect the conversation error and correct the provider setup before submitting a new turn.');
  const message = view.transcript?.messages.slice().reverse().find(entry => entry.role === 'assistant' && entry.parts.some(part => part.type === 'text'));
  if (!message || !view.conversation) return { ok: false, panelId: panel.id, paneId: panel.sessionId, reason: 'transcript-unavailable', message: 'No assistant reply is loaded. Recover the exact conversation or wait for its first reply.' };
  const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
  return { ok: true, panelId: panel.id, paneId: panel.sessionId, agentType: view.conversation.provider, text: text.slice(-limit), length: text.length, limit, truncated: text.length > limit };
}

export async function waitForChat(panel: ToolPanel, request: RunpanePanelWaitRequest): Promise<RunpanePanelWaitResult> {
  const started = Date.now(), timeout = request.timeoutMs ?? 30_000, interval = request.intervalMs ?? 250;
  const condition = request.condition ?? 'idle';
  while (true) {
    const view = agentChatManager.view(panel.id);
    if (view.error) throw new PaneError('CHAT_TURN_FAILED', view.error, 'Inspect the conversation error and correct the provider setup before submitting a new turn.');
    const state = chatState(view), text = chatText(view);
    const blocked = view.permissions.length ? { kind: 'agent-prompt' as const, message: view.permissions.map(permission => permission.title).join('; ') + '. Answer the exact request in Chat.' } : undefined;
    const matched = condition === 'text' ? text.includes(request.contains ?? '') : condition === 'initialized' ? state.initialized : state.running && !view.running && !blocked && !view.conversation?.transition;
    const timedOut = !matched && Date.now() - started >= timeout;
    if (matched || timedOut || blocked || !state.running) return {
      ok: matched && !blocked, panelId: panel.id, paneId: panel.sessionId, condition, matched, timedOut, elapsedMs: Date.now() - started, state, blocked, stopped: !state.running ? true : undefined,
      // The legacy field is explicitly tagged as a transcript, never a terminal screen.
      screen: { source: 'acpTranscript', text: text.slice(-20_000), hasMore: text.length > 20_000 },
      nextCommand: `runpane panels ${state.running ? 'last-message' : 'resume'} --panel ${panel.id} --json`,
    };
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(25, interval), timeout - (Date.now() - started))));
  }
}
