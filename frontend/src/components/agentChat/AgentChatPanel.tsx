import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import {
  AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive,
  SimpleImageAttachmentAdapter, useAuiState, useExternalStoreRuntime, useThreadViewport, useThreadViewportStore,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Plus, Square, X } from 'lucide-react';
import type { AgentChatClient, AgentChatSend } from '../../../../shared/types/agentChat';
import { agentChatViewer } from '../../services/agentChatViewer';
import { toAssistantMessage } from './convertMessage';
import { AgentChatPermissions } from './AgentChatPermissions';
import { AgentChatHeader } from './AgentChatHeader';
import { AgentChatConfiguration } from './AgentChatConfiguration';
import { MessageRow } from './AgentChatParts';
import { ChatPermissionContext } from './chatPermissionContext';
import { permissionToolId } from '../../../../shared/agentChatPresentation';
import './agentChat.css';

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

// Indexes must come from the runtime that owns MessageByIndex. The external
// host snapshot can advance before assistant-ui has synchronized its messages.
function ChatViewport({ viewer, loading }: { viewer: ReturnType<typeof agentChatViewer>; loading: boolean }) {
  const messages = useAuiState(state => state.thread.messages);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const end = Math.min(snapshot.windowEnd ?? messages.length, messages.length);
  const start = Math.max(0, end - 200);
  const viewportStore = useThreadViewportStore();
  const showLatest = () => {
    flushSync(() => viewer.setWindowEnd(undefined));
    viewportStore.getState().scrollToBottom({ behavior: 'instant' });
  };
  const viewportRef = useRef<HTMLDivElement>(null);
  const savedTop = useRef(viewer.scrollTop);
  const [restoring, setRestoring] = useState(savedTop.current !== undefined);
  useLayoutEffect(() => {
    if (!restoring || loading || !snapshot.view?.transcript || !viewportRef.current) return;
    const expected = snapshot.view.transcript.messages.filter(message => !message.id.startsWith('update:')).length;
    // assistant-ui synchronizes its own message array after the host snapshot.
    // Restoring into the empty viewport clamps the saved offset to zero.
    if (messages.length !== expected) return;
    viewportRef.current.scrollTop = savedTop.current ?? 0;
    setRestoring(false);
  }, [loading, messages.length, restoring, snapshot.view?.transcript]);
  return (
      <ThreadPrimitive.Viewport aria-label="Conversation messages" role="region" ref={viewportRef} autoScroll={!restoring && snapshot.windowEnd === undefined} scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={savedTop.current === undefined} scrollToBottomOnThreadSwitch={false} onScroll={event => {
        if (restoring || loading) return;
        const viewport = event.currentTarget;
        const previousTop = viewer.scrollTop;
        viewer.scrollTop = viewport.scrollTop;
        if (end === messages.length && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32) {
          if (snapshot.windowEnd !== undefined) viewer.setWindowEnd(undefined);
        } else if (snapshot.windowEnd === undefined && previousTop !== undefined && viewport.scrollTop < previousTop) {
          // Pin only when the reader moves up. Growth can briefly move the
          // bottom away before assistant-ui follows it; that is not a pause.
          viewer.setWindowEnd(messages.length);
        }
      }} className="chat-viewport">
        <div className="chat-column">
        <ThreadPrimitive.Empty><p className="py-8 text-sm">{loading ? 'Loading conversation…' : ''}</p></ThreadPrimitive.Empty>
        {start > 0 && <button type="button" className="chat-button chat-button-outline self-center" onClick={() => { flushSync(() => viewer.setWindowEnd(start)); viewportStore.getState().scrollToBottom({ behavior: 'instant' }); }}>Earlier messages ({start})</button>}
        {messages.slice(start, end).map((message, index) => <ThreadPrimitive.MessageByIndex key={message.id} index={start + index} components={{ Message: MessageRow }} />)}
        {end < messages.length && <div className="flex gap-2 py-2 text-xs"><button type="button" className="rounded border border-border-primary px-3 py-2" onClick={() => viewer.setWindowEnd(Math.min(messages.length, end + 200))}>Newer messages</button><button type="button" className="rounded border border-border-primary px-3 py-2" onClick={showLatest}>Latest messages ({messages.length - end} newer)</button></div>}
        </div>
      </ThreadPrimitive.Viewport>
  );
}

function ScrollToLatest({ viewer }: { viewer: ReturnType<typeof agentChatViewer> }) {
  const { windowEnd } = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const isAtBottom = useThreadViewport(state => state.isAtBottom);
  const viewportStore = useThreadViewportStore();
  return <button type="button" disabled={windowEnd === undefined && isAtBottom} onClick={() => {
    flushSync(() => viewer.setWindowEnd(undefined));
    viewportStore.getState().scrollToBottom({ behavior: 'instant' });
  }} className="chat-latest" aria-label="Scroll to latest message"><ArrowDown className="h-4 w-4" /></button>;
}

export default function AgentChatPanel({ panelId, client, connected = true }: { panelId: string; client: AgentChatClient; connected?: boolean }) {
  const viewer = useMemo(() => agentChatViewer(client, panelId), [client, panelId]);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const pendingDelivery = snapshot.pendingDelivery;
  const [answering, setAnswering] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const view = snapshot.view;
  const generation = view?.conversation?.generation ?? 0;
  const disabled = !connected || view?.conversation?.active !== 'chat' || !!view.conversation.transition;
  const messages = useMemo(() => (view?.transcript?.messages ?? []).filter(message => !message.id.startsWith('update:')), [view?.transcript?.messages]);
  const images = useMemo(() => new ChatImageAdapter(), []);
  const runtime = useExternalStoreRuntime({
    messages, convertMessage: toAssistantMessage,
    isRunning: view?.running ?? false, isLoading: !view || (view.conversation?.active === 'chat' && !view.transcript),
    isSendDisabled: disabled || !!pendingDelivery || !!view?.permissions.length,
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
      const request: AgentChatSend = { operationId: crypto.randomUUID(), generation, text, images: imageParts };
      viewer.setPendingDelivery(request);
      setDelivering(true);
      viewer.setDraft(text);
      // The upstream composer clears optimistically before onNew. Keep the
      // draft visible until this host confirms receipt of the operation.
      runtime.thread.composer.setText(text);
      try {
        const receipt = await client.send(panelId, request);
        viewer.setPendingDelivery(undefined);
        if (receipt.state !== 'failed') {
          viewer.setDraft('');
          runtime.thread.composer.setText('');
        }
        await viewer.refresh();
        viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
      } catch (error) {
        viewer.setError(`${error instanceof Error ? error.message : String(error)} Check delivery before sending again.`);
      } finally { setDelivering(false); }
    },
    onCancel: async () => {
      try { await client.cancel(panelId, generation); await viewer.refresh(); }
      catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    },
  });
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);

  const checkDelivery = async (retry: boolean) => {
    if (!pendingDelivery) return;
    setDelivering(true);
    try {
      const receipt = retry ? await client.send(panelId, pendingDelivery) : await client.receipt(panelId, pendingDelivery.operationId);
      if (!receipt) { viewer.setError('The host has no receipt yet. You can explicitly retry this same delivery without creating a duplicate operation.'); return; }
      viewer.setPendingDelivery(undefined);
      if (receipt.state !== 'failed') {
        viewer.setDraft('');
        runtime.thread.composer.setText('');
      }
      await viewer.refresh();
      viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
    } catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    finally { setDelivering(false); }
  };
  const recover = async () => {
    setRecovering(true);
    try { await client.recover(panelId, 'terminal', generation); await viewer.refresh(); }
    catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    finally { setRecovering(false); }
  };

  const answer = async (permission: NonNullable<typeof view>['permissions'][number], optionId: string) => {
    setAnswering(true);
    try { await client.permission(panelId, permission.generation, permission.id, optionId); await viewer.refresh(); }
    catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    finally { setAnswering(false); }
  };
  const visibleEnd = Math.min(snapshot.windowEnd ?? messages.length, messages.length);
  const toolIds = new Set(messages.slice(Math.max(0, visibleEnd - 200), visibleEnd).flatMap(message => message.parts.flatMap(part => part.type === 'tool' ? [part.id] : [])));
  const unmatchedPermissions = (view?.permissions ?? []).filter(permission => !toolIds.has(permissionToolId(permission) ?? ''));
  return <AssistantRuntimeProvider runtime={runtime}>
    <ChatPermissionContext.Provider value={{ permissions: view?.permissions ?? [], disabled: disabled || answering, onAnswer: answer }}>
    <ThreadPrimitive.Root ref={rootRef} className="agent-chat flex h-full min-h-0 flex-col">
      <AgentChatHeader panelId={panelId} client={client} connected={connected} />
      {(snapshot.error || view?.error) && <div role="alert" className="chat-alert">{snapshot.error ?? view?.error}</div>}
      {pendingDelivery && !delivering && <div className="flex flex-wrap items-center gap-2 px-4 py-2"><span role="status" className="text-xs">Delivery is unconfirmed.</span><button type="button" disabled={!connected || delivering} onClick={() => void checkDelivery(false)} className="chat-button chat-button-outline">Check delivery</button><button type="button" disabled={!connected || delivering} onClick={() => void checkDelivery(true)} className="chat-button chat-button-outline">Retry same delivery</button></div>}
      {view?.conversation?.active === 'stopped' && <div className="chat-recovery">
        <p>{view.conversation.recovery ?? 'This conversation is stopped.'}</p>
        <p className="break-all text-xs">Conversation {view.conversation.nativeSessionId}</p>
        <p>Recovery opens Terminal to restore this conversation’s launch environment.</p>
        <button type="button" disabled={recovering || !connected} onClick={() => void recover()} className="chat-button chat-button-outline mt-3">{recovering ? 'Recovering…' : 'Recover exact conversation'}</button>
      </div>}
      <ChatViewport viewer={viewer} loading={!view || (view.conversation?.active === 'chat' && !view.transcript)} />
      <div className="chat-composer-footer">
        <ScrollToLatest viewer={viewer} />
        {!!view?.permissions.length && unmatchedPermissions.length < view.permissions.length && <button type="button" className="chat-button chat-button-outline self-center" onClick={() => {
          const toolId = view.permissions.map(permissionToolId).find(id => id && toolIds.has(id));
          const tool = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-chat-tool]') ?? [])].find(element => element.dataset.chatTool === toolId);
          tool?.scrollIntoView({ block: 'center', behavior: 'instant' });
          tool?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
        }}>Approval needed</button>}
        <AgentChatPermissions permissions={unmatchedPermissions} disabled={disabled || answering} onAnswer={answer} />
        <ComposerPrimitive.Root className="chat-composer" aria-busy={delivering}>
          {delivering && <span className="sr-only" role="status">Confirming delivery…</span>}
          <div className="flex flex-wrap gap-2 empty:hidden">{pendingDelivery?.images?.map((image, index) => <span key={index} className="chat-attachment"><img alt="Image awaiting delivery confirmation" src={`data:${image.mimeType};base64,${image.data}`} /></span>)}<ComposerPrimitive.Attachments components={{ Attachment }} /></div>
          <ComposerPrimitive.Input readOnly={!!pendingDelivery} aria-label="Message agent" placeholder="Send a message..." rows={1} onChange={event => viewer.setDraft(event.target.value)} className="chat-input" />
          <div className="chat-composer-actions">
            <div className="chat-configs">
              {view?.canAttachImages && <ComposerPrimitive.AddAttachment aria-label="Attach image" title="Attach image" className="chat-icon rounded-full"><Plus className="h-4 w-4" /></ComposerPrimitive.AddAttachment>}
              {client.configure && !!view?.controls?.length && <AgentChatConfiguration controls={view.controls} disabled={disabled || view.running || !!view.permissions.length} configure={(id, value) => {
                void client.configure!(panelId, generation, id, value).then(() => viewer.refresh()).catch(error => viewer.setError(String(error)));
              }} />}
            </div>
            {view?.running ? <ComposerPrimitive.Cancel aria-label="Cancel agent turn" title="Stop generating" className="chat-send"><Square className="h-3.5 w-3.5 fill-current" /></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send aria-label="Send message" title="Send message" className="chat-send"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
    </ChatPermissionContext.Provider>
  </AssistantRuntimeProvider>;
}
