import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { BarChart3, ExternalLink, Image as ImageIcon, MoreHorizontal, Plus, X } from 'lucide-react';
import type { TodoAttachment, TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { selectNotifyItems, useNotifyStore, countsAsWaiting } from '../../../stores/notifyStore';
import { todoApprovalSurface, useApprovalColumnStore } from '../../../stores/approvalColumnStore';
import { useAllMachinesStore } from '../../../stores/allMachinesStore';
import { useTodosStore } from '../../../stores/todosStore';
import { useOrchestrationSessionStore } from '../../../stores/orchestrationSessionStore';
import { SessionOverviewOf } from '../../SessionOverviewPanel';
import { ApprovalColumn } from '../../approvals/ApprovalColumn';
import { ApprovalOrigin } from '../../approvals/ApprovalOrigin';
import { SplitApprovalOverlay } from '../../approvals/SplitApprovalOverlay';
import { MachineDocument } from '../../approvals/MachineContext';
import { AutopilotDocument, AutopilotWebPage, FittedImage } from '../../autopilot/AutopilotDocument';
import { Dropdown } from '../../ui/Dropdown';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { cn } from '../../../utils/cn';
import { isMac, isWindows } from '../../../utils/platformUtils';
import { splitItemKey, type TodoSplitAction, type TodoSplitItem, type TodoSplitState } from './splitTabs';
import {
  ATTACHMENT_KIND_ICON, AttachField, attachmentFileName, attachmentIsHere, isWebTarget, openAttachmentOutside, revealAttachment,
} from './TodoAttach';
import { useAttachDrop } from './thread/useThreadSend';

/** An approval shown over the split (round 7): which, and the tab it covers ("‹ Back to Plan"). */
export interface TodoApprovalOpen {
  id: string;
  returnTab: string;
}

export interface TodoSplitProps {
  detail: TodoDetail;
  split: TodoSplitState;
  dispatch: (action: TodoSplitAction) => void;
  /** The approval over the split, if one is open. */
  approval: TodoApprovalOpen | null;
  onOpenApproval: (id: string) => void;
  onCloseApproval: () => void;
  /** + Attach landed this target: its tab shows once it arrives. */
  onAttached: (target: string) => void;
}

/**
 * The Session whose Overview the split offers (round 8, T-4): the to-do's own, or its parent's for a
 * sub-to-do, when it is on this machine and this machine's Sessions have it. A to-do on another
 * machine has no Overview tab: its Sessions aren't read from here.
 */
export function useSplitOverviewSession(detail: TodoDetail): string | null {
  const sessionId = detail.todo.sessionId ?? detail.parent?.todo.sessionId ?? null;
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const here = (detail.machineId ?? LOCAL_MACHINE_ID) === LOCAL_MACHINE_ID && activeMachineId === LOCAL_MACHINE_ID;
  const known = useOrchestrationSessionStore((state) => sessionId !== null && state.sessions.some((session) => session.id === sessionId));
  return here && known ? sessionId : null;
}

/** A tab's words: "Plan" for the first plan, "Overview" for the Session's, otherwise the attachment's own label. */
export function splitTabLabel(item: TodoSplitItem, items: readonly TodoSplitItem[]): string {
  if (item.kind === 'image') return item.label;
  if (item.kind === 'overview') return 'Overview';
  if (item.attachment.kind === 'plan') {
    const firstPlan = items.find((other) => other.kind === 'attachment' && other.attachment.kind === 'plan');
    if (firstPlan === item) return 'Plan';
  }
  return item.attachment.label;
}

/**
 * The right split beside a to-do (round 7, D-418): the to-do's attachments as tabs, plan first,
 * with a file bar (file, who and when, Open ↗, ⋯) and + Attach. Files and pages use the viewers
 * the approval column's links use. An approval covers it, as one covers a Session's right split.
 */
export function TodoSplit({ detail, split, dispatch, approval, onOpenApproval, onCloseApproval, onAttached }: TodoSplitProps) {
  const active = split.items[split.active];
  const [attaching, setAttaching] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // A file dropped on the split is attached to the to-do, and its tab shows (round 8, T-5).
  const drop = useAttachDrop(detail.todo.number, onAttached);
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') dispatch({ type: 'activate', index: 0 });
    else if (event.key === 'End') dispatch({ type: 'activate', index: split.items.length - 1 });
    else dispatch({ type: 'step', delta: event.key === 'ArrowRight' ? 1 : -1 });
  };
  // Roving tabindex: focus follows the tab the arrows chose.
  useEffect(() => {
    const element = strip.current;
    if (!element || !element.contains(document.activeElement)) return;
    element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [split.active]);
  return (
    <section ref={sectionRef} onDragOver={drop.onDragOver} onDragLeave={drop.onDragLeave} onDrop={drop.onDrop} className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`${detail.todo.ref} attachments`} data-testid="todo-split" data-dragging={drop.dragging || undefined}>
      {drop.dragging && <div className="pointer-events-none absolute inset-1 z-10 rounded-lg border-2 border-dashed border-border-interactive bg-transparent" aria-hidden="true" />}
      {split.items.length > 0 && (
        <>
          <div className="flex h-9 shrink-0 items-stretch border-b border-border-primary bg-surface-secondary px-1">
            <div ref={strip} role="tablist" aria-label="Attachments" onKeyDown={onTabKey} className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto">
              {split.items.map((item, index) => (
                <SplitTab key={splitItemKey(item)} item={item} label={splitTabLabel(item, split.items)} active={index === split.active}
                  onPick={() => dispatch({ type: 'activate', index })} onClose={() => dispatch({ type: 'close', index })} />
              ))}
            </div>
            {attaching
              ? <AttachField number={detail.todo.number} onAttached={onAttached} onClose={() => setAttaching(false)} className="my-auto ml-1" />
              : (
                <button type="button" onClick={() => setAttaching(true)} aria-label="Attach a file or link" title="Attach a file or link" className="my-auto ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary" data-testid="todo-split-attach">
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {active?.kind === 'attachment' && <SplitAttachment key={active.attachment.id} detail={detail} attachment={active.attachment} from={active.from} />}
            {active?.kind === 'overview' && <SessionOverviewOf key={active.sessionId} sessionId={active.sessionId} />}
            {active?.kind === 'image' && (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="todo-split-image">
                <FittedImage src={active.src} label={active.label} />
              </div>
            )}
          </div>
        </>
      )}
      {approval && <ApprovalOverSplit key={approval.id} baseRef={sectionRef} detail={detail} approval={approval} onOpenApproval={onOpenApproval} onClose={onCloseApproval} />}
    </section>
  );
}

function SplitTab({ item, label, active, onPick, onClose }: { item: TodoSplitItem; label: string; active: boolean; onPick: () => void; onClose: () => void }) {
  const Icon = item.kind === 'attachment' ? ATTACHMENT_KIND_ICON[item.attachment.kind] : item.kind === 'overview' ? BarChart3 : ImageIcon;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onPick}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(); } }}
      className={cn(
        'flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus',
        active ? 'border-interactive bg-bg-primary font-semibold text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
      )}
      title={item.kind === 'attachment' ? item.attachment.target : item.kind === 'overview' ? 'The Session’s Overview' : item.src}
      data-testid="todo-split-tab"
      data-key={splitItemKey(item)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[180px] truncate">{label}</span>
      {item.kind === 'attachment' && item.from !== undefined && <span className="text-[10.5px] font-medium text-text-tertiary">from T-{item.from}</span>}
      {item.kind === 'image' && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => { event.stopPropagation(); onClose(); }}
          aria-label={`Close ${label}`}
          title="Close"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          data-testid="todo-split-tab-close"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** A file or page attached to the to-do: the file bar, then a URL as a page, or a file from the to-do's machine. */
function SplitAttachment({ detail, attachment, from }: { detail: TodoDetail; attachment: TodoAttachment; from?: number }) {
  const now = useNow();
  const act = useTodosStore((state) => state.act);
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const machineId = detail.machineId ?? LOCAL_MACHINE_ID;
  const web = isWebTarget(attachment.target);
  const here = attachmentIsHere(detail, attachment, activeMachineId);
  const Icon = ATTACHMENT_KIND_ICON[attachment.kind];
  const revealLabel = isMac() ? 'Reveal in Finder' : isWindows() ? 'Show in Explorer' : 'Show in folder';
  const menu = [
    { id: 'reveal', label: revealLabel, disabled: web || !here, onClick: () => revealAttachment(attachment) },
    { id: 'detach', label: 'Detach', variant: 'danger' as const, disabled: from !== undefined, description: from !== undefined ? `Attached to T-${from}` : undefined, onClick: () => void act({ kind: 'detach', number: detail.todo.number, attachmentId: attachment.id }) },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="todo-split-attachment" data-attachment={attachment.id}>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border-secondary px-3 text-[12px] text-text-tertiary" data-testid="todo-split-filebar">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate text-text-secondary" title={attachment.target}>{attachmentFileName(attachment)}</span>
        <span className="shrink-0">· {attachment.addedBy} · {relativeAge(attachment.addedAt, now)}</span>
        {from !== undefined && <span className="shrink-0">· from T-{from}</span>}
        {!here && <span className="shrink-0 truncate">· on {attachment.machine ?? detail.machine}</span>}
        <span className="flex-1" />
        {here && (
          <button type="button" onClick={() => openAttachmentOutside(attachment)} className="inline-flex shrink-0 items-center gap-1 text-interactive-text hover:underline" data-testid="todo-split-open">
            Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        <Dropdown
          trigger={<button type="button" aria-label={`${attachment.label} actions`} className="inline-flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary" data-testid="todo-split-more"><MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" /></button>}
          items={menu}
          position="bottom-right"
          menuLabel={`${attachment.label} actions`}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {web
          ? <AutopilotWebPage key={attachment.target} src={attachment.target} title={attachment.label} />
          : here
            ? <AutopilotDocument key={attachment.target} path={attachment.target} label={attachment.label} />
            : <MachineDocument key={attachment.target} item={{ machineId }} path={attachment.target} label={attachment.label} machine={attachment.machine ?? detail.machine} />}
      </div>
    </div>
  );
}

interface ApprovalOverSplitProps {
  baseRef: RefObject<HTMLElement | null>;
  detail: TodoDetail;
  approval: TodoApprovalOpen;
  onOpenApproval: (id: string) => void;
  onClose: () => void;
}

/** The whole split is what the approval covers. */
const coverSplit = (base: HTMLElement): readonly Element[] => [base];

/**
 * The approval over the split, headed "‹ Back to Plan" (round 7, section 5), through the same
 * overlay a Session uses (SplitApprovalOverlay): ✕, Back, Esc and answering close it.
 */
function ApprovalOverSplit({ baseRef, detail, approval, onOpenApproval, onClose }: ApprovalOverSplitProps) {
  const surface = todoApprovalSurface(detail.todo.number);
  const items = useNotifyStore(selectNotifyItems);
  const item = items.find((candidate) => candidate.id === approval.id);
  const waiting = item ? countsAsWaiting(item) : false;
  const order = useMemo(() => {
    const linked = new Set(detail.approvalIds);
    return items.filter((candidate) => linked.has(candidate.id) && countsAsWaiting(candidate)).sort((a, b) => a.createdAt - b.createdAt).map((candidate) => candidate.id);
  }, [items, detail.approvalIds]);
  // Each approval opens on its Q&A tab; the column keeps its own tab within it after that.
  useEffect(() => {
    const store = useApprovalColumnStore.getState();
    if (store.open[surface]?.itemId !== approval.id) store.openApproval(surface, approval.id);
  }, [surface, approval.id]);
  // Answered here (it was waiting, now it isn't): back to the tab, as a Session does.
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (wasWaiting.current && !waiting) onClose();
    wasWaiting.current = waiting;
  }, [waiting, onClose]);
  return (
    <SplitApprovalOverlay open baseRef={baseRef} targets={coverSplit} targetsKey={`todo-split-${detail.todo.number}`} underneath={approval.returnTab}
      testId="todo-approval-over-split" onEscape={onClose}>
      {(closeLabel) => (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" role="region" aria-label="Approval">
          <ApprovalColumn
            surface={surface}
            itemId={approval.id}
            order={order}
            onSelect={onOpenApproval}
            groupLabel={`${detail.todo.ref} approvals`}
            closeLabel={closeLabel}
            onClose={onClose}
            renderOrigin={(origin) => <ApprovalOrigin item={origin} />}
          />
        </div>
      )}
    </SplitApprovalOverlay>
  );
}

