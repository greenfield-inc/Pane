import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, ExternalLink, FileText, GitBranch, Globe, Hourglass, Inbox, MessageSquare, MessagesSquare, Navigation, ShieldAlert } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { cn } from '../../utils/cn';
import { runNotify, useNotifyStore } from '../../stores/notifyStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { usePanelStore } from '../../stores/panelStore';
import { showActionError } from '../../stores/errorStore';
import { openOnMachine } from '../../utils/machineRowActions';
import { MachineMark } from '../machines/MachineMark';
import { NotifyCard } from '../notify/NotifyCard';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { SessionBeside } from '../PaneChatView';
import { besideOf, groupApprovals, type ApprovalGroup, type ApprovalsTab, type Beside } from './approvalGroups';

/**
 * Links open as tabs through this computer's Pane, so only for this computer's items while the
 * app is on this computer; another machine's file lives there.
 */
const linksOpenHere = (item: NotifyItem, activeMachineId: string) => (item.machineId ?? LOCAL_MACHINE_ID) === LOCAL_MACHINE_ID && activeMachineId === LOCAL_MACHINE_ID;

function ItemIcon({ item }: { item: NotifyItem }) {
  const className = 'mt-0.5 h-4 w-4 shrink-0';
  if (item.relay) return <Hourglass className={cn(className, 'text-status-warning')} aria-hidden="true" />;
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
    return machine ? <MachineMark os={machine.os} slot={machine.slot} presence={dimmed ? 'dimmed' : 'solid'} size="logo" /> : null;
  };
}

function GroupHeader({ group, mark }: { group: ApprovalGroup; mark: ReactNode }) {
  const Icon = group.autopilot ? Navigation : group.session ? MessageSquare : GitBranch;
  return (
    <div className={cn('flex items-center gap-2 px-4 pb-1.5 pt-4 text-[12.5px] font-medium', group.autopilot ? 'text-autopilot-on-tint' : 'text-text-secondary')} data-testid="approvals-group">
      <Icon className={cn('h-3.5 w-3.5 shrink-0', group.autopilot ? 'text-autopilot' : 'text-text-tertiary')} aria-hidden="true" />
      <span className="min-w-0 truncate">{group.label}</span>
      {group.machine && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-tertiary px-1.5 py-px font-mono text-[11px] text-text-secondary">
          {mark}{group.machine}
        </span>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-text-tertiary">{group.items.length}</span>
    </div>
  );
}

function ItemRow({ item, now, selected = false, onSelect }: { item: NotifyItem; now: number; selected?: boolean; onSelect: () => void }) {
  const done = item.state === 'answered' || item.state === 'expired' || item.state === 'info';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      data-testid="approvals-row"
      className={cn(
        'flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
        selected && 'bg-surface-selected',
        item.unreachable && 'opacity-60',
      )}
    >
      {done ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" /> : <ItemIcon item={item} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-text-primary">{item.title}</span>
        <span className="block truncate text-[12px] text-text-tertiary">
          {item.state === 'expired' ? 'Expired · ' : item.state === 'info' ? 'Update · ' : item.answerSummary ? `→ ${item.answerSummary} · ` : ''}
          {item.relay ? `${item.relay.worker} asks the orchestrator` : item.source.autopilot ? 'written by Autopilot' : `${item.source.agent} · ${item.source.name}`}
          {item.unreachable ? ` · ${item.machine ?? 'its machine'} can't be reached` : ''}
        </span>
      </span>
      <span className="shrink-0 text-[12px] tabular-nums text-text-tertiary">{relativeAge(item.resolvedAt ?? item.createdAt, now)}</span>
    </button>
  );
}

function RelatedLinks({ item, paneId }: { item: NotifyItem; paneId?: string }) {
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const links = item.links ?? [];
  if (links.length === 0) return null;
  const here = linksOpenHere(item, activeMachineId);
  return (
    <div className="px-3.5 pb-3" data-testid="approvals-related">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Related</div>
      <div className="flex flex-wrap gap-1.5">
        {links.map((link, index) => {
          const isUrl = 'url' in link;
          const Icon = isUrl ? Globe : FileText;
          const disabled = !here && !isUrl;
          return (
            <button
              key={`${link.label}-${index}`}
              type="button"
              disabled={disabled}
              title={disabled ? `On ${item.machine ?? 'the other machine'}` : isUrl ? link.url : link.path}
              onClick={() => {
                if (here) {
                  window.electronAPI.notify.run({ type: 'open-link', id: item.id, index, paneId })
                    .catch((error) => showActionError(`Could not open ${link.label}`, error));
                }
                else if (isUrl) void window.electronAPI.openExternal(link.url);
              }}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-tertiary px-2 py-1 text-[12.5px] text-text-primary hover:bg-surface-hover disabled:opacity-50"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <span className="truncate">{link.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A worker's question its orchestrator hasn't picked up: read-only, answered in the orchestrator's tab. */
function RelayCard({ item, paneId }: { item: NotifyItem; paneId?: string }) {
  return (
    <div className="rounded-[18px] bg-surface-primary p-3.5 shadow-card ring-1 ring-status-warning" data-testid="approvals-relay">
      <div className="text-[12px] text-text-tertiary">
        {item.source.session
          ? <>Waiting on the {item.source.session.name} orchestrator: <b className="font-medium text-text-secondary">{item.relay?.worker}</b> asks</>
          : <>Its Session is closed: <b className="font-medium text-text-secondary">{item.relay?.worker}</b> asks</>}
      </div>
      <div className="mt-1 text-[14px] font-semibold text-text-primary">{item.relay?.question ?? item.title}</div>
      <div className="mt-1.5 text-[12.5px] text-text-tertiary">
        {item.source.session
          ? <>Its orchestrator hasn&rsquo;t picked this up. Answer in the orchestrator&rsquo;s tab on the right.</>
          : <>Nobody picked this up. Answer in {item.relay?.worker}&rsquo;s tab on the right.</>}
      </div>
      <div className="-mx-3.5 -mb-3.5 mt-3"><RelatedLinks item={item} paneId={paneId} /></div>
    </div>
  );
}

function SelectedItem({ item, beside, mark, onOpenInPane }: { item: NotifyItem; beside: Beside; mark: ReactNode; onOpenInPane?: () => void }) {
  const linkPane = beside.kind === 'session' || beside.kind === 'pane' ? beside.paneId : undefined;
  if (item.relay) return <RelayCard item={item} paneId={linkPane} />;
  const view = item.state === 'waiting' ? 'question' : item.state === 'sent' ? 'sent' : item.state === 'expired' ? 'expired' : null;
  if (!view) return null;
  return (
    <div className="[&_[data-notify-view=sent]]:w-full [&_[data-notify-view=sent]]:min-w-0">
      <NotifyCard
        item={item}
        view={view}
        form="inbox"
        menuPlacement="below"
        onCommand={runNotify}
        machineMark={mark}
        related={<RelatedLinks item={item} paneId={linkPane} />}
        onOpenInPane={onOpenInPane}
      />
    </div>
  );
}

function BesideHeader({ beside, mark, onOpen }: { beside: Beside; mark: ReactNode; onOpen?: () => void }) {
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

/**
 * Approvals: what waits on you, grouped by Session, beside the selected item's live Session or
 * Pane. `paneView` is the active Pane's own shell (SessionView's), shown for a Pane's item.
 */
export function ApprovalsView({ paneView }: { paneView: ReactNode }) {
  const snapshot = useNotifyStore((state) => state.snapshot);
  const [tab, setTab] = useState<ApprovalsTab>('waiting');
  const selectedId = useNavigationStore((state) => state.selectedApprovalId);
  const selectApproval = useNavigationStore((state) => state.selectApproval);
  const activePaneId = useSessionStore((state) => state.activeSessionId);
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const machineMark = useMachineMark();
  const now = useNow();
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const { waiting, answered, groups } = useMemo(() => groupApprovals(items, tab), [items, tab]);
  const shown = groups.flatMap((group) => group.items);
  // The selection follows its item into its Undo hold; once it leaves the tab, the first item takes over.
  const selected = shown.find((item) => item.id === selectedId) ?? (tab === 'waiting' ? shown[0] : undefined);
  const beside: Beside = selected ? besideOf(selected, activeMachineId) : { kind: 'none' };
  const besidePaneId = beside.kind === 'pane' ? beside.paneId : undefined;
  const besidePanelId = beside.kind === 'pane' ? beside.panelId : undefined;
  // A Session's item is about its orchestrator: show the orchestrator's tab (the asking one,
  // or for a fallback item the Session's current orchestrator tab), not the last tab opened there.
  const orchestratorPanelId = useOrchestrationSessionStore((state) => {
    if (beside.kind !== 'session' || !selected) return undefined;
    if (!selected.relay && selected.source.panelId) return selected.source.panelId;
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
  const openInPane = (item: NotifyItem, target: Beside) => {
    if (target.kind === 'autopilot') { navigateToAutopilot(); return; }
    const machineId = item.machineId ?? activeMachineId;
    if (target.kind === 'session') void openOnMachine(machineId, { kind: 'session', id: target.sessionId, name: target.name });
    else if (target.kind === 'pane') void openOnMachine(machineId, { kind: 'pane', id: target.paneId, name: target.name });
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

  const enabled = snapshot?.settings.enabled ?? true;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary min-[1100px]:flex-row" data-testid="notify-inbox">
      <section
        aria-label="Approvals"
        className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-b border-border-primary bg-bg-secondary min-[1100px]:max-h-none min-[1100px]:w-[400px] min-[1100px]:border-b-0 min-[1100px]:border-r"
        data-testid="approvals-queue"
      >
        <header className="flex h-[50px] shrink-0 items-center gap-2.5 px-4">
          <h1 className="text-[15px] font-semibold text-text-primary">Approvals</h1>
          <div role="tablist" aria-label="Approvals" className="inline-flex gap-0.5 rounded-[9px] bg-surface-tertiary p-[3px] text-[12.5px]">
            {tabButton('waiting', 'Waiting', waiting)}
            {tabButton('answered', 'Answered', answered)}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {shown.length === 0 && (
            <p className="px-3 pt-6 text-[13px] text-text-tertiary" data-testid="notify-empty">
              {!enabled ? 'Approvals are off. Turn them on in Settings → Approvals.' : tab === 'waiting' ? 'Nothing is waiting on you.' : 'Nothing answered yet today.'}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key}>
              <GroupHeader group={group} mark={machineMark(group.machineId)} />
              {group.items.map((item) => (
                item.id === selected?.id && item.state !== 'answered' && item.state !== 'info'
                  ? (
                    <div key={item.id} className="px-1 pb-2" data-testid="approvals-selected">
                      <SelectedItem item={item} beside={beside} mark={machineMark(item.machineId, item.unreachable)} onOpenInPane={() => openInPane(item, beside)} />
                    </div>
                  )
                  : <ItemRow key={item.id} item={item} now={now} selected={item.id === selected?.id} onSelect={() => selectApproval(item.id)} />
              ))}
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Beside the approval" className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="approvals-beside">
        <BesideHeader
          beside={beside}
          mark={selected ? machineMark(selected.machineId) : null}
          onOpen={selected ? () => openInPane(selected, beside) : undefined}
        />
        {beside.kind === 'session' && <SessionBeside key={beside.sessionId} sessionId={beside.sessionId} />}
        {beside.kind === 'pane' && (activePaneId === beside.paneId ? paneView : null)}
        {beside.kind === 'machine' && (
          <div className="m-auto max-w-sm text-center text-[13px] text-text-secondary" data-testid="approvals-elsewhere">
            <p>This item&rsquo;s Session runs on {beside.machine}.</p>
            <button
              type="button"
              onClick={() => selected && openInPane(selected, besideOf(selected, selected.machineId ?? LOCAL_MACHINE_ID))}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-interactive px-3 font-medium text-text-on-interactive hover:bg-interactive-hover"
            >
              Open on {beside.machine}
            </button>
          </div>
        )}
        {beside.kind === 'autopilot' && (
          <div className="m-auto max-w-sm text-center text-[13px] text-text-secondary" data-testid="approvals-autopilot">
            <p>Autopilot asks you this. Open Autopilot to see it in its chat, with any documents it wrote for it.</p>
            <button type="button" onClick={navigateToAutopilot}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-interactive px-3 font-medium text-text-on-interactive hover:bg-interactive-hover">
              <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Open Autopilot
            </button>
          </div>
        )}
        {beside.kind === 'none' && (
          <div className="m-auto flex flex-col items-center gap-2 text-[13px] text-text-tertiary">
            <Inbox className="h-5 w-5" aria-hidden="true" />
            {selected ? `Asked from ${selected.source.name}, outside Pane.` : 'Select an approval to see its Session here.'}
          </div>
        )}
      </section>
    </div>
  );
}
