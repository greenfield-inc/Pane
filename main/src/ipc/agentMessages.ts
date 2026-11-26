import { PaneError } from '../../../shared/paneError';
import {
  AGENT_MESSAGES_FOR_PANEL_CHANNEL, messageRef, parseMessageRef,
  type AgentMessageRecord, type RunpaneMessageListResult, type RunpaneMessageShowResult, type RunpaneMessageWaitResult, type RunpaneReplyResult,
} from '../../../shared/types/agentMessages';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { paneCommandCaller, paneCommandSignal, type IpcMainHandleLike, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { AgentMessageService } from '../services/agentMessages/agentMessageService';

interface AgentMessageHandlerServices {
  agentMessageService?: AgentMessageService;
}

/** The most messages one read of a tab's messages returns; `before` pages further back. */
const FOR_PANEL_PAGE = 200;

/** The longest `--await-reply` waits without a `--timeout`: a day. */
const DEFAULT_WAIT_MS = 24 * 60 * 60_000;

const optionalString = boundary.optional(boundary.string);

function requireService(services: AgentMessageHandlerServices): AgentMessageService {
  if (!services.agentMessageService) {
    throw new PaneError('ERR_MESSAGES_UNAVAILABLE', 'Messages are unavailable: this Pane has not started its message service. Nothing was changed.', 'Restart Pane, then run the command again.');
  }
  return services.agentMessageService;
}

function requireRef(value: string): number {
  const number = parseMessageRef(value);
  if (number === undefined) {
    throw new PaneError('ERR_RUNPANE_INVALID_ARGUMENT', `"${value}" is not a message id; a message id is M-12.`, 'Copy the id from the message\'s reply line, or see recent ones with `runpane messages list`.');
  }
  return number;
}

function callerPanel(requested: string | undefined): string | undefined {
  return requested ?? paneCommandCaller()?.panelId;
}

/**
 * `runpane reply`, `runpane messages list|show|wait` (agents), and the app's read of a tab's
 * messages (T-104; T-105 draws them). docs/AGENT_MESSAGES.md has the shapes.
 */
export function registerAgentMessageHandlers(ipcMain: IpcMainHandleLike, services: AgentMessageHandlerServices, commandRegistry: PaneCommandRegistry): void {
  const service = () => requireService(services);

  commandRegistry.register('runpane:reply', async (value: PaneCommandValue): Promise<RunpaneReplyResult> => {
    const request = decodeBoundary(value, boundary.object({ message: boundary.string, text: boundary.string, callerPanelId: optionalString }));
    const result = await service().reply({ to: requireRef(request.message), body: request.text, callerPanelId: callerPanel(request.callerPanelId) });
    const next = result.delivery === 'queued'
      ? `Pane types it into ${result.reply.receiver.name}'s tab at its next prompt. Check with runpane messages show ${result.reply.replyTo ?? result.reply.ref}.`
      : result.delivery === 'undelivered' ? `It can't reach ${result.reply.receiver.name}: ${result.reply.undeliveredReason ?? 'its tab is gone'}. Pass it on another way, such as runpane notify.` : undefined;
    return next ? { ok: true, ...result, next } : { ok: true, ...result };
  });

  commandRegistry.register('runpane:messages:list', (value: PaneCommandValue): RunpaneMessageListResult => {
    const request = decodeBoundary(value ?? {}, boundary.object({ panelId: optionalString, all: boundary.optional(boundary.boolean), limit: boundary.optional(boundary.number), callerPanelId: optionalString }));
    // A tab sees its own messages unless it asks for all of them.
    const panelId = request.all ? undefined : request.panelId ?? callerPanel(request.callerPanelId);
    return { ok: true, messages: service().list({ panelId, limit: request.limit }) };
  });

  commandRegistry.register('runpane:messages:show', (value: PaneCommandValue): RunpaneMessageShowResult => {
    const request = decodeBoundary(value, boundary.object({ message: boundary.string }));
    return { ok: true, ...service().show(requireRef(request.message)) };
  });

  commandRegistry.register('runpane:messages:wait', async (value: PaneCommandValue): Promise<RunpaneMessageWaitResult> => {
    const request = decodeBoundary(value, boundary.object({ message: boundary.string, timeoutMs: boundary.optional(boundary.number) }));
    const number = requireRef(request.message);
    const reply: AgentMessageRecord | undefined = await service().waitForReply(number, request.timeoutMs ?? DEFAULT_WAIT_MS, paneCommandSignal());
    if (reply) return { ok: true, message: messageRef(number), outcome: 'reply', reply };
    return {
      ok: false, message: messageRef(number), outcome: 'timeout',
      next: `No reply yet. Pane types one into this tab when it comes (reply: ${messageRef(number)} → …); or wait again with runpane messages wait ${messageRef(number)}.`,
    };
  });

  // The app: one tab's messages, sent and received, for its chat and terminal history (T-105). A page is at most
  // 200, newest first; `before` (the oldest ref the app has, "M-12", or its number) reads the page older than it.
  commandRegistry.register(AGENT_MESSAGES_FOR_PANEL_CHANNEL, (value: PaneCommandValue, options: PaneCommandValue) => {
    try {
      const panelId = decodeBoundary(value, boundary.string);
      const page = decodeBoundary(options ?? {}, boundary.object({ before: boundary.optional(boundary.union(boundary.string, boundary.number)), limit: boundary.optional(boundary.number) }));
      const before = page.before === undefined ? undefined : requireRef(String(page.before));
      const limit = Math.max(1, Math.min(page.limit ?? FOR_PANEL_PAGE, FOR_PANEL_PAGE));
      return { success: true, data: service().list({ panelId, limit, before }) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  commandRegistry.bindChannels(ipcMain, [AGENT_MESSAGES_FOR_PANEL_CHANNEL]);
}
