import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive,
  SimpleImageAttachmentAdapter, useAuiState, useExternalStoreRuntime, useThreadViewport, useThreadViewportStore,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Plus, Square, X } from 'lucide-react';
import type { AgentChatMessage, AgentChatPermission } from '../../../../shared/types/agentChat';
import type { ChatTabClient, ChatTabSend } from '../../../../shared/types/chatTab';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { chatTabViewer, type ChatTabViewer } from '../../services/chatTabViewer';
import { toAssistantMessage } from '../agentChat/convertMessage';
import { AgentChatPermissions } from '../agentChat/AgentChatPermissions';
import { AgentChatConfiguration } from '../agentChat/AgentChatConfiguration';
import { MessageRow } from '../agentChat/AgentChatParts';
import { ChatPermissionContext } from '../agentChat/chatPermissionContext';
import { ChatProblem } from './ChatProblem';
import { ChatQuestionCard } from './ChatQuestionCard';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import '../agentChat/agentChat.css';
import './chatTab.css';

function Attachment() {
  return <AttachmentPrimitive.Root className="chat-attachment">
    <AttachmentPrimitive.unstable_Thumb /><AttachmentPrimitive.Name /><AttachmentPrimitive.Remove aria-label="Remove attachment"><X className="h-3 w-3" /></AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>;
}

class ChatImageAdapter extends SimpleImageAttachmentAdapter {
  override async add(input: { file: File }) {
    if (input.file.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MiB.');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
    return super.add(input);
  }
}

const turnMarker = boundary.object({ type: boundary.literal('pane_turn'), stopReason: boundary.string });
const STOPPED = new Map([
  ['cancelled', 'Stopped.'], ['interrupted', 'Stopped when Pane closed.'], ['exited', 'Stopped: the agent exited.'],
  ['refusal', 'The agent declined this request.'], ['max_tokens', 'Stopped at the length limit.'], ['max_turn_requests', 'Stopped at the step limit.'], ['error', 'Stopped by an error.'],
]);

/** Turn-end markers become a short line when a turn did not end normally; otherwise they are not shown. */
export function visibleMessages(messages: AgentChatMessage[]): AgentChatMessage[] {
  return messages.flatMap(message => {
    const part = message.parts[0];
    const marker = message.parts.length === 1 && part?.type === 'content' ? decodeOptionalBoundary(part.content, turnMarker) : undefined;
    if (!marker) return [message];
    if (marker.stopReason === 'end_turn') return [];
    return [{ ...message, parts: [{ type: 'text', text: `_${STOPPED.get(marker.stopReason) ?? 'Stopped.'}_` }] }];
  });
}

function ScrollToLatest() {
  const isAtBottom = useThreadViewport(state => state.isAtBottom);
  const viewport = useThreadViewportStore();
  return <button type="button" disabled={isAtBottom} onClick={() => viewport.getState().scrollToBottom({ behavior: 'instant' })} className="chat-latest" aria-label="Scroll to latest message"><ArrowDown className="h-4 w-4" /></button>;
}

function Viewport({ viewer, loading }: { viewer: ChatTabViewer; loading: boolean }) {
  const messages = useAuiState(state => state.thread.messages);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const earlier = snapshot.transcript?.start ?? 0;
  return <ThreadPrimitive.Viewport aria-label="Conversation messages" role="region" className="chat-viewport" scrollToBottomOnRunStart={false}>
    <div className="chat-column">
      <ThreadPrimitive.Empty><p className="py-8 text-sm text-text-tertiary">{loading ? 'Loading conversation…' : ''}</p></ThreadPrimitive.Empty>
      {earlier > 0 && <button type="button" className="chat-button chat-button-outline self-center" disabled={snapshot.loadingEarlier} onClick={() => void viewer.loadEarlier()}>
        {snapshot.loadingEarlier ? 'Loading…' : `Earlier messages (${earlier})`}
      </button>}
      {messages.map((message, index) => <ThreadPrimitive.MessageByIndex key={message.id} index={index} components={{ Message: MessageRow }} />)}
    </div>
  </ThreadPrimitive.Viewport>;
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

/** A chat tab: one agent conversation over ACP, with no terminal (D-20). */
export default function ChatTabPanel({ panelId, client, connected = true }: { panelId: string; client: ChatTabClient; connected?: boolean }) {
  const viewer = useMemo(() => chatTabViewer(client, panelId), [client, panelId]);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const view = snapshot.view;
  const [busy, setBusy] = useState(false);
  const messages = useMemo(() => visibleMessages(snapshot.transcript?.messages ?? []), [snapshot.transcript?.messages]);
  const images = useMemo(() => new ChatImageAdapter(), []);
  const stopped = view?.status === 'stopped';
  const disabled = !connected || stopped || !view;

  const deliver = async (request: ChatTabSend, retry: boolean) => {
    viewer.setPendingDelivery(request);
    try {
      const receipt = retry ? await client.send(panelId, request) : await client.receipt(panelId, request.operationId);
      if (!receipt) { viewer.setError('Pane has no record of that message yet. Retry sends it once, with the same ID.'); return; }
      viewer.setPendingDelivery(undefined);
      viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
      if (receipt.state !== 'failed') { viewer.setDraft(''); runtime.thread.composer.setText(''); }
    } catch (error) {
      viewer.setError(`${ipcErrorMessage(error, 'The message may not have been sent.')} Check delivery before sending again.`);
    }
  };

  const runtime = useExternalStoreRuntime({
    messages, convertMessage: toAssistantMessage,
    // The host queues a message sent while the agent works, so the composer never locks
    // for a running turn; Stop is Pane's own button below.
    isRunning: false,
    isLoading: !snapshot.transcript && view?.status !== 'stopped',
    // A message sent while the agent works is queued on the host and sent next.
    isSendDisabled: disabled || !!snapshot.pendingDelivery,
    unstable_persistsHistory: true, unstable_enableToolInvocations: false,
    adapters: view?.canAttachImages ? { attachments: images } : undefined,
    onNew: async message => {
      const parts = [...message.content, ...(message.attachments ?? []).flatMap(attachment => attachment.content)];
      const text = parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
      const imageParts = parts.flatMap(part => {
        if (part.type !== 'image') return [];
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(part.image);
        if (!match) throw new Error('This image could not be read. Attach it again.');
        return [{ mimeType: match[1], data: match[2] }];
      });
      viewer.setDraft(text);
      // The composer clears before onNew; keep the text until the host confirms it.
      runtime.thread.composer.setText(text);
      await deliver({ operationId: crypto.randomUUID(), text, images: imageParts }, true);
    },
  });
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);

  const act = async <Result,>(operation: () => Promise<Result>) => {
    setBusy(true);
    try { await operation(); viewer.setError(undefined); } catch (error) { viewer.setError(ipcErrorMessage(error, 'Pane did not say why.')); } finally { setBusy(false); }
  };
  const answerPermission = (permission: AgentChatPermission, optionId: string) => act(() => client.permission(panelId, permission.id, optionId));
  const agentName = view ? AGENT_NAMES[view.agent] : 'the agent';

  return <AssistantRuntimeProvider runtime={runtime}>
    {/* Approvals dock above the composer (round 2), so tool rows never repeat them. */}
    <ChatPermissionContext.Provider value={{ permissions: [], disabled: true, onAnswer: answerPermission }}>
      <ThreadPrimitive.Root className="agent-chat chat-tab flex h-full min-h-0 flex-col" data-status={view?.status ?? 'starting'}>
        {view?.problem && <ChatProblem problem={view.problem} agent={agentName} busy={busy || !connected}
          onRestart={() => act(() => client.restart(panelId))}
          onSignIn={() => act(() => client.signIn(panelId))}
          onInstall={url => void window.electronAPI.openExternal(url)} />}
        {snapshot.error && <div role="alert" className="chat-alert">{snapshot.error}</div>}
        {view?.notice && <p role="status" className="chat-notice">{view.notice}</p>}
        {view?.status === 'starting' && !snapshot.transcript && <p role="status" className="chat-notice">Starting {agentName}…</p>}
        <Viewport viewer={viewer} loading={!snapshot.transcript} />
        <div className="chat-composer-footer">
          <ScrollToLatest />
          {snapshot.pendingDelivery && <div className="chat-dock" role="status">
            <span>Delivery is unconfirmed.</span>
            <button type="button" className="chat-button chat-button-outline" disabled={!connected} onClick={() => void deliver(snapshot.pendingDelivery!, false)}>Check delivery</button>
            <button type="button" className="chat-button chat-button-outline" disabled={!connected} onClick={() => void deliver(snapshot.pendingDelivery!, true)}>Retry same message</button>
          </div>}
          {view?.questions.map(question => <ChatQuestionCard key={question.id} question={question} disabled={disabled || busy} onAnswer={answer => act(() => client.answer(panelId, question.id, answer))} />)}
          <AgentChatPermissions permissions={view?.permissions ?? []} disabled={disabled || busy} onAnswer={answerPermission} />
          {!!view?.queue.length && <ul className="chat-queue" aria-label="Queued messages">
            {view.queue.map(item => <li key={item.operationId}>
              <span className="chat-queue-text">{item.text || 'Image'}</span>
              <span className="chat-queue-label">Sends next</span>
              <button type="button" className="chat-icon" aria-label="Remove from queue" title="Remove from queue" onClick={() => void act(() => client.unqueue(panelId, item.operationId))}><X className="h-3.5 w-3.5" /></button>
            </li>)}
          </ul>}
          <ComposerPrimitive.Root className="chat-composer">
            <div className="flex flex-wrap gap-2 empty:hidden"><ComposerPrimitive.Attachments components={{ Attachment }} /></div>
            <ComposerPrimitive.Input readOnly={!!snapshot.pendingDelivery} aria-label={`Message ${agentName}`} placeholder={`Message ${agentName} — / commands`} rows={1} onChange={event => viewer.setDraft(event.target.value)} className="chat-input" />
            <div className="chat-composer-actions">
              <div className="chat-configs">
                {view?.canAttachImages && <ComposerPrimitive.AddAttachment aria-label="Attach image" title="Attach image" className="chat-icon rounded-full"><Plus className="h-4 w-4" /></ComposerPrimitive.AddAttachment>}
                {!!view?.controls.length && <AgentChatConfiguration controls={view.controls} disabled={disabled || view.status !== 'idle'} configure={(id, value) => void act(() => client.configure(panelId, id, value))} />}
              </div>
              {view?.status === 'working' || view?.status === 'blocked'
                ? <div className="flex items-center gap-1">
                  <ComposerPrimitive.Send aria-label="Queue message" title="Queue message (sends after this turn)" className="chat-icon"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>
                  <button type="button" aria-label="Stop agent turn" title="Stop" className="chat-send" onClick={() => void act(() => client.cancel(panelId))}><Square className="h-3.5 w-3.5 fill-current" /></button>
                </div>
                : <ComposerPrimitive.Send aria-label="Send message" title="Send message" className="chat-send"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>}
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </ChatPermissionContext.Provider>
  </AssistantRuntimeProvider>;
}
