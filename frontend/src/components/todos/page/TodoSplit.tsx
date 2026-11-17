import { useEffect, useMemo } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { NotifyItem } from '../../../../../shared/types/notify';
import type { TodoAttachment, TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { selectNotifyItems, useNotifyStore, countsAsWaiting } from '../../../stores/notifyStore';
import { todoApprovalSurface, useApprovalColumnStore } from '../../../stores/approvalColumnStore';
import { useAllMachinesStore } from '../../../stores/allMachinesStore';
import { ApprovalColumn } from '../../approvals/ApprovalColumn';
import { ApprovalOrigin } from '../../approvals/ApprovalOrigin';
import { MachineDocument } from '../../approvals/MachineContext';
import { AutopilotDocument, AutopilotWebPage } from '../../autopilot/AutopilotDocument';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { leadingQn } from '../../../../../shared/autopilotDecision';
import { cn } from '../../../utils/cn';
import { TodoStatusIcon } from '../TodoStatusIcon';
import { isWebTarget } from './chatEntries';
import { splitItemKey, type TodoSplitAction, type TodoSplitItem, type TodoSplitState } from './splitTabs';
import { ATTACHMENT_KIND_LABEL } from './TodoRail';

export interface TodoSplitProps {
  detail: TodoDetail;
  split: TodoSplitState;
  dispatch: (action: TodoSplitAction) => void;
}

/**
 * The right split beside a to-do (D-407), in place of the details rail: tabs across the top, ✕
 * closes one, Close split closes all. Approvals are the real approval column, so answering here
 * is answering in Approvals; files and pages use the viewers the column's links use.
 */
export function TodoSplit({ detail, split, dispatch }: TodoSplitProps) {
  const items = useNotifyStore(selectNotifyItems);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const active = split.items[split.active];
  const count = split.items.length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="todo-split">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-primary pl-3.5 pr-2.5 text-[12.5px] text-text-secondary">
        <span className="min-w-0 truncate">Open beside {detail.todo.ref} · {count} {count === 1 ? 'item' : 'items'}</span>
        <button type="button" onClick={() => dispatch({ type: 'close-all' })} title="Close split (Esc closes the open tab)" className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="todo-split-close-all">
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Close split
        </button>
      </div>
      <div role="tablist" aria-label={`Open beside ${detail.todo.ref}`} className="scrollbar-thin flex shrink-0 overflow-x-auto border-b border-border-primary">
        {split.items.map((item, index) => (
          <SplitTab key={splitItemKey(item)} item={item} notify={item.kind === 'approval' ? byId.get(item.id) : undefined} active={index === split.active}
            onPick={() => dispatch({ type: 'activate', index })} onClose={() => dispatch({ type: 'close', index })} />
        ))}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {active?.kind === 'approval' && <SplitApproval key={active.id} detail={detail} itemId={active.id} dispatch={dispatch} />}
        {active?.kind === 'attachment' && <SplitAttachment key={active.attachment.id} detail={detail} attachment={active.attachment} />}
        {active?.kind === 'image' && (
          <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-surface-primary p-4" data-testid="todo-split-image">
            <img src={active.src} alt={active.label} className="max-w-full rounded-md border border-border-primary" />
          </div>
        )}
      </div>
    </div>
  );
}

function tabLabel(item: TodoSplitItem, notify: NotifyItem | undefined): string {
  if (item.kind === 'approval') return (notify && leadingQn(notify.title)) ?? notify?.title ?? 'Approval';
  if (item.kind === 'attachment') return item.attachment.label;
  return item.label;
}

function SplitTab({ item, notify, active, onPick, onClose }: { item: TodoSplitItem; notify?: NotifyItem; active: boolean; onPick: () => void; onClose: () => void }) {
  const label = tabLabel(item, notify);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onPick}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(); } }}
      onAuxClick={(event) => { if (event.button === 1) onClose(); }}
      className={cn(
        'flex h-[38px] shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 pl-3 pr-1.5 text-[12.5px] outline-none focus-visible:bg-surface-hover',
        active ? 'border-interactive font-semibold text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
      )}
      data-testid="todo-split-tab"
      data-key={splitItemKey(item)}
    >
      {item.kind === 'approval' && <TodoStatusIcon status={notify && countsAsWaiting(notify) ? 'waiting' : 'done'} />}
      <span className="max-w-[180px] truncate">{label}</span>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        aria-label={`Close ${label}`}
        title="Close"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
        data-testid="todo-split-tab-close"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The approval column, as in a Session: its pager walks this to-do's waiting approvals. */
function SplitApproval({ detail, itemId, dispatch }: { detail: TodoDetail; itemId: string; dispatch: (action: TodoSplitAction) => void }) {
  const surface = todoApprovalSurface(detail.todo.number);
  const items = useNotifyStore(selectNotifyItems);
  const order = useMemo(() => {
    const linked = new Set(detail.approvalIds);
    return items.filter((item) => linked.has(item.id) && countsAsWaiting(item)).sort((a, b) => a.createdAt - b.createdAt).map((item) => item.id);
  }, [items, detail.approvalIds]);
  // Each approval opens on its Q&A tab; the column keeps its own tab within it after that.
  useEffect(() => {
    const store = useApprovalColumnStore.getState();
    if (store.open[surface]?.itemId !== itemId) store.openApproval(surface, itemId);
  }, [surface, itemId]);
  return (
    <ApprovalColumn
      surface={surface}
      itemId={itemId}
      order={order}
      onSelect={(id) => dispatch({ type: 'open', item: { kind: 'approval', id } })}
      groupLabel={`${detail.todo.ref} approvals`}
      renderOrigin={(item) => <ApprovalOrigin item={item} />}
    />
  );
}

/** A file or page attached to the to-do: a URL as a page; a file from the to-do's machine. */
function SplitAttachment({ detail, attachment }: { detail: TodoDetail; attachment: TodoAttachment }) {
  const now = useNow();
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const machineId = detail.machineId ?? LOCAL_MACHINE_ID;
  const web = isWebTarget(attachment.target);
  const here = machineId === LOCAL_MACHINE_ID && activeMachineId === LOCAL_MACHINE_ID;
  const meta = [ATTACHMENT_KIND_LABEL[attachment.kind], attachment.note, attachment.addedBy, relativeAge(attachment.addedAt, now)].filter(Boolean).join(' · ');
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="todo-split-attachment" data-attachment={attachment.id}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-secondary px-3.5 text-[11.5px] text-text-tertiary">
        <span className="min-w-0 truncate">{meta}</span>
        {!here && !web && <span className="shrink-0">· on {attachment.machine ?? detail.machine}</span>}
        {web && (
          <button type="button" onClick={() => void window.electronAPI.openExternal(attachment.target)} className="ml-auto inline-flex shrink-0 items-center gap-1 hover:text-text-primary">
            Open in browser <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
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
