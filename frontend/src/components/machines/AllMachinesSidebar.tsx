import { SessionApprovalsCount } from '../approvals/ApprovalsCount';
import { useEffect, useState } from 'react';
import { Archive, Check, ChevronDown, ChevronRight, MessageSquare, MoreHorizontal, Pause, Pencil, Pin, Play, Plus, RefreshCw, X } from 'lucide-react';
import { AgentStatusDot, PausedGlyph } from '../ui/AgentStatusDot';
import { Button } from '../ui/Button';
import { PopoverButton, TerminalPopover } from '../terminal/TerminalPopover';
import { RenameDialog } from '../CompactSessionMenu';
import { PermissionDialog } from '../PermissionDialog';
import { SessionSwitchToChatDialog, useSessionSwitchPreview } from '../SessionSwitchToChat';
import type { SessionChatSwitchPreview } from '../../../../shared/types/chatTab';
import { MachineBadge } from './MachineBadge';
import { MachineMark } from './MachineMark';
import { AutopilotNavRow } from '../autopilot/AutopilotNavRow';
import {
  LoopsNavRow,
  ApprovalsNavRow,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_SECTION_ROW,
  SIDEBAR_SECTION_TOGGLE,
  SessionRowContent,
} from '../ProjectSessionList';
import { paneIconColor } from '../../utils/paneIconColor';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { useAllMachinesTree } from '../../hooks/useAllMachinesTree';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { commandOnMachine, openOnMachine, runOnMachine } from '../../utils/machineRowActions';
import { savedOrderAfterMove, type AllMachinesPane, type AllMachinesSession, type MachineRef } from '../../utils/allMachinesTree';
import { DropLine, useRowReorder, type ReorderList, type RowReorder } from '../../hooks/useRowReorder';
import { cn } from '../../utils/cn';

/** "9:14", in this computer's clock format. */
function formatClock(iso: string | null): string {
  const date = new Date(iso ?? '');
  return Number.isNaN(date.getTime()) ? 'an unknown time' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** A machine that stopped answering: its rows stay, dimmed, and Retry reconnects it now. */
export function MachineOfflineBanner({ machine, since, onRetry }: { machine: MachineRef; since: string | null; onRetry: () => void }) {
  return (
    <div role="status" className="mx-2 mt-2 flex items-center gap-2.5 rounded-md border border-border-primary bg-surface-primary px-2.5 py-2">
      <MachineMark os={machine.os} slot={machine.slot} presence="dimmed" size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-semibold text-text-primary">{machine.name} went offline at {formatClock(since)}</p>
        <p className="truncate text-[11px] text-text-tertiary">Its rows are from then.</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex-shrink-0 rounded px-1.5 py-1 text-[12px] font-semibold text-status-error hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
      >
        Retry
      </button>
    </div>
  );
}

interface RowMenu {
  x: number;
  y: number;
  machine: MachineRef;
  target: { kind: 'pane'; row: AllMachinesPane } | { kind: 'session'; row: AllMachinesSession };
}

/** Pin, rename, permission and archive for a row, run on the row's own machine without switching. */
function RowActionsMenu({ menu, onClose, onRename, onReviewPermission }: {
  menu: RowMenu | null;
  onClose: () => void;
  onRename: (menu: RowMenu) => void;
  /** Allow opens the permission dialog, which shows what the agent will run. */
  onReviewPermission: (menu: RowMenu) => void;
}) {
  const machineId = menu?.machine.id ?? '';
  const pane = menu?.target.kind === 'pane' ? menu.target.row : null;
  const session = menu?.target.kind === 'session' ? menu.target.row : null;
  const ref = pane ? { kind: 'pane' as const, id: pane.pane.id } : { kind: 'session' as const, id: session?.session.id ?? '' };
  const pinned = pane ? Boolean(pane.pane.isFavorite) : Boolean(session?.session.isPinned);
  const paused = Boolean(pane ? pane.pane.paused : session?.session.paused);
  const noun = pane ? 'Pane' : 'Session';
  const act = (run: () => Promise<void>) => { onClose(); void run(); };
  const permission = pane?.permission ?? null;
  // A Session's own machine says whether any of its terminal agent tabs can switch to chat.
  const switchPreview = useSessionSwitchPreview({ kind: 'machine', machineId }, session?.session.id ?? null);
  const [switching, setSwitching] = useState<{ machineId: string; sessionName: string; preview: SessionChatSwitchPreview } | null>(null);
  return (<>
    <TerminalPopover visible={menu !== null} x={menu?.x ?? 0} y={menu?.y ?? 0} onClose={onClose}>
      <div role="menu" aria-label={`${noun} actions`}>
        {permission && (
          <>
            <PopoverButton role="menuitem" onClick={() => { if (menu) onReviewPermission(menu); onClose(); }}>
              <span className="flex items-center gap-2"><Check className="h-4 w-4" />Allow {permission.toolName}…</span>
            </PopoverButton>
            <PopoverButton role="menuitem" onClick={() => act(() => runOnMachine(machineId, { type: 'answer-permission', requestId: permission.id, response: { behavior: 'deny' } }, `Could not deny ${permission.toolName}`))}>
              <span className="flex items-center gap-2"><X className="h-4 w-4" />Deny {permission.toolName}</span>
            </PopoverButton>
            <div className="my-1 border-t border-border-primary" />
          </>
        )}
        <PopoverButton role="menuitem" onClick={() => act(() => runOnMachine(machineId, { type: 'pin', target: ref, pinned: !pinned }, `Could not pin or unpin the ${noun}`))}>
          <span className="flex items-center gap-2"><Pin className="h-4 w-4 rotate-45" />{pinned ? 'Unpin' : 'Pin'}</span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={() => act(() => runOnMachine(machineId, { type: paused ? 'resume' : 'pause', target: ref }, `Could not ${paused ? 'resume' : 'pause'} the ${noun}`))}>
          <span className="flex items-center gap-2">{paused ? <Play className="h-4 w-4 fill-current" /> : <Pause className="h-4 w-4" />}{paused ? 'Resume' : 'Pause'}{pane ? '' : ' Session'}</span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={() => { if (menu) onRename(menu); onClose(); }}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename {noun}…</span>
        </PopoverButton>
        {session && switchPreview && (
          <PopoverButton role="menuitem" onClick={() => { setSwitching({ machineId, sessionName: session.session.name || 'Session', preview: switchPreview }); onClose(); }}>
            <span className="flex items-center gap-2"><MessageSquare className="h-4 w-4" />Switch to chat…</span>
          </PopoverButton>
        )}
        <div className="my-1 border-t border-border-primary" />
        <PopoverButton role="menuitem" variant="danger" onClick={() => act(() => runOnMachine(machineId, { type: 'archive', target: ref }, `Could not archive the ${noun}`))}>
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" />Archive</span>
        </PopoverButton>
      </div>
    </TerminalPopover>
    {switching && <SessionSwitchToChatDialog where={{ kind: 'machine', machineId: switching.machineId }} sessionName={switching.sessionName} preview={switching.preview} onClose={() => setSwitching(null)} />}
  </>);
}

/** A pinned row keeps its pin visible at rest, as today's sidebar does. */
function PinnedMark() {
  return (
    <span role="img" aria-label="Pinned" className="pointer-events-none flex h-[18px] w-3.5 flex-none items-center justify-center text-text-muted">
      <Pin className="h-3.5 w-3.5 rotate-45" />
    </span>
  );
}

/** The badge, and on hover or keyboard focus the actions button in the same box, so neither shifts the row. */
function BadgeSlot({ machine, label, onMenu }: { machine: MachineRef; label: string; onMenu: (x: number, y: number) => void }) {
  return (
    <span className="group/slot relative z-10 flex h-[18px] w-[60px] flex-none items-center">
      <MachineBadge machine={machine} className="group-hover/row:invisible group-has-[:focus-visible]/slot:invisible" />
      <button
        type="button"
        aria-label={`Actions for ${label}`}
        onClick={(event) => { event.stopPropagation(); onMenu(event.clientX, event.clientY); }}
        className="absolute inset-0 flex items-center justify-center rounded text-text-muted opacity-0 hover:bg-surface-hover hover:text-text-primary focus-visible:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive group-hover/row:opacity-100"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function PaneRow({ row, active, nested, onMenu, reorder }: { row: AllMachinesPane; active: boolean; nested: boolean; onMenu: (menu: RowMenu) => void; reorder?: RowReorder }) {
  const { pane, machine } = row;
  const label = pane.gitStatus?.prTitle || pane.name || 'Untitled';
  const openMenu = (x: number, y: number) => onMenu({ x, y, machine, target: { kind: 'pane', row } });
  return (
    <div
      data-testid="all-machines-pane-row"
      data-row-key={row.key}
      {...reorder?.drag}
      onKeyDown={reorder?.onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY); }}
      className={cn(
        'group/row relative mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors',
        nested ? 'pl-6' : 'pl-2',
        active ? 'bg-surface-selected' : 'hover:bg-surface-hover',
        row.offline && 'opacity-50',
      )}
    >
      <DropLine edge={reorder?.indicator ?? null} />
      <button
        type="button"
        data-row-open
        onClick={() => void openOnMachine(machine.id, { kind: 'pane', id: pane.id, name: label })}
        aria-current={active ? 'page' : undefined}
        aria-label={`${label} on ${machine.name}`}
        className="absolute inset-0 z-0 rounded-md focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
      />
      <div className="pointer-events-none flex min-w-0 flex-1">
        <SessionRowContent
          session={pane}
          gs={pane.gitStatus}
          iconColor={paneIconColor(pane)}
          hasDiff={false}
          adds={0}
          dels={0}
          displayName={label}
          showActivity={row.status === 'working'}
          showUnviewedCompleted={false}
          agentDisplayStatus={row.status}
          rowLayout="single"
          isLoopRun={false}
          notifyWaiting={row.waiting}
        />
      </div>
      {pane.isFavorite && <PinnedMark />}
      <BadgeSlot machine={machine} label={label} onMenu={openMenu} />
    </div>
  );
}

function SessionRow({ row, active, expanded, onToggle, onMenu, renderPane, reorder }: {
  row: AllMachinesSession;
  reorder: RowReorder;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onMenu: (menu: RowMenu) => void;
  renderPane: (row: AllMachinesPane) => React.ReactNode;
}) {
  const { session, machine } = row;
  const openMenu = (x: number, y: number) => onMenu({ x, y, machine, target: { kind: 'session', row } });
  return (
    <div className={cn('relative', row.offline && 'opacity-50')} data-row-key={row.key} {...reorder.drag} onKeyDown={reorder.onKeyDown}>
      <DropLine edge={reorder.indicator} />
      <div
        data-testid="all-machines-session-row"
        onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY); }}
        className={cn(
          'group/row relative mx-2 flex min-h-7 w-[calc(100%-1rem)] items-center gap-1.5 rounded-md py-0.5 pl-1 pr-2 transition-colors',
          active ? 'bg-surface-selected' : 'hover:bg-surface-hover',
        )}
      >
        <button
          type="button"
          data-row-open
          onClick={() => void openOnMachine(machine.id, { kind: 'session', id: session.id, name: session.name })}
          aria-current={active ? 'page' : undefined}
          aria-label={`Session ${session.name} on ${machine.name}`}
          className="absolute inset-0 z-0 rounded-md focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${session.name}`}
          disabled={row.panes.length === 0}
          className="relative z-10 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary disabled:invisible"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        {session.paused
          ? <PausedGlyph size="sm" className="pointer-events-none flex-shrink-0" />
          : <AgentStatusDot status={row.status} size="sm" className="pointer-events-none flex-shrink-0" />}
        <span className={cn('pointer-events-none min-w-0 flex-1 truncate text-[13px]', session.paused ? 'text-text-muted' : 'font-semibold text-text-primary')}>{session.name}</span>
        <SessionApprovalsCount
          sessionId={session.id}
          machineId={machine.id}
          otherwise={row.panes.length > 0 && <span className="text-[12px] tabular-nums text-text-tertiary">{row.panes.length}</span>}
        />
        {session.isPinned && <PinnedMark />}
        <BadgeSlot machine={machine} label={session.name} onMenu={openMenu} />
      </div>
      {expanded && row.panes.map(renderPane)}
    </div>
  );
}

/** Row keys split into pinned and the rest, in one pass, each in the order shown. */
function splitPinned<Row extends { key: string }>(rows: readonly Row[], isPinned: (row: Row) => boolean) {
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const row of rows) (isPinned(row) ? pinned : rest).push(row.key);
  return { pinned, rest };
}

/** One mark per machine the project is on, dimmed for a machine that is offline. */
function ProjectMachineMarks({ entries }: { entries: ReadonlyArray<{ machine: MachineRef; offline: boolean }> }) {
  const machines = [...new Map(entries.map((entry) => [entry.machine.id, entry])).values()];
  return (
    <span
      role="img"
      aria-label={`On ${machines.map((entry) => entry.machine.name).join(', ')}`}
      data-testid="all-machines-project-machines"
      className="flex flex-none items-center gap-1"
    >
      {machines.map(({ machine, offline }) => (
        <MachineMark key={machine.id} os={machine.os} slot={machine.slot} size="logo" presence={offline ? 'dimmed' : 'solid'} />
      ))}
    </span>
  );
}

function SectionHeader({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className={SIDEBAR_SECTION_ROW}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className={SIDEBAR_SECTION_TOGGLE}>
        <span className={SIDEBAR_SECTION_LABEL}>{label}</span>
        <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-visible/section:opacity-100">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-current" /> : <ChevronRight className="h-3.5 w-3.5 text-current" />}
        </span>
      </button>
    </div>
  );
}

/**
 * The sidebar in All machines: today's Sessions and Projects tree with every saved machine's
 * rows, a machine badge on each, in the order this computer arranged them. A repository on
 * several machines is one project row, with a mark for each machine. Projects and Sessions start closed, and what you
 * open is remembered on this computer.
 */
export function AllMachinesSidebar({ onNew }: { onNew: () => void }) {
  const { views, tree, activeMachineId } = useAllMachinesTree();
  const machines = useAllMachinesStore((state) => state.machines);
  const activeView = useNavigationStore((state) => state.activeView);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const selectedSessionId = useOrchestrationSessionStore((state) => state.selectedSessionId);
  const layout = useAllMachinesStore((state) => state.layout);
  const toggleOpen = useAllMachinesStore((state) => state.toggleOpen);
  const arrangeSessions = useAllMachinesStore((state) => state.arrangeSessions);
  const arrangePanes = useAllMachinesStore((state) => state.arrangePanes);
  const isOpen = (key: string) => layout.open.includes(key);
  const [announcement, setAnnouncement] = useState('');
  const reorderRow = useRowReorder(setAnnouncement);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [renaming, setRenaming] = useState<RowMenu | null>(null);
  const [reviewing, setReviewing] = useState<RowMenu | null>(null);

  const isActivePane = (row: AllMachinesPane) => row.machine.id === activeMachineId && activeView === 'sessions' && row.pane.id === activeSessionId;
  const renderPane = (nested: boolean) => (row: AllMachinesPane) => (
    <PaneRow key={row.key} row={row} active={isActivePane(row)} nested={nested} onMenu={setMenu} />
  );

  // Pinned rows and the rest are separate lists; a move saves the whole list as shown.
  const sessionGroups = splitPinned(tree.sessions, (row) => Boolean(row.session.isPinned));
  const sessionList = (pinned: boolean): ReorderList => ({
    id: pinned ? 'sessions:pinned' : 'sessions',
    keys: pinned ? sessionGroups.pinned : sessionGroups.rest,
    save: (order) => arrangeSessions(savedOrderAfterMove(layout.sessions, pinned ? [...order, ...sessionGroups.rest] : [...sessionGroups.pinned, ...order])),
  });
  const paneList = (projectKey: string, panes: AllMachinesPane[], pinned: boolean): ReorderList => {
    const groups = splitPinned(panes, (row) => Boolean(row.pane.isFavorite));
    return {
      id: `project:${projectKey}:${pinned ? 'pinned' : 'rest'}`,
      keys: pinned ? groups.pinned : groups.rest,
      save: (order) => arrangePanes(projectKey, savedOrderAfterMove(layout.panes[projectKey] ?? null, pinned ? [...order, ...groups.rest] : [...groups.pinned, ...order])),
    };
  };

  const offline = views.filter((view) => view.offline);
  const loaded = views.some((view) => view.snapshot !== null);
  const empty = loaded && tree.panes.length === 0 && tree.sessions.length === 0;
  const renamingTarget = renaming?.target;
  const reviewingPane = reviewing?.target.kind === 'pane' ? reviewing.target.row : null;
  // The request still pending on its machine: one answered elsewhere closes the dialog.
  const livePermission = reviewingPane ? tree.panes.find((row) => row.key === reviewingPane.key)?.permission : undefined;
  const review = reviewing && reviewingPane && livePermission && livePermission.id === reviewingPane.permission?.id
    ? { machine: reviewing.machine, request: livePermission, label: reviewingPane.pane.gitStatus?.prTitle || reviewingPane.pane.name || 'Untitled' }
    : null;

  return (
    <div className="flex flex-col pb-2" data-testid="all-machines-sidebar">
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {/* Same order as the single-machine sidebar: Loops, Autopilot, Approvals (D-117, D-198). */}
      <LoopsNavRow active={activeView === 'loops'} />
      <AutopilotNavRow />
      <ApprovalsNavRow />

      {offline.map(({ machine }) => (
        <MachineOfflineBanner
          key={machine.id}
          machine={machine}
          since={machines.find((state) => state.id === machine.id)?.offlineSince ?? null}
          onRetry={() => void window.electronAPI.machines.retry(machine.id).catch(() => undefined)}
        />
      ))}

      {!loaded ? null : empty ? (
        <div className="mx-2 mt-6 flex flex-col items-center gap-3 px-2 text-center">
          <p className="text-[13px] text-text-tertiary">Nothing open on your {machines.length} machines</p>
          <Button size="sm" variant="secondary" onClick={onNew}><Plus className="mr-1 h-3.5 w-3.5" />New</Button>
        </div>
      ) : (
        <>
          {tree.sessions.length > 0 && (
            <>
              <SectionHeader label="Sessions" expanded={isOpen('section:sessions')} onToggle={() => toggleOpen('section:sessions')} />
              {isOpen('section:sessions') && tree.sessions.map((row) => (
                <SessionRow
                  key={row.key}
                  row={row}
                  active={row.machine.id === activeMachineId && activeView === 'pane-chat' && row.session.id === selectedSessionId}
                  expanded={isOpen(`session:${row.key}`)}
                  onToggle={() => toggleOpen(`session:${row.key}`)}
                  onMenu={setMenu}
                  renderPane={renderPane(true)}
                  reorder={reorderRow(sessionList(Boolean(row.session.isPinned)), row.key, row.session.name)}
                />
              ))}
            </>
          )}

          <SectionHeader label="Projects" expanded={isOpen('section:projects')} onToggle={() => toggleOpen('section:projects')} />
          {isOpen('section:projects') && tree.projects.map((project) => {
            const expanded = isOpen(`project:${project.key}`);
            const allOffline = project.entries.every((entry) => entry.offline);
            return (
              <div key={project.key} data-testid="all-machines-project">
                <button
                  type="button"
                  onClick={() => toggleOpen(`project:${project.key}`)}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} project ${project.name}`}
                  className={cn(
                    'mx-2 flex min-h-7 w-[calc(100%-1rem)] items-center gap-1.5 rounded-md py-0.5 pl-2 pr-2 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-interactive',
                    allOffline && 'opacity-50',
                  )}
                >
                  <span className="flex h-4 w-3 flex-shrink-0 items-center text-text-tertiary">
                    {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">{project.name}</span>
                  <ProjectMachineMarks entries={project.entries} />
                </button>
                {expanded && project.panes.map((row) => (
                  <PaneRow
                    key={row.key}
                    row={row}
                    active={isActivePane(row)}
                    nested
                    onMenu={setMenu}
                    reorder={reorderRow(paneList(project.key, project.panes, Boolean(row.pane.isFavorite)), row.key, row.pane.gitStatus?.prTitle || row.pane.name || 'Untitled')}
                  />
                ))}
              </div>
            );
          })}
        </>
      )}

      <RowActionsMenu menu={menu} onClose={() => setMenu(null)} onRename={setRenaming} onReviewPermission={setReviewing} />
      {review && (
        <PermissionDialog
          request={review.request}
          session={{ name: `${review.label} on ${review.machine.name}` }}
          onRespond={(requestId, behavior, updatedInput, message) => {
            setReviewing(null);
            void runOnMachine(
              review.machine.id,
              { type: 'answer-permission', requestId, response: { behavior, updatedInput, message } },
              `Could not ${behavior} ${review.request.toolName} on ${review.machine.name}`,
            );
          }}
        />
      )}
      {renaming && renamingTarget && (
        <RenameDialog
          noun={renamingTarget.kind === 'pane' ? 'Pane' : 'Session'}
          initialName={renamingTarget.kind === 'pane' ? renamingTarget.row.pane.name : renamingTarget.row.session.name}
          onClose={() => setRenaming(null)}
          save={async (name) => {
            const target = renamingTarget.kind === 'pane'
              ? { kind: 'pane' as const, id: renamingTarget.row.pane.id }
              : { kind: 'session' as const, id: renamingTarget.row.session.id };
            await commandOnMachine(renaming.machine.id, { type: 'rename', target, name });
          }}
        />
      )}
    </div>
  );
}

/** Shown in place of the Pane view when the row opened is on a machine that stopped answering. */
export function MachineOfflineView({ onMachineDetails }: { onMachineDetails: () => void }) {
  const notice = useAllMachinesStore((state) => state.offlineNotice);
  const { views } = useAllMachinesTree();
  const machines = useAllMachinesStore((state) => state.machines);
  // Opening anything else leaves this notice.
  useEffect(() => {
    if (!notice) return undefined;
    const leave = () => useAllMachinesStore.setState({ offlineNotice: null });
    const stopNavigation = useNavigationStore.subscribe(leave);
    const stopSessions = useSessionStore.subscribe((state, before) => { if (state.activeSessionId !== before.activeSessionId) leave(); });
    return () => { stopNavigation(); stopSessions(); };
  }, [notice]);
  if (!notice) return null;
  const view = views.find((item) => item.machine.id === notice.machineId);
  const machine = view?.machine ?? { id: notice.machineId, name: notice.machineId, os: null, slot: 0 };
  const since = machines.find((state) => state.id === notice.machineId)?.offlineSince ?? null;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-bg-primary px-8 text-center" data-testid="machine-offline-view">
      <MachineMark os={machine.os} slot={machine.slot} presence="dimmed" size="lg" />
      <h2 className="text-lg font-semibold text-text-primary">{machine.name} is offline</h2>
      <p className="max-w-md text-sm text-text-secondary">
        It stopped answering at {formatClock(since)}.
        {notice.question ? ` ${notice.title} was waiting on you then: "${notice.question}"` : ''}
      </p>
      <p className="max-w-md text-sm text-text-secondary">Pane keeps trying. Its agents keep running on {machine.name}.</p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => void window.electronAPI.machines.retry(machine.id).catch(() => undefined)}>
          <RefreshCw className="mr-1.5 h-4 w-4" />Retry now
        </Button>
        <Button variant="ghost" onClick={onMachineDetails}>Machine details</Button>
      </div>
    </div>
  );
}
