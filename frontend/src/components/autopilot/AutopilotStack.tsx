import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, CircleCheck, CircleHelp, ExternalLink, FileText, Globe, Layers, List, MessageSquare, Navigation, ShieldAlert, WifiOff, X,
} from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { originLine } from '../../../../shared/approvalReceipts';
import type { AutopilotStackEntry, AutopilotTab } from '../../../../shared/types/autopilot';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { cn } from '../../utils/cn';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { moveAutopilotStack, shownStackEntry, useAutopilotStore } from '../../stores/autopilotStore';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { showActionError } from '../../stores/errorStore';
import { openOnMachine } from '../../utils/machineRowActions';
import { MachineMark } from '../machines/MachineMark';
import { offlineRowText, splitWaiting } from '../approvals/approvalGroups';
import { machineLabel, relativeAge, withMachineLabels } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { AutopilotDocument, AutopilotWebPage } from './AutopilotDocument';
import { AutopilotSessionOverview } from './AutopilotSessionOverview';
import { itemKind, stackPositionLabel } from './autopilotFormat';

function TabIcon({ tab }: { tab: AutopilotTab }) {
  const className = 'h-3.5 w-3.5 shrink-0';
  if (tab.kind === 'item') return <CircleCheck className={className} aria-hidden="true" />;
  if (tab.kind === 'url') return <Globe className={className} aria-hidden="true" />;
  if (tab.kind === 'session') return <List className={className} aria-hidden="true" />;
  return <FileText className={className} aria-hidden="true" />;
}

function KindIcon({ entry, item }: { entry: AutopilotStackEntry; item?: NotifyItem }) {
  const className = 'h-4 w-4 shrink-0';
  if (entry.byAutopilot || item?.source.autopilot) return <Navigation className={cn(className, 'text-autopilot')} aria-hidden="true" />;
  if (entry.ref.kind === 'session') return <MessageSquare className={cn(className, 'text-text-tertiary')} aria-hidden="true" />;
  if (entry.ref.kind === 'file') return <FileText className={cn(className, 'text-text-tertiary')} aria-hidden="true" />;
  if (entry.ref.kind === 'url') return <Globe className={cn(className, 'text-text-tertiary')} aria-hidden="true" />;
  if (item?.agentPrompt) return <ShieldAlert className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  if (item?.ui === 'approve') return <CircleCheck className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  return <CircleHelp className={cn(className, 'text-status-warning')} aria-hidden="true" />;
}

function entryKind(entry: AutopilotStackEntry, item?: NotifyItem): string {
  if (item) return itemKind(item);
  if (entry.ref.kind === 'session') return 'Session';
  if (entry.ref.kind === 'url') return 'App';
  if (entry.ref.kind === 'file') return entry.byAutopilot ? 'Autopilot' : 'Document';
  return 'Item';
}

function useMachineMark() {
  const machines = useAllMachinesStore((state) => state.entries);
  return (machineId: string | undefined) => {
    const machine = machineId ? machines.find((entry) => entry.id === machineId) : undefined;
    return machine ? <MachineMark letters={machine.letters} slot={machine.slot} presence="solid" size="logo" /> : null;
  };
}

/** Where "Open in Pane" goes for an entry: its Session, the asking Pane, or nothing. */
function openTarget(entry: AutopilotStackEntry, item?: NotifyItem): { kind: 'session' | 'pane'; id: string; name: string } | null {
  if (entry.ref.kind === 'session') return { kind: 'session', id: entry.ref.sessionId, name: entry.sessionName ?? 'Session' };
  if (!item || item.source.autopilot) return null;
  const session = item.source.session;
  // A worker's permission prompt opens that worker's tab, where the person taps it (J7).
  if (item.agentPrompt && item.source.paneId) return { kind: 'pane', id: item.source.paneId, name: item.source.name };
  if (session) return { kind: 'session', id: session.id, name: session.name };
  if (item.source.paneId) return { kind: 'pane', id: item.source.paneId, name: item.source.name };
  return null;
}

function TabContent({ tab }: { tab: AutopilotTab }) {
  switch (tab.kind) {
    case 'file': return <AutopilotDocument key={tab.path} path={tab.path} label={tab.label} />;
    case 'url': return <AutopilotWebPage key={tab.url} src={tab.url} title={tab.label} />;
    case 'session': return <AutopilotSessionOverview key={tab.sessionId} sessionId={tab.sessionId} />;
    // The question lives in the chat (D-91); its tab never shows here.
    case 'item': return null;
  }
}

/** "What's waiting": every waiting item; picking one puts it on the stack and shows it. */
function WaitingMenu({ onClose }: { onClose: () => void }) {
  const rawItems = useNotifyStore(selectNotifyItems);
  const machines = useAllMachinesStore((state) => state.entries);
  const now = useNow();
  const { live, stale, offline } = useMemo(() => splitWaiting(withMachineLabels(rawItems, machines)), [rawItems, machines]);
  const waiting = live.filter((item) => item.state === 'waiting' && !item.relay);
  const [staleOpen, setStaleOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const bring = (id: string) => {
    void window.electronAPI.autopilot.push({ item: id })
      .then((snapshot) => {
        useAutopilotStore.setState({ snapshot });
        const entry = snapshot.stack.entries.find((candidate) => candidate.ref.kind === 'item' && candidate.ref.notifyId === id);
        if (entry) moveAutopilotStack({ type: 'show', id: entry.id });
      })
      .catch((error) => showActionError('Could not put it on the stack', error));
    onClose();
  };
  return (
    <div ref={ref} role="menu" aria-label="What's waiting" data-testid="autopilot-waiting-menu"
      className="absolute right-0 top-full z-40 mt-1 max-h-[60vh] w-[340px] overflow-y-auto rounded-xl bg-surface-primary p-1.5 shadow-card ring-1 ring-border-secondary">
      {waiting.length === 0 && stale.length === 0 && offline.length === 0 && <p className="px-3 py-3 text-[13px] text-text-tertiary">Nothing waits on you.</p>}
      {[...waiting, ...(staleOpen ? stale : [])].map((item) => (
        <button key={item.id} type="button" role="menuitem" onClick={() => bring(item.id)}
          className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-text-primary">{item.title}</span>
            <span className="block truncate text-[11.5px] text-text-tertiary">{originLine(item)} · {itemKind(item)}</span>
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-text-tertiary">{relativeAge(item.createdAt, now)}</span>
        </button>
      ))}
      {stale.length > 0 && (
        <button type="button" role="menuitem" aria-expanded={staleOpen} onClick={() => setStaleOpen((open) => !open)} data-testid="autopilot-waiting-stale"
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-text-secondary hover:bg-surface-hover">
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            <ChevronRight className={cn('h-3.5 w-3.5 text-text-tertiary', staleOpen && 'rotate-90')} />
          </span>
          Stale · {stale.length}
        </button>
      )}
      {offline.map((row) => (
        <p key={row.machineId} className="flex items-start gap-2 px-2.5 py-2 text-[12px] text-text-tertiary" data-testid="autopilot-offline-row">
          <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{offlineRowText(row)}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * The stack beside Autopilot's chat (D-46, D-71): one entry at a time, newer ones waiting
 * off-screen; ‹ › and the chips step through what is there. The header and the entry's tabs never
 * move (D-72): everything that can grow scrolls below them.
 */
export function AutopilotStack() {
  const snapshot = useAutopilotStore((state) => state.snapshot);
  const items = useNotifyStore((state) => state.snapshot?.items);
  const mark = useMachineMark();
  const machines = useAllMachinesStore((state) => state.entries);
  const [tabByEntry, setTabByEntry] = useState<Record<string, number>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const entry = shownStackEntry(snapshot);
  const item = useMemo(() => entry?.ref.kind === 'item' ? items?.find((candidate) => candidate.id === (entry.ref.kind === 'item' ? entry.ref.notifyId : '')) : undefined, [entry, items]);
  const now = useNow();
  if (!snapshot) return null;
  const { stack } = snapshot;
  const index = entry ? stack.entries.findIndex((candidate) => candidate.id === entry.id) : -1;
  // The right side holds the current item's context only (D-91): its documents, app, Session, PR.
  const tabs = entry ? entry.tabs.filter((candidate) => candidate.kind !== 'item') : [];
  const tabIndex = entry ? Math.min(tabByEntry[entry.id] ?? 0, Math.max(0, tabs.length - 1)) : 0;
  const tab = tabs[tabIndex];
  const showTab = (next: number) => { if (entry) setTabByEntry((current) => ({ ...current, [entry.id]: next })); };
  const target = entry ? openTarget(entry, item) : null;
  const sessionName = entry?.sessionName ?? item?.source.session?.name;
  const origin = [sessionName, ...(item && !item.source.autopilot ? [item.source.agent, item.source.name] : [])].filter(Boolean).map((part) => `· ${part}`).join(' ');

  return (
    <section aria-label="Stack" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary" data-testid="autopilot-stack">
      <header className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
        <Layers className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <h2 className="hidden shrink-0 text-[14px] font-semibold text-text-primary min-[1180px]:block">Stack</h2>
        <div className="flex shrink-0 items-center">
          <button type="button" aria-label="Previous on the stack" aria-keyshortcuts="ArrowLeft" disabled={index <= 0} onClick={() => moveAutopilotStack({ type: 'step', direction: -1 })}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover disabled:opacity-40" data-testid="autopilot-stack-prev">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" aria-label="Next on the stack" aria-keyshortcuts="ArrowRight" disabled={index < 0 || index >= stack.entries.length - 1} onClick={() => moveAutopilotStack({ type: 'step', direction: 1 })}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover disabled:opacity-40" data-testid="autopilot-stack-next">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <span className="shrink-0 text-[12.5px] tabular-nums text-text-tertiary" data-testid="autopilot-stack-position">{stackPositionLabel(stack)}</span>
        <div className="scrollbar-thin scroll-fade-x flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1" role="tablist" aria-label="On the stack">
          {stack.entries.map((candidate) => (
            <button key={candidate.id} type="button" role="tab" aria-selected={candidate.id === entry?.id}
              onClick={() => moveAutopilotStack({ type: 'show', id: candidate.id })}
              title={candidate.title}
              className={cn(
                'inline-flex h-7 min-w-16 max-w-[180px] items-center gap-1.5 rounded-lg border px-2 text-[12px]',
                candidate.id === entry?.id ? 'border-autopilot-border bg-autopilot-subtle text-text-primary' : 'border-border-secondary text-text-secondary hover:bg-surface-hover',
                candidate.doneAt !== undefined && 'opacity-60',
              )}>
              {candidate.doneAt !== undefined ? <CircleCheck className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
              <span className="truncate">{candidate.title}</span>
            </button>
          ))}
        </div>
        <div className="relative shrink-0">
          <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="What's waiting" title="What's waiting" onClick={() => setMenuOpen((open) => !open)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border-secondary px-2 text-[12.5px] text-text-secondary hover:bg-surface-hover" data-testid="autopilot-whats-waiting">
            <List className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden min-[1280px]:inline">What&rsquo;s waiting</span>
          </button>
          {menuOpen && <WaitingMenu onClose={() => setMenuOpen(false)} />}
        </div>
      </header>

      {!entry ? (
        <div className="m-auto max-w-xs text-center text-[13px] text-text-tertiary" data-testid="autopilot-stack-empty">
          <Layers className="mx-auto mb-2 h-5 w-5" aria-hidden="true" />
          {snapshot.state === 'stopped' ? 'Press Start: Autopilot puts what waits on you here, one item at a time.' : 'Nothing on the stack. When something waits on you, it shows here.'}
        </div>
      ) : (
        <div className="m-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl ring-1 ring-border-secondary" data-testid="autopilot-entry" data-entry-id={entry.id}>
          {/* Fixed: one meta line, one title line, the tabs (D-72). Nothing here grows. */}
          <div className="shrink-0 border-b border-border-primary px-4 pt-3" data-testid="autopilot-entry-head">
            <div className="flex h-5 items-center gap-1.5 text-[12.5px] text-text-tertiary">
              <KindIcon entry={entry} item={item} />
              <span className="font-semibold text-text-secondary">{entryKind(entry, item)}</span>
              {/* One span, so a narrow column truncates the whole origin once, never each part to "·…". */}
              {origin && <span className="min-w-0 truncate" title={origin}>{origin}</span>}
              {item?.machineId && item.machineId !== LOCAL_MACHINE_ID && <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-tertiary px-1.5 font-mono text-[11px]">{mark(item.machineId)}{machineLabel(item, machines)}</span>}
              {(entry.byAutopilot || item?.source.autopilot) && <span className="shrink-0 rounded-full bg-autopilot-subtle px-1.5 text-[11px] font-medium text-autopilot-on-tint">written by Autopilot</span>}
              <span className="ml-auto shrink-0 tabular-nums">{item ? relativeAge(item.createdAt, now) : relativeAge(entry.addedAt, now)}</span>
              {target && (
                <button type="button" onClick={() => void openOnMachine(item?.machineId ?? LOCAL_MACHINE_ID, target)} className="ml-2 inline-flex shrink-0 items-center gap-1 hover:text-text-primary" data-testid="autopilot-open-in-pane">
                  Open in Pane <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              {entry.doneAt === undefined && entry.ref.kind !== 'item' && (
                <button type="button" aria-label="Done with this" title="Done with this" onClick={() => moveAutopilotStack({ type: 'dismiss', id: entry.id })} className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-surface-hover hover:text-text-primary">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <h3 className="mt-1 truncate text-[16px] font-semibold text-text-primary" title={entry.title} data-testid="autopilot-entry-title">{entry.title}</h3>
            <div className="scrollbar-thin -mb-px mt-2 flex h-9 items-end gap-1 overflow-x-auto" role="tablist" aria-label={`${entry.title}: tabs`} data-testid="autopilot-entry-tabs">
              {tabs.length === 0 && <span className="flex h-9 items-center text-[13px] text-text-tertiary">No documents</span>}
              {tabs.map((candidate, candidateIndex) => (
                <button key={`${candidate.kind}-${candidate.label}-${candidateIndex}`} type="button" role="tab" aria-selected={candidateIndex === tabIndex} onClick={() => showTab(candidateIndex)}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px]',
                    candidateIndex === tabIndex ? 'border-autopilot font-medium text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
                  )}>
                  <TabIcon tab={candidate} />
                  <span className="max-w-[180px] truncate">{candidate.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="autopilot-entry-body">
            {tab ? <TabContent tab={tab} /> : (
              <p className="m-auto max-w-xs text-center text-[13px] text-text-tertiary" data-testid="autopilot-no-context">
                {item ? 'Nothing more to show for this one. Its question is in the chat.' : 'Nothing to show for this one.'}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
