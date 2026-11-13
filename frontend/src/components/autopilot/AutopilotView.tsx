import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, MoreHorizontal, Navigation, Pause, Play, Plus, Shield } from 'lucide-react';
import type { AutopilotSnapshot } from '../../../../shared/types/autopilot';
import { cn } from '../../utils/cn';
import { markAutopilotOpened, moveAutopilotStack, runAutopilot, shownStackEntry, useAutopilotStore, useRenderedItems } from '../../stores/autopilotStore';
import { countsAsWaiting, useNotifyStore } from '../../stores/notifyStore';
import { useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { ApprovalColumn } from '../approvals/ApprovalColumn';
import { ApprovalOrigin } from '../approvals/ApprovalOrigin';
import { useActiveMachineStore } from '../../stores/activeMachineStore';
import { useNavigationStore } from '../../stores/navigationStore';
import type { ChatRendering } from '../chatTab/chatRendering';
import type { ChatTurnActions } from '../chatTab/ChatTurns';
import { useManySessionWorkers } from '../chatTab/sessionWorkers';
import { DESKTOP_WORKERS, openWorkerTab } from '../chatTab/desktopSessionWorkers';
import { workingAgents } from '../../../../shared/chatTabPresentation';
import { AutopilotItemRows } from './AutopilotItemRows';
import { AutopilotDecisionCard } from './AutopilotDecisionCard';
import { SentinelAwayCard, SentinelLogRows } from './AutopilotSentinelLog';
import { showActionError } from '../../stores/errorStore';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { offlineRows, offlineRowText } from '../approvals/approvalGroups';
import { withMachineLabels } from '../notify/notifyFormat';
import { AutopilotReach } from './AutopilotReach';
import { AutopilotStack } from './AutopilotStack';
import { useObservedContentBox } from '../../hooks/useObservedContentBox';
import { useOuterPanelResize } from '../../hooks/useOuterPanelResize';
import { OuterResizeSeparator } from '../ui/OuterResizeSeparator';
import { OUTER_PANEL_CONFIGS } from '../../utils/outerPanelSizing';
import { AWAY_BLOCK, controlLine, ITEMS_BLOCK, LOG_BLOCK, queuedControlLabel } from '../../../../shared/autopilotTranscript';

const ChatTabPanel = lazy(() => import('../chatTab/ChatTabPanel'));

/** ← → step the stack, unless the person is typing or a page has focus, or an approval covers it (F-9). */
function useStackKeys(covered: boolean) {
  useEffect(() => {
    if (covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW'].includes(target.tagName) || target.closest('[role="menu"]'))) return;
      event.preventDefault();
      moveAutopilotStack({ type: 'step', direction: event.key === 'ArrowLeft' ? -1 : 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [covered]);
}

/** Running on <Session> / Paused, and every Session with its count (D-59). */
function WalkBar({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const current = snapshot.walk.sessions.find((session) => session.id === snapshot.walk.sessionId);
  const moving = snapshot.walk.sessions.length;
  // Paused holds Sentinel's checks too, so Paused wins.
  const sentinelOn = snapshot.sentinel && snapshot.state === 'running';
  const status = sentinelOn
    ? `Sentinel on · keeping ${moving} ${moving === 1 ? 'Session' : 'Sessions'} moving · checks every 5 min`
    : snapshot.state === 'paused' ? 'Paused' : snapshot.state === 'stopped' ? 'Not started' : current ? `Running on ${current.name}` : 'Running';
  const sessions = snapshot.walk.sessions.filter((session) => session.waiting > 0 || session.id === snapshot.walk.sessionId);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-primary px-4 text-[12.5px]" data-testid="autopilot-walk">
      {/* Fixed box: the dot swaps colour, never size. */}
      <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
        <span className={cn('h-2 w-2 rounded-full', sentinelOn ? 'bg-autopilot' : snapshot.state === 'running' ? 'bg-status-success' : snapshot.state === 'paused' ? 'bg-status-warning' : 'bg-status-neutral')} />
      </span>
      <span className={cn('min-w-0 truncate font-medium', sentinelOn ? 'text-autopilot-on-tint' : 'text-text-primary')} data-testid="autopilot-walk-status">{status}</span>
      <div className="scrollbar-thin scroll-fade-x flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {sessions.map((session) => (
          <span key={session.id} data-testid="autopilot-walk-session" title={session.name}
            className={cn('inline-flex min-w-16 max-w-[50%] items-center gap-1 rounded-full px-2 py-px', session.id === snapshot.walk.sessionId ? 'bg-autopilot-subtle text-autopilot-on-tint' : 'bg-surface-tertiary text-text-secondary')}>
            <span className="min-w-0 truncate">{session.name}</span><span className="shrink-0 tabular-nums opacity-80">{session.waiting}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Before Start (D-57): opening Autopilot never starts an agent turn. */
function StartCard({ snapshot, pending }: { snapshot: AutopilotSnapshot; pending: boolean }) {
  const blocked = !snapshot.entitlement.entitled ? `${snapshot.entitlement.reason ?? ''} ${snapshot.entitlement.next ?? ''}`.trim()
    : !snapshot.chatTabsEnabled ? 'Autopilot runs as a chat tab: turn on Chat tabs in Settings › AI & Agents.' : null;
  // With history in the chat (a stopped run), a slim bar, so the earlier conversation stays in view.
  if (snapshot.stack.entries.length > 0) {
    return (
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border-primary bg-autopilot-subtle px-4 py-2 text-[13px]" data-testid="autopilot-start" role="status">
        <Navigation className="h-4 w-4 shrink-0 text-autopilot" aria-hidden="true" />
        <span className="min-w-0 flex-1 leading-snug text-text-primary">{blocked ?? 'Autopilot is stopped. Start picks the walk up where it was.'}</span>
        <button type="button" disabled={pending || !!blocked} onClick={() => void runAutopilot('start')} data-testid="autopilot-start-button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50">
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> Start
        </button>
      </div>
    );
  }
  return (
    // Lines up with the composer: the chat's column width and gutters.
    <div className="mx-auto w-full max-w-[var(--thread-max-width)] shrink-0 p-4" data-testid="autopilot-start">
      <div className="rounded-2xl bg-surface-primary p-5 shadow-card ring-1 ring-autopilot-border">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-text-primary">
          <Navigation className="h-4 w-4 text-autopilot" aria-hidden="true" />
          {snapshot.stack.entries.length > 0 ? 'Autopilot is stopped' : 'Autopilot is ready'}
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
          Press Start and Autopilot reads every Session and what waits on you, then walks them from the top, one item at a time on the stack. It can answer and close approvals when the way is clear or you tell it to, with a receipt you can override; permission prompts stay yours.
        </p>
        {blocked && <p className="mt-2 text-[13px] text-status-warning-on-tint" role="alert">{blocked}</p>}
        <button type="button" disabled={pending || !!blocked} onClick={() => void runAutopilot('start')} data-testid="autopilot-start-button"
          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-interactive px-4 text-[13.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50">
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> Start
        </button>
      </div>
    </div>
  );
}

/**
 * The current item's card when no message in view holds it (pushed later, or its message scrolled
 * out of the window): docked above the composer, so the question is always in the chat (D-91).
 */
function CurrentDock({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const shown = shownStackEntry(snapshot);
  const notifyId = shown?.ref.kind === 'item' && shown.doneAt === undefined ? shown.ref.notifyId : undefined;
  const item = useNotifyStore((state) => (notifyId ? state.snapshot?.items.find((candidate) => candidate.id === notifyId) : undefined));
  const rendered = useRenderedItems((state) => (notifyId ? (state.counts[notifyId] ?? 0) > 0 : false));
  const machines = useAllMachinesStore((state) => state.entries);
  if (!item || rendered) return null;
  // Its machine can't be reached: nothing to answer, so no card.
  if (item.unreachable) {
    const [row] = offlineRows(withMachineLabels([item], machines));
    return row ? <p className="mx-auto w-full max-w-[var(--thread-max-width)] px-6 pb-2 text-[12.5px] text-text-tertiary" data-testid="autopilot-dock-offline">{offlineRowText(row)}</p> : null;
  }
  return (
    <div className="mx-auto w-full max-w-[var(--thread-max-width)] px-6 pb-2" data-testid="autopilot-dock">
      <AutopilotDecisionCard item={item} current />
    </div>
  );
}

/** Sentinel Mode (package 7): one toggle in the header. On also starts Autopilot. */
function SentinelToggle({ snapshot, pending }: { snapshot: AutopilotSnapshot; pending: boolean }) {
  const [busy, setBusy] = useState(false);
  const blocked = !snapshot.entitlement.entitled || !snapshot.chatTabsEnabled;
  const toggle = () => {
    setBusy(true);
    void window.electronAPI.autopilot.setSentinel(!snapshot.sentinel)
      .then((next) => useAutopilotStore.setState({ snapshot: next }))
      .catch((error: Error) => showActionError(snapshot.sentinel ? 'Could not turn Sentinel off' : 'Could not turn Sentinel on', error))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" role="switch" aria-checked={snapshot.sentinel} aria-label="Sentinel" disabled={pending || busy || (blocked && !snapshot.sentinel)} onClick={toggle} data-testid="autopilot-sentinel"
      title={snapshot.sentinel ? 'Sentinel keeps your Sessions moving while you are away. Turn it off when you are back.' : 'Keep Sessions moving while you are away: answers only what a plan or decision settles, nudges stalls, pushes the rest to your phone.'}
      className={cn('inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-2.5 text-[12.5px] font-medium disabled:opacity-50',
        snapshot.sentinel ? 'border-autopilot-border bg-autopilot-subtle text-autopilot-on-tint' : 'border-border-secondary text-text-secondary hover:bg-surface-hover')}>
      <Shield className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden min-[1440px]:inline">Sentinel</span>
      {/* Fixed-size track: the knob moves, nothing around it does. */}
      <span className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', snapshot.sentinel ? 'bg-autopilot' : 'bg-surface-tertiary')} aria-hidden="true">
        <span className={cn('absolute left-0 top-0.5 h-3 w-3 rounded-full bg-surface-primary shadow transition-transform', snapshot.sentinel ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </span>
    </button>
  );
}

/** Less-used run actions: the run's folder, and New Autopilot Session with its confirm. */
function RunMenu({ snapshot, pending }: { snapshot: AutopilotSnapshot; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setConfirmNew(false); return; }
    const onDown = (event: MouseEvent) => { if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const folder = snapshot.run?.folder;
  const item = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-primary hover:bg-surface-hover disabled:opacity-50';
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label="More" title="More" onClick={() => setOpen((value) => !value)} data-testid="autopilot-menu"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-secondary text-text-secondary hover:bg-surface-hover">
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-dropdown mt-1 w-[290px] rounded-xl bg-surface-primary p-1.5 shadow-card ring-1 ring-border-secondary">
          {folder && (
            <button type="button" role="menuitem" className={item} title={folder} data-testid="autopilot-folder"
              onClick={() => { setOpen(false); void window.electronAPI.openExternal(`file://${folder}`); }}>
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="block">Open its folder</span><span className="block truncate text-[11.5px] text-text-tertiary">{snapshot.run?.id}</span></span>
            </button>
          )}
          {!confirmNew ? (
            <button type="button" role="menuitem" className={item} disabled={pending} onClick={() => setConfirmNew(true)} data-testid="autopilot-new-run">
              <Plus className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" /> New Autopilot Session…
            </button>
          ) : (
            <div className="rounded-lg bg-autopilot-subtle px-2.5 py-2 text-[12.5px] text-text-secondary">
              <p>A new Autopilot Session gets a new folder and an empty stack. This one&rsquo;s documents stay in its folder.{snapshot.state !== 'stopped' ? ` Autopilot stops${snapshot.sentinel ? ' and Sentinel turns off' : ''}; press Start to begin the new one.` : ''}</p>
              <div className="mt-2 flex gap-1.5">
                <button type="button" disabled={pending} onClick={() => { setOpen(false); void runAutopilot('newRun'); }} data-testid="autopilot-new-run-confirm"
                  className="inline-flex h-7 items-center rounded-lg bg-interactive px-2.5 font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50">Start a new one</button>
                <button type="button" onClick={() => setConfirmNew(false)} className="inline-flex h-7 items-center rounded-lg px-2.5 text-text-secondary hover:bg-surface-hover">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Fits at any width: the controls the person uses most stay; the rest are in the menu. It never
 * clips its overflow, so the ⋯ menu can hang below it.
 */
function Header({ snapshot, pending }: { snapshot: AutopilotSnapshot; pending: boolean }) {
  return (
    <header className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-border-primary px-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-autopilot-subtle"><Navigation className="h-4 w-4 text-autopilot" aria-hidden="true" /></span>
      <h1 className="shrink-0 text-[15px] font-semibold text-text-primary">Autopilot</h1>
      <span className="hidden shrink-0 rounded px-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-autopilot-on-tint ring-1 ring-autopilot-border min-[1440px]:inline">Experimental</span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <SentinelToggle snapshot={snapshot} pending={pending} />
        {snapshot.state === 'running' && (
          <button type="button" disabled={pending} onClick={() => void runAutopilot('pause')} data-testid="autopilot-pause" aria-label="Pause" title="Pause: bring nothing new until Go on"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-secondary px-2 text-[12.5px] text-text-secondary hover:bg-surface-hover disabled:opacity-50">
            <Pause className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden min-[1440px]:inline">Pause</span>
          </button>
        )}
        {snapshot.state === 'paused' && (
          <button type="button" disabled={pending} onClick={() => void runAutopilot('goOn')} data-testid="autopilot-go-on" aria-label="Go on" title="Go on"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-interactive px-2 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50">
            <Play className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden min-[1440px]:inline">Go on</span>
          </button>
        )}
        <RunMenu snapshot={snapshot} pending={pending} />
      </div>
    </header>
  );
}

const RENDERING: ChatRendering = {
  blocks: {
    [ITEMS_BLOCK]: (content) => <AutopilotItemRows content={content} />,
    [LOG_BLOCK]: (content) => <SentinelLogRows content={content} />,
    [AWAY_BLOCK]: (content) => <SentinelAwayCard content={content} />,
  },
  userMessage: (text) => {
    const line = controlLine(text);
    if (line === undefined) return undefined;
    // Pane's own wake-ups for Autopilot (Sentinel's 5-minute check) show nothing.
    if (line === '') return null;
    return <p className="chat-notice text-center" data-testid="autopilot-control-line">{line}</p>;
  },
  // Waiting to send, a Pane line reads as its notice, not its instructions to the agent.
  queued: queuedControlLabel,
};

/**
 * Autopilot (D-46): its chat on the left and the stack on the right, the walk bar above. It is
 * not a Session view: no Pane associations, nothing of a Session's.
 */
export function AutopilotView() {
  const snapshot = useAutopilotStore((state) => state.snapshot);
  const pending = useAutopilotStore((state) => state.pending);
  const machine = useActiveMachineStore((state) => state.machine);
  const navigateToSessions = useNavigationStore((state) => state.navigateToSessions);
  const approvalOpen = useApprovalColumnStore((state) => state.open.autopilot !== undefined);
  useStackKeys(approvalOpen);
  // "N working" above the chat box counts the agents working in every Session Autopilot walks (D-276).
  const walkIds = useMemo(() => snapshot?.walk.sessions.map(session => session.id) ?? [], [snapshot?.walk.sessions]);
  const walkWorkers = useManySessionWorkers(DESKTOP_WORKERS, walkIds);
  const working = useMemo(() => workingAgents(walkWorkers), [walkWorkers]);
  const actions = useMemo<ChatTurnActions>(() => ({ onOpenWorker: (paneId, panelId) => { void openWorkerTab(paneId, panelId); } }), []);
  // The chat's width is the person's (drag its edge; double-click resets). Too narrow for the chat
  // and the stack at their minimums, the chat keeps its fluid width.
  const viewBox = useObservedContentBox<HTMLDivElement>();
  const chatResize = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.autopilotChat, containerPx: viewBox.width, enabled: !!snapshot });
  const chatSized = chatResize.separatorVisible;
  // Opening Autopilot, or coming back to Pane on it, is how the person returns while Sentinel stays on (J29).
  useEffect(() => {
    markAutopilotOpened();
    const onFocus = () => markAutopilotOpened();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  // Turning Autopilot off while it is open leaves for the Sessions home.
  useEffect(() => { if (snapshot && !snapshot.enabled) navigateToSessions(); }, [snapshot, navigateToSessions]);
  if (!snapshot) return <div className="flex flex-1 items-center justify-center bg-bg-primary text-[13px] text-text-tertiary">Loading Autopilot…</div>;
  const fresh = snapshot.state === 'stopped' && snapshot.stack.entries.length === 0;

  return (
    <div ref={viewBox.ref} className="autopilot-view flex min-h-0 min-w-0 flex-1 bg-bg-primary" data-testid="autopilot-view" data-state={snapshot.state}>
      <section aria-label="Autopilot chat"
        className={cn('relative flex min-h-0 flex-col border-r border-border-primary', chatSized ? 'shrink-0' : 'w-[44%] min-w-[340px] max-w-[720px]')}
        style={chatSized ? { width: chatResize.renderedPx } : undefined}>
        {/* On the chat's right edge, over its border. */}
        {chatSized && (
          <OuterResizeSeparator label="Resize Autopilot chat" orientation="vertical" value={chatResize.effectivePx}
            minimum={chatResize.floor} maximum={chatResize.cap} className="!left-auto -right-1" {...chatResize.separatorHandlers} />
        )}
        <Header snapshot={snapshot} pending={pending} />
        <WalkBar snapshot={snapshot} />
        <AutopilotReach snapshot={snapshot} />
        {/* The Start card sits on the chat's surface, not in a band of its own. Before the first
            Start the status line has nothing to show but its "…", so it stays out until then. */}
        <div className={cn('agent-chat flex min-h-0 flex-1 flex-col', fresh && '[&_.chat-statusline]:hidden')}>
          {/* Start follows Autopilot's state, not the chat's: after a restart the agent reloads its conversation but waits for Start. */}
          {snapshot.panelId && snapshot.state === 'stopped' && <StartCard snapshot={snapshot} pending={pending} />}
          <div className="min-h-0 flex-1">
            {snapshot.panelId ? (
              <Suspense fallback={null}>
                <ChatTabPanel
                  clearable={false}
                  key={snapshot.panelId}
                  panelId={snapshot.panelId}
                  client={window.electronAPI.chatTab}
                  machine={machine}
                  placeholder="Message Autopilot…"
                  rendering={RENDERING}
                  // Stopped on purpose (before Start): the Start card above stands in for the stopped notice.
                  stoppedNotice={<span hidden />}
                  dock={<CurrentDock snapshot={snapshot} />}
                  working={working}
                  actions={actions}
                />
              </Suspense>
            ) : <StartCard snapshot={snapshot} pending={pending} />}
          </div>
        </div>
      </section>
      <StackWithApproval />
    </div>
  );
}

/**
 * The Stack, with an approval's column laid over it when one is open from the chat (J16). The
 * Stack stays mounted underneath, so ✕ shows the same entry, with its pages as they were.
 */
function StackWithApproval() {
  const open = useApprovalColumnStore((state) => state.open.autopilot);
  const items = useNotifyStore((state) => state.snapshot?.items);
  const order = useMemo(() => (items ?? []).filter(countsAsWaiting).sort((a, b) => a.createdAt - b.createdAt).map((item) => item.id), [items]);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <AutopilotStack />
      {open && (
        <div className="absolute inset-0 z-30 flex bg-bg-primary" data-testid="autopilot-approval">
          <ApprovalColumn
            surface="autopilot"
            itemId={open.itemId}
            order={order}
            onSelect={(id) => useApprovalColumnStore.getState().openApproval('autopilot', id)}
            groupLabel="Waiting on you"
            closeLabel="Back to the Stack"
            onClose={() => useApprovalColumnStore.getState().close('autopilot')}
            renderOrigin={(item) => <ApprovalOrigin item={item} />}
          />
        </div>
      )}
    </div>
  );
}
