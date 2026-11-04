import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive,
  SimpleImageAttachmentAdapter, useExternalStoreRuntime, useThreadViewport, useThreadViewportStore,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Plus, Square, X } from 'lucide-react';
import type { AgentChatPermission } from '../../../../shared/types/agentChat';
import type { ChatTabClient, ChatTabCommand, ChatTabSend } from '../../../../shared/types/chatTab';
import { chatTurns, placeWorkers, type ChatWorkerLine } from '../../../../shared/chatTabPresentation';
import { rejectOption } from '../../../../shared/chatTabPermissions';
import { chatTabViewer, type ChatTabViewer } from '../../../../shared/chatTabViewer';
import { toAssistantMessage } from '../agentChat/convertMessage';
import { AgentChatConfiguration } from '../agentChat/AgentChatConfiguration';
import { MachineBadge } from '../machines/MachineBadge';
import type { ActiveMachine } from '../../stores/activeMachineStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { ChatProblem } from './ChatProblem';
import { ChatQuestionCard } from './ChatQuestionCard';
import { ChatPermissionCard } from './ChatPermissionCard';
import { ChatTurnView, WorkerLine, type ChatTurnActions } from './ChatTurns';
import { ChatCommandMenu } from './ChatCommandMenu';
import { matchingCommands } from './chatCommands';
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

/** A window scrolled back from the newest message reads the newest window again first. */
/** `follow` is set to a function that makes the thread follow its live end again (used when sending). */
function ScrollToLatest({ viewer, hasNewer, follow }: { viewer: ChatTabViewer; hasNewer: boolean; follow: RefObject<(() => void) | undefined> }) {
  const isAtBottom = useThreadViewport(state => state.isAtBottom);
  const viewport = useThreadViewportStore();
  // The viewport's own scroll-to-bottom also resets its follow state, which setting scrollTop does not.
  useEffect(() => { follow.current = () => viewport.getState().scrollToBottom({ behavior: 'instant' }); return () => { follow.current = undefined; }; }, [viewport, follow]);
  const jump = async () => {
    if (hasNewer) await viewer.jumpToLatest();
    requestAnimationFrame(() => viewport.getState().scrollToBottom({ behavior: 'instant' }));
  };
  return <button type="button" disabled={isAtBottom && !hasNewer} onClick={() => void jump()} className="chat-latest" aria-label="Scroll to latest message"><ArrowDown className="h-4 w-4" /></button>;
}

interface ScrollAnchor {
  /** Rows on screen, nearest the middle first, each with its offset from the viewport's top. */
  rows: Array<{ id: string; offset: number }>;
  /** Following the live end (the bottom of a window with nothing newer): nothing to keep. */
  atBottom: boolean;
}

/**
 * The rows on screen (steps, replies, user messages; whole turns only when nothing
 * finer is there), nearest the middle first. Several are kept because a page added
 * to the start of a turn can merge into the first visible step group and rename it.
 */
function readAnchor(viewport: HTMLElement, hasNewer: boolean): ScrollAnchor {
  const box = viewport.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  const visible = (selector: string) => [...viewport.querySelectorAll<HTMLElement>(selector)].flatMap(element => {
    const rect = element.getBoundingClientRect();
    if (rect.bottom < box.top || rect.top > box.bottom) return [];
    const distance = rect.top <= middle && rect.bottom >= middle ? 0 : Math.min(Math.abs(rect.top - middle), Math.abs(rect.bottom - middle));
    return [{ id: element.dataset.anchorId!, offset: rect.top - box.top, distance }];
  });
  const rows = visible('[data-anchor-id]:not(.chat-turn)');
  const candidates = (rows.length ? rows : visible('.chat-turn[data-anchor-id]')).sort((a, b) => a.distance - b.distance).slice(0, 12);
  return { rows: candidates.map(({ id, offset }) => ({ id, offset })), atBottom: !hasNewer && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 4 };
}

/**
 * Keeps the reader's place while the bounded window pages in or trims messages
 * at either end (the viewport sets overflow-anchor:none, so the browser will not).
 * Whether the reader was at the live end is read before the change: once the
 * window shrinks, the browser has already clamped the scroll position to the bottom.
 */
function useWindowAnchor(viewport: RefObject<HTMLElement | null>, start: number | undefined, length: number, hasNewer: boolean) {
  const anchor = useRef<ScrollAnchor | undefined>(undefined);
  const newer = useRef(hasNewer);
  newer.current = hasNewer;
  const record = useCallback(() => { if (viewport.current) anchor.current = readAnchor(viewport.current, newer.current); }, [viewport]);
  const previous = useRef({ start, length });
  useLayoutEffect(() => {
    const element = viewport.current;
    const moved = previous.current.start !== start || (previous.current.length > length);
    previous.current = { start, length };
    if (element && moved && anchor.current && !anchor.current.atBottom) {
      for (const row of anchor.current.rows) {
        const target = element.querySelector<HTMLElement>(`[data-anchor-id="${CSS.escape(row.id)}"]`);
        if (!target) continue;
        element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - row.offset;
        break;
      }
      record();
    }
    // Not re-read otherwise: right after new content renders, a chat that follows the
    // live end has not scrolled yet, and reading then would mistake it for a reader.
  }, [viewport, start, length, record]);
  return record;
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

export interface ChatTabPanelProps {
  panelId: string;
  client: ChatTabClient;
  connected?: boolean;
  /** The Session orchestrator's chat (D-18): finished turns fold to one line and only the current step shows. */
  quiet?: boolean;
  /** The machine the tab's agent runs on, shown in the composer. */
  machine?: ActiveMachine | null;
  actions?: ChatTurnActions;
  placeholder?: string;
  /** The Session's workers, one line each (the orchestrator's chat). */
  workers?: ChatWorkerLine[];
}

/** A chat tab: one agent conversation over ACP, with no terminal (D-20). */
const NO_ACTIONS: ChatTurnActions = {};

export default function ChatTabPanel({ panelId, client, connected = true, quiet = false, machine, actions = NO_ACTIONS, placeholder, workers }: ChatTabPanelProps) {
  const viewer: ChatTabViewer = useMemo(() => chatTabViewer(client, panelId), [client, panelId]);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const view = snapshot.view;
  const [busy, setBusy] = useState(false);
  /** Paged with Earlier or Newer messages: stay put until the reader scrolls back to the live end, even once the window reaches it. */
  const [paged, setPaged] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const messages = useMemo(() => snapshot.transcript?.messages ?? [], [snapshot.transcript?.messages]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLiveEnd = useRef<(() => void) | undefined>(undefined);
  const recordAnchor = useWindowAnchor(viewportRef, snapshot.transcript?.start, messages.length, !!snapshot.hasNewer);
  const onViewportScroll = () => {
    recordAnchor();
    const element = viewportRef.current;
    if (paged && element && !snapshot.hasNewer && element.scrollHeight - element.scrollTop - element.clientHeight < 2) setPaged(false);
  };
  const working = view?.status === 'working' || view?.status === 'blocked';
  const turns = useMemo(() => chatTurns(messages, { running: working }), [messages, working]);
  const placedWorkers = useMemo(() => placeWorkers(turns, workers ?? []), [turns, workers]);
  const images = useMemo(() => new ChatImageAdapter(), []);
  const stopped = view?.status === 'stopped';
  const disabled = !connected || stopped || !view;
  const agentName = view ? AGENT_NAMES[view.agent] : 'the agent';
  const commands = matchingCommands(snapshot.draft, view?.commands ?? []);
  const activeCommand = commands[Math.min(commandIndex, commands.length - 1)];

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
      // Typing while an approval waits tells the agent what to do instead (round 2).
      await Promise.all((view?.permissions ?? []).map(permission => {
        const reject = rejectOption(permission);
        return reject ? client.permission(panelId, permission.id, reject).catch(() => undefined) : undefined;
      }));
      // Sending returns to the live end, wherever the reader had paged to.
      setPaged(false);
      if (viewer.snapshot().hasNewer) await viewer.jumpToLatest();
      requestAnimationFrame(() => followLiveEnd.current?.());
      await deliver({ operationId: crypto.randomUUID(), text, images: imageParts }, true);
    },
  });
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);

  const act = async <Result,>(operation: () => Promise<Result>) => {
    setBusy(true);
    try { await operation(); viewer.setError(undefined); } catch (error) { viewer.setError(ipcErrorMessage(error, 'Pane did not say why.')); } finally { setBusy(false); }
  };
  const answerPermission = (permission: AgentChatPermission, optionId: string) => void act(() => client.permission(panelId, permission.id, optionId));
  const pickCommand = (command: ChatTabCommand) => {
    const text = `/${command.name} `;
    viewer.setDraft(text);
    runtime.thread.composer.setText(text);
    setCommandIndex(0);
  };

  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="agent-chat chat-tab flex h-full min-h-0 flex-col" data-status={view?.status ?? 'starting'}>
      {view?.problem && <ChatProblem problem={view.problem} agent={agentName} busy={busy || !connected}
        onRestart={() => void act(() => client.restart(panelId))}
        onSignIn={() => void act(() => client.signIn(panelId))}
        onInstall={url => void window.electronAPI?.openExternal(url)} />}
      {snapshot.error && <div role="alert" className="chat-alert">{snapshot.error}</div>}
      <ThreadPrimitive.Viewport ref={viewportRef} onScroll={onViewportScroll} aria-label="Conversation messages" role="region" className="chat-viewport" scrollToBottomOnRunStart={false} autoScroll={!snapshot.hasNewer && !paged}>
        <div className="chat-column">
          {(snapshot.transcript?.start ?? 0) > 0 && <button type="button" className="chat-button chat-button-outline self-center" disabled={snapshot.loadingEarlier} onClick={() => { recordAnchor(); setPaged(true); void viewer.loadEarlier(); }}>
            {snapshot.loadingEarlier ? 'Loading…' : `Earlier messages (${snapshot.transcript?.start})`}
          </button>}
          {!snapshot.transcript && !view?.problem && <p role="status" className="chat-notice">{view?.status === 'starting' || !view ? `Starting ${agentName}…` : 'Loading conversation…'}</p>}
          {turns.map(turn => <ChatTurnView key={turn.id} turn={turn} quiet={quiet} permissions={view?.permissions ?? []} actions={actions} workers={placedWorkers.byTurn.get(turn.id)} />)}
          {placedWorkers.trailing.map(worker => <WorkerLine key={worker.paneId} worker={worker} onOpen={actions.onOpenWorker} />)}
          {snapshot.hasNewer && <button type="button" className="chat-button chat-button-outline self-center" disabled={snapshot.loadingNewer} onClick={() => { recordAnchor(); setPaged(true); void viewer.loadNewer(); }}>
            {snapshot.loadingNewer ? 'Loading…' : 'Newer messages'}
          </button>}
          {!snapshot.hasNewer && view?.notice && <p role="status" className="chat-notice">{view.notice}</p>}
        </div>
      </ThreadPrimitive.Viewport>
      <div className="chat-composer-footer">
        <ScrollToLatest viewer={viewer} hasNewer={snapshot.hasNewer} follow={followLiveEnd} />
        {snapshot.pendingDelivery && <div className="chat-dock" role="status">
          <span>Delivery is unconfirmed.</span>
          <button type="button" className="chat-button chat-button-outline" disabled={!connected} onClick={() => void deliver(snapshot.pendingDelivery!, false)}>Check delivery</button>
          <button type="button" className="chat-button chat-button-outline" disabled={!connected} onClick={() => void deliver(snapshot.pendingDelivery!, true)}>Retry same message</button>
        </div>}
        {view?.questions.map(question => <ChatQuestionCard key={question.id} question={question} disabled={disabled || busy} onAnswer={answer => void act(() => client.answer(panelId, question.id, answer))} />)}
        {view?.permissions.map(permission => <ChatPermissionCard key={permission.id} permission={permission} agent={agentName} machine={machine && !machine.local ? machine.name : undefined}
          disabled={disabled || busy} composerEmpty={!snapshot.draft.trim()} onAnswer={answerPermission} />)}
        {!!view?.queue.length && <ul className="chat-queue" aria-label="Queued messages">
          {view.queue.map((item, index) => <li key={item.operationId}>
            <span className="chat-queue-text">{item.text || 'Image'}</span>
            <span className="chat-queue-label">{index === 0 ? 'Sends next' : 'Queued'}</span>
            <button type="button" className="chat-icon" aria-label="Remove from queue" title="Remove from queue" onClick={() => void act(() => client.unqueue(panelId, item.operationId))}><X className="h-3.5 w-3.5" /></button>
          </li>)}
        </ul>}
        <ComposerPrimitive.Root className="chat-composer">
          <ChatCommandMenu commands={commands} active={Math.min(commandIndex, commands.length - 1)} onPick={pickCommand} />
          <div className="flex flex-wrap gap-2 empty:hidden"><ComposerPrimitive.Attachments components={{ Attachment }} /></div>
          <ComposerPrimitive.Input readOnly={!!snapshot.pendingDelivery} aria-label={`Message ${agentName}`} placeholder={placeholder ?? `Message ${agentName} — / commands`} rows={1}
            onChange={event => { viewer.setDraft(event.target.value); setCommandIndex(0); }}
            onKeyDown={event => {
              if (!activeCommand) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setCommandIndex(index => (index + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length);
              } else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && snapshot.draft !== `/${activeCommand.name}`)) {
                event.preventDefault();
                pickCommand(activeCommand);
              }
            }}
            className="chat-input" />
          <div className="chat-composer-actions">
            <div className="chat-configs">
              {view?.canAttachImages && <ComposerPrimitive.AddAttachment aria-label="Attach image" title="Attach image" className="chat-icon rounded-full"><Plus className="h-4 w-4" /></ComposerPrimitive.AddAttachment>}
              {!!view?.controls.length && <AgentChatConfiguration controls={view.controls} disabled={disabled || view.status !== 'idle'} configure={(id, value) => void act(() => client.configure(panelId, id, value))} />}
              {machine && <span className="chat-machine" title={`Runs on ${machine.name}`}><MachineBadge machine={machine} /></span>}
            </div>
            {working
              ? <div className="flex items-center gap-1">
                <ComposerPrimitive.Send aria-label="Queue message" title="Queue message (sends after this turn)" className="chat-icon"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>
                <button type="button" aria-label="Stop agent turn" title="Stop" className="chat-send" onClick={() => void act(() => client.cancel(panelId))}><Square className="h-3.5 w-3.5 fill-current" /></button>
              </div>
              : <ComposerPrimitive.Send aria-label="Send message" title="Send message" className="chat-send"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
