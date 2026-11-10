import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, CircleCheck, CircleHelp, ExternalLink, Folder, GitBranch, Inbox, MessageSquare, MessagesSquare, Navigation, ShieldAlert, WifiOff } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { cn } from '../../utils/cn';
import { useNotifyStore } from '../../stores/notifyStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { usePanelStore } from '../../stores/panelStore';
import { showActionError } from '../../stores/errorStore';
import { openOnMachine } from '../../utils/machineRowActions';
import { MachineMark } from '../machines/MachineMark';
import { Dropdown } from '../ui/Dropdown';
import { relativeAge, withMachineLabels } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { SessionBeside } from '../PaneChatView';
import { ApprovalColumn, ApprovalChip } from './ApprovalColumn';
import { cardChip } from './approvalCard';
import { APPROVALS_SORTS, approvalIdsInListOrder, approvalRowLines, besideOf, connectedOf, groupApprovals, groupCountText, offlineRowText, readApprovalsSort, saveApprovalsSort, type ApprovalGroup, type ApprovalsSort, type ApprovalsTab, type Beside, type OfflineRow } from './approvalGroups';
import { MachineContext } from './MachineContext';
import { handleApprovalsEscape } from './approvalsNavigation';
import { toggleApprovals } from './approvalsNavigation';
import { useSidebarSessionOrder } from './useSidebarSessionOrder';
import { useObservedContentBox } from '../../hooks/useObservedContentBox';
import { useOuterPanelResize } from '../../hooks/useOuterPanelResize';
import { OuterResizeSeparator } from '../ui/OuterResizeSeparator';
import { OUTER_PANEL_CONFIGS } from '../../utils/outerPanelSizing';

/** Side by side from 1100px (the `min-[1100px]:` layout below); stacked under it. */
const SIDE_BY_SIDE = '(min-width: 1100px)';

function useSideBySide() {
  const [matches, setMatches] = useState(() => window.matchMedia(SIDE_BY_SIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(SIDE_BY_SIDE);
    const onChange = () => setMatches(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return matches;
}


function ItemIcon({ item }: { item: NotifyItem }) {
  const className = 'mt-0.5 h-4 w-4 shrink-0';
  if (item.source.autopilot) return <Navigation className={cn(className, 'text-autopilot')} aria-hidden="true" />;
  if (item.agentPrompt) return <ShieldAlert className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  if (item.ui === 'approve') return <CircleCheck className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  if (item.ui === 'ask') return <MessagesSquare className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  return <CircleHelp className={cn(className, 'text-status-warning')} aria-hidden="true" />;
}

function useMachineMark() {
  const machines = useAllMachinesStore((state) => state.entries);
  return (machineId: string | undefined, dimmed = false) => {
    const machine = machineId ? machines.find((entry) => entry.id === machineId) : undefined;
    return machine ? <MachineMark letters={machine.letters} slot={machine.slot} presence={dimmed ? 'dimmed' : 'solid'} size="logo" /> : null;
  };
}

function GroupHeader({ group, mark, count }: { group: ApprovalGroup; mark: ReactNode; count: string }) {
  const Icon = group.autopilot ? Navigation : group.project ? Folder : group.session ? MessageSquare : GitBranch;
  return (
    <div className={cn('flex items-center gap-2 border-b border-border-secondary bg-surface-secondary px-3 py-2 text-[12.5px] font-semibold', group.autopilot ? 'text-autopilot-on-tint' : 'text-text-primary')} data-testid="approvals-group">
      <Icon className={cn('h-3.5 w-3.5 shrink-0', group.autopilot ? 'text-autopilot' : 'text-text-tertiary')} aria-hidden="true" />
      <span className="min-w-0 truncate">{group.label}</span>
      {group.machine && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-tertiary px-1.5 py-px font-mono text-[11px] text-text-secondary">
          {mark}{group.machine}
        </span>
      )}
      <span className="ml-auto shrink-0 rounded-full bg-surface-tertiary px-2 py-px text-[11.5px] font-medium tabular-nums text-text-secondary" data-testid="approvals-group-count">{count}</span>
    </div>
  );
}

function ItemRow({ item, now, selected = false, onSelect }: { item: NotifyItem; now: number; selected?: boolean; onSelect: (fromKeyboard: boolean) => void }) {
  const done = item.state === 'answered' || item.state === 'expired' || item.state === 'info';
  const { acted, origin } = approvalRowLines(item);
  const chip = cardChip(item);
  return (
    <button
      type="button"
      // Enter or Space reports no clicks (detail 0): the card that replaces this row takes the focus.
      onClick={(event) => onSelect(event.detail === 0)}
      aria-current={selected || undefined}
      data-approval-selected={selected || undefined}
      data-testid="approvals-row"
      className={cn(
        'flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
        selected && 'bg-surface-selected',
        item.unreachable && 'opacity-60',
      )}
    >
      {done ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" /> : <ItemIcon item={item} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-text-primary">{item.relay?.question ?? item.title}</span>
        {acted && <span className="block truncate text-[12px] text-text-tertiary" data-testid="approvals-row-receipt">{acted}</span>}
        <span className="block truncate text-[12px] text-text-tertiary">
          {origin}
          {item.unreachable ? ` · ${item.machine ?? 'its machine'} can't be reached` : ''}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[12px] tabular-nums text-text-tertiary">{relativeAge(item.resolvedAt ?? item.createdAt, now)}</span>
        {chip && chip.tone !== 'success' && <ApprovalChip chip={chip} testId="approvals-row-chip" />}
      </span>
    </button>
  );
}

/** Newer rows held out of view above the selected card, one click from the top. */
function RowsAbove({ count, onTop }: { count: number; onTop: () => void }) {
  return (
    <button
      type="button"
      onClick={onTop}
      className="absolute left-1/2 top-1 z-10 inline-flex h-6 -translate-x-1/2 items-center gap-1 rounded-full bg-surface-primary px-2.5 text-[12px] font-medium text-text-secondary shadow-card ring-1 ring-border-secondary hover:text-text-primary"
      data-testid="approvals-rows-above"
    >
      <ArrowUp className="h-3 w-3" aria-hidden="true" />
      {count} more above
    </button>
  );
}

function OfflineMachineRow({ row }: { row: OfflineRow }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 text-[12.5px] text-text-tertiary" data-testid="approvals-offline-row">
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{offlineRowText(row)}</span>
    </div>
  );
}

function BesideHeader({ beside, mark, onOpen }: { beside: Beside; mark: ReactNode; onOpen?: () => void }) {
  if (beside.kind === 'machine') {
    const { connected, machine } = beside;
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-primary px-4 text-[13px]" data-testid="approvals-machine-header">
        {connected.kind === 'session' ? <MessageSquare className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" /> : connected.kind === 'pane' ? <GitBranch className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" /> : null}
        {connected.kind === 'session' && <span className="text-text-tertiary">Session</span>}
        {connected.kind === 'pane' && <span className="text-text-tertiary">Pane</span>}
        <span className="min-w-0 truncate font-semibold text-text-primary">{connected.name}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-text-tertiary">{mark}{machine}</span>
        {onOpen && (
          <button type="button" onClick={onOpen} className="ml-auto inline-flex shrink-0 items-center gap-1 text-text-tertiary hover:text-text-primary">
            Open on {machine} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }
  if (beside.kind !== 'session' && beside.kind !== 'pane') return null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-primary px-4 text-[13px]">
      {beside.kind === 'session' ? <MessageSquare className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" /> : <GitBranch className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
      <span className="text-text-tertiary">{beside.kind === 'session' ? 'Session' : 'Pane'}</span>
      <span className="min-w-0 truncate font-semibold text-text-primary">{beside.name}</span>
      {mark}
      {onOpen && (
        <button type="button" onClick={onOpen} className="ml-auto inline-flex shrink-0 items-center gap-1 text-text-tertiary hover:text-text-primary">
          Open in Pane <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Makes another machine the one the app is on, with nothing to open there; says so when it can't. */
async function switchToMachine(machineId: string, name: string): Promise<boolean> {
  const { switchMachine } = useAllMachinesStore.getState();
  if (!switchMachine) return false;
  try {
    const outcome = await switchMachine(machineId);
    if (outcome.ok) return true;
    showActionError(`Could not open ${name}`, outcome.needsPassword ? `${name} needs its password. Enter it in Remote Access settings, then try again.` : outcome.error);
  } catch (error) {
    showActionError(`Could not open ${name}`, error);
  }
  return false;
}

/**
 * Approvals: what waits on you, newest first or in groups, beside the selected item's live Session
 * or Pane. `paneView` is the active Pane's own shell (SessionView's), shown for a Pane's item.
 */
export function ApprovalsView({ paneView }: { paneView: ReactNode }) {
  const snapshot = useNotifyStore((state) => state.snapshot);
  // Approvals turned off (here, or saved off and restored on launch): back to the view you left, as the row would.
  const turnedOff = snapshot?.settings.enabled === false;
  // Esc goes back to where you were, unless an answer is being typed (D-251).
  useEffect(() => {
    window.addEventListener('keydown', handleApprovalsEscape);
    return () => window.removeEventListener('keydown', handleApprovalsEscape);
  }, []);
  useEffect(() => {
    if (turnedOff) toggleApprovals();
  }, [turnedOff]);
  const [tab, setTab] = useState<ApprovalsTab>('waiting');
  // The list's width is the person's (drag the edge; double-click resets), side by side only.
  const inboxBox = useObservedContentBox<HTMLDivElement>();
  const sideBySide = useSideBySide();
  const listResize = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.approvalsList, containerPx: inboxBox.width, enabled: sideBySide });
  const listSized = listResize.separatorVisible;
  const selectedId = useNavigationStore((state) => state.selectedApprovalId);
  const selectApproval = useNavigationStore((state) => state.selectApproval);
  const activePaneId = useSessionStore((state) => state.activeSessionId);
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const machineMark = useMachineMark();
  const now = useNow();
  const machines = useAllMachinesStore((state) => state.entries);
  const items = useMemo(() => withMachineLabels(snapshot?.items ?? [], machines), [snapshot, machines]);
  const [sort, setSort] = useState<ApprovalsSort>(() => readApprovalsSort());
  const sidebarOrder = useSidebarSessionOrder(sort === 'sidebar');
  const { waiting, answered, list, groups, stale, offline } = useMemo(() => groupApprovals(items, tab, sort, sidebarOrder), [items, tab, sort, sidebarOrder]);
  const [staleExpanded, setStaleExpanded] = useState(false);
  // An item opened from elsewhere (a link, the strip) shows even when its group is collapsed.
  const staleOpen = staleExpanded || stale.some((item) => item.id === selectedId);
  const shown = [...list, ...(staleOpen ? stale : [])];
  // The selection follows its item into its Undo hold; once it leaves the tab, the first item takes over.
  const selected = shown.find((item) => item.id === selectedId) ?? (tab === 'waiting' ? shown[0] : undefined);
  // That first item is then the selection, so a newer item arriving on top doesn't take over from it.
  const firstToPin = selected && selected.id !== selectedId ? selected.id : undefined;
  useEffect(() => {
    if (firstToPin) selectApproval(firstToPin);
  }, [firstToPin, selectApproval]);

  // An item arriving above the selected row pushes it down: scroll by as much, so it stays where the
  // person is reading it. Changing the tab, the sort or the selection moves it on purpose.
  const listRef = useRef<HTMLDivElement>(null);
  const listSpacerRef = useRef<HTMLDivElement>(null);
  // A row picked with the keyboard: its card takes the focus once it renders.
  const focusCard = useRef(false);
  const lastSelected = useRef<{ id: string; tab: ApprovalsTab; sort: ApprovalsSort; offset: number; rounding: number } | null>(null);
  const selectedRowId = selected?.id;
  // Each tab is its own list: it opens at its top, not at the other tab's scroll position.
  useLayoutEffect(() => {
    if (listSpacerRef.current) listSpacerRef.current.style.height = '0px';
    listRef.current?.scrollTo({ top: 0 });
  }, [tab]);
  useLayoutEffect(() => {
    const listElement = listRef.current;
    const row = listElement?.querySelector('[data-approval-selected]');
    if (!listElement || !row || !selectedRowId) {
      lastSelected.current = null;
      // No card to focus or hold still (another tab, the item left): the count follows this list, and a pending focus lapses.
      focusCard.current = false;
      countAbove();
      return;
    }
    // From the top of the content, so the person's own scrolling doesn't count as a move.
    const offset = row.getBoundingClientRect().top - listElement.getBoundingClientRect().top + listElement.scrollTop;
    const last = lastSelected.current;
    let rounding = 0;
    const spacer = listSpacerRef.current;
    if (!last || last.id !== selectedRowId || last.tab !== tab || last.sort !== sort) {
      if (spacer) spacer.style.height = '0px';
    } else {
      rounding = last.rounding;
      if (offset !== last.offset) {
        // The browser rounds scrollTop: carry what it dropped, or arrivals add up to a visible drift.
        const wanted = listElement.scrollTop + rounding + offset - last.offset;
        // A list too short to scroll that far gets the room, so the row holds still there too (D-176).
        if (spacer) {
          // Measured from the content's end: on a list shorter than the viewport, scrollHeight hides the empty space.
          const content = spacer.getBoundingClientRect().top - listElement.getBoundingClientRect().top + listElement.scrollTop;
          spacer.style.height = `${Math.max(spacer.offsetHeight, Math.ceil(wanted + listElement.clientHeight - content))}px`;
        }
        listElement.scrollTop = wanted;
        rounding = wanted - listElement.scrollTop;
      }
    }
    lastSelected.current = { id: selectedRowId, tab, sort, offset, rounding };
    countAbove();
    if (focusCard.current) {
      focusCard.current = false;
      // The card itself, not its first choice: Enter again (or a held Enter) must not answer.
      if (row instanceof HTMLElement) row.focus();
    }
  });

  // Holding the selected card still can carry newer rows out of view above it: say so, one click from the top.
  const [rowsAbove, setRowsAbove] = useState(0);
  const countAbove = () => {
    const listElement = listRef.current;
    if (!listElement) return;
    const top = listElement.getBoundingClientRect().top;
    setRowsAbove([...listElement.querySelectorAll('[data-testid="approvals-row"]')].filter((row) => row.getBoundingClientRect().bottom <= top + 1).length);
  };

  const beside: Beside = selected ? besideOf(selected, activeMachineId) : { kind: 'none' };
  const besidePaneId = beside.kind === 'pane' ? beside.paneId : undefined;
  const besidePanelId = beside.kind === 'pane' ? beside.panelId : undefined;
  // A Session's item is about its orchestrator: show the orchestrator's tab (the asking one,
  // or for a fallback item the Session's current orchestrator tab), not the last tab opened there.
  const orchestratorPanelId = useOrchestrationSessionStore((state) => {
    if (beside.kind !== 'session' || !selected) return undefined;
    // Autopilot's item about a Session asks from Autopilot's own tab, not one of the Session's.
    if (!selected.relay && !selected.source.autopilot && selected.source.panelId) return selected.source.panelId;
    const record = state.sessions.find((session) => session.id === beside.sessionId);
    return record ? record.panelIds[record.agent] : undefined;
  });
  const sessionPaneId = beside.kind === 'session' ? beside.paneId : undefined;
  const shownItemId = selected?.id;

  // A Pane's item shows that Pane's own shell on the right, on the asking tab. The shell applies
  // an activation request once its layout has loaded, so it wins over the tab the Pane remembers;
  // re-run per selection, since a link opened since then may have taken the front.
  useEffect(() => {
    if (!besidePaneId) return;
    if (besidePanelId) usePanelStore.getState().requestActivation({ sessionId: besidePaneId, panelId: besidePanelId });
    if (useSessionStore.getState().activeSessionId !== besidePaneId) void useSessionStore.getState().setActiveSession(besidePaneId);
  }, [besidePaneId, besidePanelId, selected?.id]);

  useEffect(() => {
    if (!sessionPaneId || !orchestratorPanelId) return;
    // The Session workspace follows activation requests, as for a tab an agent opens.
    // Re-run per selection: a link opened since then may have taken the front.
    usePanelStore.getState().requestActivation({ sessionId: sessionPaneId, panelId: orchestratorPanelId });
  }, [sessionPaneId, orchestratorPanelId, shownItemId]);

  const navigateToAutopilot = useNavigationStore((state) => state.navigateToAutopilot);
  const openConnected = (item: NotifyItem) => {
    const connected = connectedOf(item);
    const machineId = item.machineId ?? activeMachineId;
    if (connected.kind === 'session' || connected.kind === 'pane') {
      void openOnMachine(machineId, { kind: connected.kind, id: connected.id, name: connected.name });
    } else if (connected.kind === 'autopilot') {
      if (machineId === activeMachineId) navigateToAutopilot();
      else void switchToMachine(machineId, item.machine ?? 'that machine').then((ok) => { if (ok) navigateToAutopilot(); });
    } else if (machineId !== activeMachineId) {
      void switchToMachine(machineId, item.machine ?? 'that machine');
    }
  };
  const openInPane = (item: NotifyItem, target: Beside) => {
    if (target.kind === 'autopilot') { navigateToAutopilot(); return; }
    const machineId = item.machineId ?? activeMachineId;
    if (target.kind === 'session') void openOnMachine(machineId, { kind: 'session', id: target.sessionId, name: target.name });
    else if (target.kind === 'pane') void openOnMachine(machineId, { kind: 'pane', id: target.paneId, name: target.name });
    else if (target.kind === 'machine') openConnected(item);
  };

  const tabButton = (id: ApprovalsTab, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn('rounded-md px-2.5 py-[3px]', tab === id ? 'bg-surface-primary font-medium text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-primary')}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );

  // The list stays compact rows; the selected approval opens in the column beside it (P4).
  const renderItem = (item: NotifyItem) => (
    <ItemRow key={item.id} item={item} now={now} selected={item.id === selected?.id} onSelect={(fromKeyboard) => { focusCard.current = fromKeyboard; selectApproval(item.id); }} />
  );
  // The pager follows the list as grouped (J14).
  const order = approvalIdsInListOrder({ list, stale: staleOpen ? stale : [] });
  const origin = (
    <div className="absolute inset-0 flex flex-col" data-testid="approvals-origin">
      <BesideHeader
        beside={beside}
        mark={selected ? machineMark(selected.machineId) : null}
        onOpen={selected ? () => openInPane(selected, beside) : undefined}
      />
      {beside.kind === 'session' && <SessionBeside key={beside.sessionId} sessionId={beside.sessionId} />}
      {beside.kind === 'pane' && (activePaneId === beside.paneId ? paneView : null)}
      {beside.kind === 'machine' && selected && <MachineContext key={selected.id} item={selected} machine={beside.machine} connectedName={beside.connected.name} />}
    </div>
  );
  const chooseSort = (next: ApprovalsSort) => {
    setSort(next);
    saveApprovalsSort(next);
  };
  const toggleStale = () => {
    // Collapsing lets go of an item in it, or it would hold the group open.
    if (staleOpen && stale.some((item) => item.id === selectedId)) selectApproval(null);
    setStaleExpanded(!staleOpen);
  };

  const enabled = snapshot?.settings.enabled ?? true;
  const importError = snapshot?.importError;
  return (
    <div ref={inboxBox.ref} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary min-[1100px]:flex-row" data-testid="notify-inbox" data-focus-region="approvals">
      <section
        aria-label="Approvals"
        // Stacked (a narrow window), the list takes the height when nothing shows beside it.
        className={cn('flex min-h-0 flex-col border-b border-border-primary bg-bg-secondary min-[1100px]:max-h-none min-[1100px]:w-[400px] min-[1100px]:flex-none min-[1100px]:shrink-0 min-[1100px]:border-b-0 min-[1100px]:border-r', !selected ? 'flex-1' : 'max-h-[45%] shrink-0')}
        style={listSized ? { width: listResize.renderedPx } : undefined}
        data-testid="approvals-queue"
      >
        <header className="flex h-[50px] shrink-0 items-center gap-2.5 px-4">
          <h1 className="text-[15px] font-semibold text-text-primary">Approvals</h1>
          <div role="tablist" aria-label="Approvals" className="inline-flex gap-0.5 rounded-[9px] bg-surface-tertiary p-[3px] text-[12.5px]">
            {tabButton('waiting', 'Waiting', waiting)}
            {tabButton('answered', 'Answered', answered)}
          </div>
        </header>
        {importError && (
          <p className="shrink-0 truncate px-4 pb-1.5 text-[12px] text-status-warning" role="status" title={`${importError.message} ${importError.next}`} data-testid="approvals-import-error">
            {importError.message} {importError.next}
          </p>
        )}
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1">
          <span className="text-[12.5px] text-text-tertiary" aria-hidden="true">Group by</span>
          <Dropdown
            className="inline-block"
            trigger={
              <button
                type="button"
                aria-label={`Group by: ${APPROVALS_SORTS.find((option) => option.id === sort)?.label}`}
                className="inline-flex items-center gap-1 rounded text-[12.5px] font-medium text-text-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                data-testid="approvals-sort"
              >
                {APPROVALS_SORTS.find((option) => option.id === sort)?.label}
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </button>
            }
            items={APPROVALS_SORTS.map((option) => ({ id: option.id, label: option.label, onClick: () => chooseSort(option.id) }))}
            selectedId={sort}
            selectedMark="check"
            menuLabel="Group by"
            position="bottom-left"
            width="sm"
          />
        </div>
        {/* The browser's own scroll anchoring would add to the compensation above. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
        {rowsAbove > 0 && <RowsAbove count={rowsAbove} onTop={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />}
        <div ref={listRef} onScroll={countAbove} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 [overflow-anchor:none]">
          {shown.length === 0 && stale.length === 0 && offline.length === 0 && (
            <p className="px-3 pt-6 text-[13px] text-text-tertiary" data-testid="notify-empty">
              {!enabled ? 'Approvals are off. Turn them on in Settings → Approvals.' : tab === 'waiting' ? 'Nothing is waiting on you.' : 'Nothing answered yet today.'}
            </p>
          )}
          {groups.length > 0
            ? (
              <div className="flex flex-col gap-3 pt-1">
                {groups.map((group) => (
                  <div key={group.key} className="overflow-hidden rounded-xl border border-border-secondary bg-surface-primary" data-testid="approvals-group-box">
                    <GroupHeader group={group} mark={machineMark(group.machineId)} count={groupCountText(group, tab)} />
                    <div className="p-1">{group.items.map(renderItem)}</div>
                  </div>
                ))}
              </div>
            )
            : list.map(renderItem)}
          {offline.map((row) => <OfflineMachineRow key={row.machineId} row={row} />)}
          {stale.length > 0 && (
            <div data-testid="approvals-stale">
              <button
                type="button"
                aria-expanded={staleOpen}
                onClick={toggleStale}
                className="flex w-full items-center gap-2 px-4 pb-1.5 pt-4 text-left text-[12.5px] font-medium text-text-secondary hover:text-text-primary"
              >
                {/* Fixed box: the chevron turns, nothing around it moves. */}
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                  <ChevronRight className={cn('h-3.5 w-3.5 text-text-tertiary', staleOpen && 'rotate-90')} />
                </span>
                Stale · {stale.length}
              </button>
              {staleOpen && stale.map(renderItem)}
            </div>
          )}
          <div ref={listSpacerRef} aria-hidden="true" />
        </div>
        </div>
      </section>

      <section aria-label="Beside the approval" className={cn('relative min-h-0 min-w-0 flex-1 flex-col', !selected ? 'hidden min-[1100px]:flex' : 'flex')} data-testid="approvals-beside">
        {/* On the list's edge (this section's left), above the list's own border. */}
        {listSized && (
          <OuterResizeSeparator label="Resize approvals list" orientation="vertical" value={listResize.effectivePx}
            minimum={listResize.floor} maximum={listResize.cap} {...listResize.separatorHandlers} />
        )}
        {selected && (
          <ApprovalColumn
            surface="approvals"
            itemId={selected.id}
            order={order}
            onSelect={selectApproval}
            groupLabel={tab === 'waiting' ? 'Approvals' : 'Answered'}
            inChat={undefined}
            renderOrigin={() => origin}
          />
        )}
        {!selected && (
          <div className="m-auto flex flex-col items-center gap-2 text-[13px] text-text-tertiary">
            <Inbox className="h-5 w-5" aria-hidden="true" />
            {shown.length === 0 ? 'When an agent asks you something, it opens here.' : 'Select an approval to open it here.'}
          </div>
        )}
      </section>
    </div>
  );
}
