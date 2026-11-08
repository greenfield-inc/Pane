import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode, type RefObject } from 'react';
import {
  AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive,
  useAuiState, useExternalStoreRuntime, useThreadViewport, useThreadViewportStore,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Eraser, FileText, Image as ImageIcon, LoaderCircle, Paperclip, Plus, Square, X } from 'lucide-react';
import type { AgentChatPermission, AgentChatReceipt } from '../../../../shared/types/agentChat';
import type { ChatTabClient, ChatTabCommand, ChatTabSend } from '../../../../shared/types/chatTab';
import { chatTurns, messageTime, waitingToolIds, workerNotes, workingAgents, type ChatWorkerLine } from '../../../../shared/chatTabPresentation';
import { rejectOption } from '../../../../shared/chatTabPermissions';
import { chatTabViewer, type ChatTabViewer } from '../../../../shared/chatTabViewer';
import { toAssistantMessage } from '../agentChat/convertMessage';
import type { ActiveMachine } from '../../stores/activeMachineStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { ChatProblem } from './ChatProblem';
import { ChatQuestionCard } from './ChatQuestionCard';
import { ChatPermissionCard } from './ChatPermissionCard';
import { ChatTurnView, WorkerNoteLine, type ChatTurnActions } from './ChatTurns';
import { ChatBlocksContext, type ChatRendering } from './chatRendering';
import { ChatCommandMenu } from './ChatCommandMenu';
import { CLEAR_COMMAND, isClearCommand, matchingCommands, withPaneCommands } from './chatCommands';
import { ChatQueue } from './ChatQueue';
import { ChatModeChip, ChatModelMenu, ChatPhoneModelMenu, ChatRiskyModeMarker, usePhoneWidth } from './ChatComposerControls';
import { ChatStatusBar, type ChatStatusPullRequest } from './ChatStatusBar';
import { sendNowKeys } from './chatKeys';
import { arrangeComposerControls } from '../../../../shared/chatComposerControls';
import { ChatAttachmentAdapter, dragHasFiles, MAX_FILE_BYTES, MAX_IMAGE_BYTES, type SaveChatFile } from './chatAttachments';
import { ChatCopyButton } from './ChatCopyButton';
import { conversationMarkdown } from '../../../../shared/chatTabMarkdown';
import '../agentChat/agentChat.css';
import './chatTab.css';

/** A small preview of an attached image, read from the dropped or pasted file itself. */
function ImagePreview() {
  const file = useAuiState(state => state.attachment.file);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img className="chat-attachment-preview" src={url} alt="" /> : <span className="chat-attachment-icon" aria-hidden><ImageIcon /></span>;
}

/** An attached image or file before sending; a file shows "Copying…" until it is on the chat's machine. */
function Attachment() {
  const kind = useAuiState(state => state.attachment.type);
  const copying = useAuiState(state => state.attachment.status.type === 'running');
  return <AttachmentPrimitive.Root className="chat-attachment" data-kind={kind} aria-busy={copying}>
    {kind === 'image' ? <ImagePreview /> : <span className="chat-attachment-icon" aria-hidden>{copying ? <LoaderCircle className="chat-spin" /> : <FileText />}</span>}
    <span className="chat-attachment-name"><AttachmentPrimitive.Name /></span>
    {copying && <span className="chat-attachment-status">Copying…</span>}
    <AttachmentPrimitive.Remove aria-label="Remove attachment" title="Remove attachment"><X className="h-3 w-3" /></AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

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

/** Where a fresh conversation started after /clear: "Cleared · 2:04 PM". */
function ClearedDivider({ at }: { at: string }) {
  const time = messageTime(at);
  return <p className="chat-divider" role="separator" title={time?.full}><span>{time ? `Cleared · ${time.short}` : 'Cleared'}</span></p>;
}

export interface ChatTabPanelProps {
  panelId: string;
  client: ChatTabClient;
  connected?: boolean;
  /** The machine the tab's agent runs on, named on an approval for a remote one. */
  machine?: ActiveMachine | null;
  actions?: ChatTurnActions;
  placeholder?: string;
  /** The Session's workers (the orchestrator's chat). */
  workers?: ChatWorkerLine[];
  /** Copies a dropped, pasted or picked file to the chat's machine (D-139); without it only images attach. */
  saveFile?: SaveChatFile;
  /** Fenced blocks rendered as UI instead of code (Autopilot's item rows), and person's messages shown another way. */
  rendering?: ChatRendering;
  /**
   * Shown instead of the stopped notice when the tab was stopped on purpose (no action to take), such as Autopilot's Start.
   * With one set, a stopped tab's own Restart is hidden too: its owner restarts it (the reason still shows).
   */
  stoppedNotice?: ReactNode;
  /** Above the composer, below the conversation: such as Autopilot's answer receipts. */
  dock?: ReactNode;
  /**
   * Offers /clear (a fresh conversation in this tab). Off for Autopilot, whose conversation
   * holds what Start told it; a fresh one would carry on without it.
   */
  clearable?: boolean;
  /** The Pane's pull request, for the status bar. */
  pr?: ChatStatusPullRequest;
  /**
   * The agents working, for the status bar's "N working" (D-276). Defaults to the `workers`
   * that are working; Autopilot passes the workers of every Session it walks.
   */
  working?: readonly ChatWorkerLine[];
}

/** The most text one paste puts in the composer, in UTF-16 units (about 1 MiB). */
const PASTE_LIMIT = 1024 * 1024;

/** A chat tab: one agent conversation over ACP, with no terminal (D-20). */
const NO_ACTIONS: ChatTurnActions = {};
const NO_RENDERING: ChatRendering = {};

export default function ChatTabPanel({ panelId, client, connected = true, machine, actions = NO_ACTIONS, placeholder, workers, saveFile, rendering = NO_RENDERING, stoppedNotice, dock, clearable = true, pr, working: workingOverride }: ChatTabPanelProps) {
  const viewer: ChatTabViewer = useMemo(() => chatTabViewer(client, panelId), [client, panelId]);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const view = snapshot.view;
  const [busy, setBusy] = useState(false);
  /** Paged with Earlier or Newer messages: stay put until the reader scrolls back to the live end, even once the window reaches it. */
  const [paged, setPaged] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const messages = useMemo(() => snapshot.transcript?.messages ?? [], [snapshot.transcript?.messages]);
  const followLiveEnd = useRef<(() => void) | undefined>(undefined);
  /** The sent message's transcript ID: when the host's copy of it renders, the chat follows the live end once more. */
  const followSent = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!followSent.current || !messages.some(message => message.id === followSent.current)) return;
    followSent.current = undefined;
    followLiveEnd.current?.();
  }, [messages]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const recordAnchor = useWindowAnchor(viewportRef, snapshot.transcript?.start, messages.length, !!snapshot.hasNewer);
  const onViewportScroll = () => {
    recordAnchor();
    const element = viewportRef.current;
    if (paged && element && !snapshot.hasNewer && element.scrollHeight - element.scrollTop - element.clientHeight < 2) setPaged(false);
  };
  const working = view?.status === 'working' || view?.status === 'blocked';
  const turns = useMemo(() => chatTurns(messages, { running: working }), [messages, working]);
  const waiting = useMemo(() => waitingToolIds(view?.permissions, view?.questions), [view?.permissions, view?.questions]);
  const notes = useMemo(() => workerNotes(turns, workers ?? []), [turns, workers]);
  const agentsWorking = useMemo(() => workingOverride ?? workingAgents(workers), [workingOverride, workers]);
  const [copying, setCopying] = useState(0);
  const canAttachImages = !!view?.canAttachImages;
  const attachments = useMemo(() => {
    const options = { images: canAttachImages, saveFile, onCopying: (delta: 1 | -1) => setCopying(count => count + delta) };
    return ChatAttachmentAdapter.available(options) ? new ChatAttachmentAdapter(options) : undefined;
  }, [canAttachImages, saveFile]);
  /** Why dropped, pasted or picked files were not attached; shown until dismissed or the next attempt. */
  const [attachProblems, setAttachProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const stopped = view?.status === 'stopped';
  const disabled = !connected || stopped || !view;
  const agentName = view ? AGENT_NAMES[view.agent] : 'the agent';
  const commands = matchingCommands(snapshot.draft, clearable ? withPaneCommands(view?.commands ?? []) : view?.commands ?? []);
  /** Cmd/Ctrl+Enter: the message being sent goes ahead of the queue and interrupts the turn (D-211, D-222 item 7). */
  const sendNowNext = useRef(false);
  /** /clear while a turn runs asks first. */
  const [confirmClear, setConfirmClear] = useState(false);
  const activeCommand = commands[Math.min(commandIndex, commands.length - 1)];
  const composerRow = useMemo(() => arrangeComposerControls(view?.controls ?? []), [view?.controls]);
  const settingsLocked = disabled || view?.status !== 'idle';
  const actionsRef = useRef<HTMLDivElement>(null);
  const phone = usePhoneWidth(actionsRef);
  const footerRef = useRef<HTMLDivElement>(null);
  /** The bar's "2 queued": brings the queue into view and puts focus on its first row. */
  const showQueue = () => {
    const queue = footerRef.current?.querySelector<HTMLElement>('.chat-queue');
    queue?.scrollIntoView({ block: 'nearest' });
    queue?.querySelector<HTMLElement>('button')?.focus();
  };

  /** True when the host took the message. */
  const settle = (receipt: AgentChatReceipt): boolean => {
    viewer.setPendingDelivery(undefined);
    viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
    if (receipt.state === 'failed') return false;
    viewer.setDraft('');
    runtime.thread.composer.setText('');
    return true;
  };
  const deliver = async (request: ChatTabSend, retry: boolean): Promise<boolean> => {
    viewer.setPendingDelivery(request);
    try {
      const receipt = retry ? await client.send(panelId, request) : await client.receipt(panelId, request.operationId);
      if (!receipt) { viewer.setError('Pane has no record of that message yet. Retry sends it once, with the same ID.'); return false; }
      return settle(receipt);
    } catch (error) {
      const reason = ipcErrorMessage(error, 'The message may not have been sent.');
      // Pane refused it (too large, the chat stopped): with no record of it, nothing was sent, so the
      // composer is free again with the message still in it. Unreachable, it may have gone through.
      const known = await client.receipt(panelId, request.operationId).then(receipt => ({ receipt }), () => undefined);
      if (known && !known.receipt) { viewer.setPendingDelivery(undefined); viewer.setError(reason); return false; }
      if (known?.receipt) return settle(known.receipt);
      viewer.setError(`${reason} Check delivery before sending again.`);
      return false;
    }
  };

  const runtime = useExternalStoreRuntime({
    messages, convertMessage: toAssistantMessage,
    // The host queues a message sent while the agent works, so the composer never locks
    // for a running turn; Stop is Pane's own button below.
    isRunning: false,
    isLoading: !snapshot.transcript && view?.status !== 'stopped',
    // A file still copying to the chat's machine has no path yet to send.
    isSendDisabled: disabled || !!snapshot.pendingDelivery || copying > 0,
    unstable_persistsHistory: true, unstable_enableToolInvocations: false,
    adapters: attachments ? { attachments } : undefined,
    onNew: async message => {
      const parts = [...message.content, ...(message.attachments ?? []).flatMap(attachment => attachment.content)];
      const text = parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
      const now = sendNowNext.current;
      sendNowNext.current = false;
      // The Send button with "/clear" typed: Pane's own command, never sent to the agent.
      if (clearable && isClearCommand(text) && !message.attachments?.length) { requestClear(); return; }
      const imageParts = parts.flatMap(part => {
        if (part.type !== 'image') return [];
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(part.image);
        if (!match) throw new Error('This image could not be read. Attach it again.');
        return [{ mimeType: match[1], data: match[2] }];
      });
      viewer.setDraft(text);
      // The composer clears before onNew; keep the text until the host confirms it.
      runtime.thread.composer.setText(text);
      const waitingPermissions = view?.permissions ?? [];
      // Sending returns to the live end, wherever the reader had paged to.
      setPaged(false);
      if (viewer.snapshot().hasNewer) await viewer.jumpToLatest();
      requestAnimationFrame(() => followLiveEnd.current?.());
      const operationId = crypto.randomUUID();
      const request: ChatTabSend = { operationId, text, images: imageParts };
      // Send now only means something while a turn runs; otherwise it is a plain send.
      if (now && working) request.now = true;
      followSent.current = `user:${operationId}`;
      if (!await deliver(request, true)) return;
      // Typing while an approval waits tells the agent what to do instead (round 2): once the message is in.
      await Promise.all(waitingPermissions.map(permission => {
        const reject = rejectOption(permission);
        return reject ? client.permission(panelId, permission.id, reject).catch(() => undefined) : undefined;
      }));
    },
  });
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);
  // Every refusal is shown (assistant-ui's own paste and picker swallow them), and a file
  // that failed while copying leaves no chip behind.
  useEffect(() => runtime.thread.composer.unstable_on('attachmentAddError', event => {
    setAttachProblems(problems => [...problems, event.message]);
    const composer = runtime.thread.composer;
    // From the end, so removing one leaves the indexes still to check unchanged.
    for (let index = composer.getState().attachments.length - 1; index >= 0; index -= 1) {
      if (composer.getState().attachments[index]?.status.type === 'incomplete') void composer.getAttachmentByIndex(index).remove().catch(() => undefined);
    }
  }), [runtime]);

  const attachFiles = (files: File[]) => {
    if (!files.length) return;
    setAttachProblems([]);
    if (!attachments || disabled) {
      setAttachProblems([disabled ? 'Nothing was attached: this chat is not running.' : `Nothing was attached: ${agentName} can't take files or images in this chat.`]);
      return;
    }
    // Each file is checked and attached on its own; a refusal arrives as attachmentAddError.
    for (const file of files) void runtime.thread.composer.addAttachment(file).catch(() => undefined);
  };
  const dragProps = {
    onDragEnter: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer.types)) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      // Always allow the drop: some platforms hide the drag's types until it lands.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      attachFiles([...event.dataTransfer.files]);
    },
  };

  const act = async <Result,>(operation: () => Promise<Result>) => {
    setBusy(true);
    try { await operation(); viewer.setError(undefined); } catch (error) { viewer.setError(ipcErrorMessage(error, 'Pane did not say why.')); } finally { setBusy(false); }
  };
  const configure = (id: string, value: string) => void act(() => client.configure(panelId, id, value));
  const answerPermission = (permission: AgentChatPermission, optionId: string) => void act(() => client.permission(panelId, permission.id, optionId));
  const clearConversation = () => {
    setConfirmClear(false);
    void act(() => client.clear(panelId));
  };
  const requestClear = () => {
    if (disabled) return;
    // The command is taken: the draft and its command menu go, so they never cover the question below.
    viewer.setDraft('');
    runtime.thread.composer.setText('');
    if (working) setConfirmClear(true);
    else clearConversation();
  };
  const editQueued = async (operationId: string, text: string): Promise<boolean> => {
    try { await client.editQueued(panelId, operationId, text); viewer.setError(undefined); return true; }
    catch (error) { viewer.setError(ipcErrorMessage(error, 'Pane did not say why.')); return false; }
  };
  const pickCommand = (command: ChatTabCommand) => {
    const text = `/${command.name} `;
    viewer.setDraft(text);
    runtime.thread.composer.setText(text);
    setCommandIndex(0);
  };

  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="agent-chat chat-tab relative flex h-full min-h-0 flex-col" data-status={view?.status ?? 'starting'} {...dragProps}>
      {dragging && <div className="chat-drop" aria-hidden>
        <div className="chat-drop-card">
          <Paperclip className="chat-drop-icon" />
          <p className="chat-drop-title">Drop to attach</p>
          <p className="chat-drop-detail">{saveFile
            ? `Images up to ${megabytes(MAX_IMAGE_BYTES)}; other files up to ${megabytes(MAX_FILE_BYTES)} are copied to the chat's machine.`
            : `PNG, JPEG, WebP or GIF images up to ${megabytes(MAX_IMAGE_BYTES)}.`}</p>
        </div>
      </div>}
      {view?.problem && stoppedNotice && stopped && !view.problem.action ? stoppedNotice : view?.problem && <ChatProblem problem={view.problem} agent={agentName} busy={busy || !connected}
        restart={!(stoppedNotice && stopped)}
        onRestart={() => void act(() => client.restart(panelId))}
        onSignIn={() => void act(() => client.signIn(panelId))}
        onInstall={url => void window.electronAPI?.openExternal(url)} />}
      {snapshot.error && <div role="alert" className="chat-alert">{snapshot.error}</div>}
      {!!attachProblems.length && <div role="alert" className="chat-alert chat-attach-alert">
        <ul>{attachProblems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>
        <button type="button" className="chat-icon" aria-label="Dismiss" title="Dismiss" onClick={() => setAttachProblems([])}><X className="h-3.5 w-3.5" /></button>
      </div>}
      {turns.length > 0 && <div className="chat-header-bar">
        {clearable && <button type="button" className="chat-copy chat-copy-all" disabled={disabled} title="Start a fresh conversation in this tab (/clear)" onClick={requestClear}>
          <Eraser className="h-3.5 w-3.5" aria-hidden /><span>Clear</span>
        </button>}
        <ChatCopyButton label="Copy conversation" className="chat-copy chat-copy-all" showLabel text={() => conversationMarkdown(turns, agentName)} />
      </div>}
      <ThreadPrimitive.Viewport ref={viewportRef} onScroll={onViewportScroll} aria-label="Conversation messages" role="region" className="chat-viewport" scrollToBottomOnRunStart={false} autoScroll={!snapshot.hasNewer && !paged}>
        <div className="chat-column">
          {(snapshot.transcript?.start ?? 0) > 0 && <button type="button" className="chat-button chat-button-outline self-center" disabled={snapshot.loadingEarlier} onClick={() => { recordAnchor(); setPaged(true); void viewer.loadEarlier(); }}>
            {snapshot.loadingEarlier ? 'Loading…' : `Earlier messages (${snapshot.transcript?.start})`}
          </button>}
          {view?.clearedAt && (snapshot.transcript?.start ?? 0) === 0 && <ClearedDivider at={view.clearedAt} />}
          {!snapshot.transcript && !view?.problem && <p role="status" className="chat-notice">{view?.status === 'starting' || !view ? `Starting ${agentName}…` : 'Loading conversation…'}</p>}
          <ChatBlocksContext.Provider value={rendering}>
            {turns.map(turn => <ChatTurnView key={turn.id} turn={turn} latest={turn === turns.at(-1)} waiting={waiting} actions={actions} />)}
          </ChatBlocksContext.Provider>
          {notes.map(note => <WorkerNoteLine key={note.worker.paneId} note={note} onOpen={actions.onOpenWorker} />)}
          {snapshot.hasNewer && <button type="button" className="chat-button chat-button-outline self-center" disabled={snapshot.loadingNewer} onClick={() => { recordAnchor(); setPaged(true); void viewer.loadNewer(); }}>
            {snapshot.loadingNewer ? 'Loading…' : 'Newer messages'}
          </button>}
          {!snapshot.hasNewer && view?.notice && <p role="status" className="chat-notice">{view.notice}</p>}
        </div>
      </ThreadPrimitive.Viewport>
      <div ref={footerRef} className="chat-composer-footer">
        <ScrollToLatest viewer={viewer} hasNewer={snapshot.hasNewer} follow={followLiveEnd} />
        {dock}
        {snapshot.pendingDelivery && <div className="chat-dock" role="status">
          <span>Delivery is unconfirmed.</span>
          <button type="button" className="chat-button chat-button-outline" disabled={!connected} onClick={() => void deliver(snapshot.pendingDelivery!, false)}>Check delivery</button>
          <button type="button" className="chat-button chat-button-outline" disabled={!connected} onClick={() => void deliver(snapshot.pendingDelivery!, true)}>Retry same message</button>
        </div>}
        {view?.questions.map(question => <ChatQuestionCard key={question.id} question={question} disabled={disabled || busy} onAnswer={answer => void act(() => client.answer(panelId, question.id, answer))} />)}
        {view?.permissions.map(permission => <ChatPermissionCard key={permission.id} permission={permission} agent={agentName} machine={machine && !machine.local ? machine.name : undefined}
          disabled={disabled || busy} composerEmpty={!snapshot.draft.trim()} onAnswer={answerPermission} />)}
        {/* A non-modal dialog inside the footer: the conversation above stays readable. */}
        {confirmClear && <dialog open className="chat-dock chat-confirm" role="alertdialog" aria-label="Clear the conversation?">
          <span>{agentName} is working. Clearing stops this turn and starts a fresh conversation.</span>
          <button type="button" className="chat-button chat-button-outline" onClick={() => setConfirmClear(false)}>Cancel</button>
          <button type="button" className="chat-button chat-button-primary" disabled={disabled} onClick={clearConversation}>Clear</button>
        </dialog>}
        <ChatQueue queue={view?.queue ?? []} working={working} disabled={disabled} label={rendering.queued}
          onRemove={operationId => void act(() => client.unqueue(panelId, operationId))}
          onSendNow={operationId => void act(() => client.sendNow(panelId, operationId))}
          onEdit={editQueued} />
        {view && <ChatStatusBar context={view.context} tasks={view.tasks}
          queued={view.queue.length} pr={pr} agents={agentsWorking} onOpenAgent={actions.onOpenWorker} working={working} phone={phone} onClear={clearable && !disabled ? requestClear : undefined}
          onStopTask={taskId => void act(() => client.stopTask(panelId, taskId))} onShowQueue={showQueue} />}
        <ComposerPrimitive.Root className="chat-composer">
          <ChatCommandMenu commands={commands} active={Math.min(commandIndex, commands.length - 1)} onPick={pickCommand} />
          <div className="flex flex-wrap gap-2 empty:hidden"><ComposerPrimitive.Attachments components={{ Attachment }} /></div>
          <ComposerPrimitive.Input readOnly={!!snapshot.pendingDelivery} aria-label={`Message ${agentName}`} placeholder={placeholder ?? 'Ask anything'} rows={1}
            // Pasted images and files attach through attachFiles, which shows any refusal.
            addAttachmentOnPaste={false}
            onPaste={event => {
              const files = [...event.clipboardData.files];
              if (!files.length) {
                // The composer lays out its whole text on every render: megabytes of it stall the window (D-7).
                if (event.clipboardData.getData('text/plain').length <= PASTE_LIMIT) return;
                event.preventDefault();
                setAttachProblems([`Nothing was pasted: the text is larger than 1 MiB, too large to paste into a message. Save it as a file, then attach the file or ask ${agentName} to read it.`]);
                return;
              }
              event.preventDefault();
              attachFiles(files);
            }}
            onChange={event => { viewer.setDraft(event.target.value); setCommandIndex(0); }}
            onKeyDown={event => {
              // Keys that pick an IME candidate are the input method's.
              if (event.nativeEvent.isComposing) return;
              // Esc stops the turn, as it does for the agent in a terminal.
              if (event.key === 'Escape' && working && !activeCommand) {
                event.preventDefault();
                void act(() => client.cancel(panelId));
                return;
              }
              if (clearable && event.key === 'Enter' && !event.shiftKey && isClearCommand(snapshot.draft) && (!activeCommand || activeCommand.name === CLEAR_COMMAND.name)) {
                event.preventDefault();
                requestClear();
                return;
              }
              // Cmd/Ctrl+Enter sends now: while a turn runs it interrupts it; otherwise it is a plain send.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
                event.preventDefault();
                sendNowNext.current = true;
                void runtime.thread.composer.send();
                return;
              }
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
          <div ref={actionsRef} className="chat-composer-actions" data-layout={phone ? 'phone' : 'desktop'} data-working={working || undefined}>
            {attachments && <ComposerPrimitive.AddAttachment aria-label={saveFile ? 'Attach files' : 'Attach image'} title={saveFile ? 'Attach photos or files' : 'Attach image'} className="chat-icon"><Plus className="h-4 w-4" /></ComposerPrimitive.AddAttachment>}
            {/* Model and mode stay on the composer row (D-267). */}
            {phone
              ? <ChatRiskyModeMarker mode={composerRow.mode} />
              : composerRow.mode && <ChatModeChip control={composerRow.mode} disabled={settingsLocked} configure={configure} />}
            <div className="chat-composer-end">
              {phone
                ? <ChatPhoneModelMenu arranged={composerRow} disabled={settingsLocked} configure={configure} />
                : <ChatModelMenu arranged={composerRow} disabled={settingsLocked} configure={configure} />}
              {working
                ? <>
                  <ComposerPrimitive.Send aria-label="Queue message" title={`Queue message: sends after this turn (Enter). Send now: ${sendNowKeys()}`} className="chat-icon"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>
                  <button type="button" aria-label="Stop agent turn" title="Stop" className="chat-send" onClick={() => void act(() => client.cancel(panelId))}><Square className="h-3.5 w-3.5 fill-current" /></button>
                </>
                : <ComposerPrimitive.Send aria-label="Send message" title="Send message" className="chat-send"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>}
            </div>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
