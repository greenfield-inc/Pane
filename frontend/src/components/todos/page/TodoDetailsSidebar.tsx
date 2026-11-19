import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ExternalLink, MoreHorizontal, Search, X } from 'lucide-react';
import type { TodoAttachment, TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { useTodosStore } from '../../../stores/todosStore';
import { useAllMachinesStore } from '../../../stores/allMachinesStore';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { cn } from '../../../utils/cn';
import { TodoStatusPill } from '../TodoStatusIcon';
import { focusTodoTab, openTodoSession } from './todoNavigation';
import { AgentAvatar, SectionAction, SectionLabel, SubTodoRows, agoText } from './TodoPageParts';
import { ATTACHMENT_KIND_ICON, AttachField, attachmentIsHere, openAttachmentOutside } from './TodoAttach';
import { fileOrigin, groupTodoFiles, todoFileRows, type TodoFileRow } from './todoFiles';
import { useAttachDrop } from './thread/useThreadSend';

export type TodoDetailsTab = 'details' | 'files';
const TABS: readonly TodoDetailsTab[] = ['details', 'files'];

export interface TodoDetailsSidebarProps {
  detail: TodoDetail;
  tab: TodoDetailsTab;
  onTab: (tab: TodoDetailsTab) => void;
  /** The attachment shown in the split, ringed here. */
  openAttachmentId?: number;
  /** The split's closed tabs (T-25), marked "closed" in Files. */
  closedTabs: readonly string[];
  onOpenAttachment: (attachment: TodoAttachment) => void;
  onOpenTodo: (number: number) => void;
  /** + Attach landed this target: the split shows it. */
  onAttached: (target: string) => void;
  onClose: () => void;
}

/**
 * The details sidebar on the page's right edge (round 7, D-418): closed by default on every to-do,
 * toggled from the header as a Session's is. Details: who and where, machine load, keep moving and
 * the sub-to-dos. Files (T-26): a file browser of every file the to-do has, its sub-to-dos' and its
 * parent's, grouped by kind with a search; a click opens one in the split.
 */
export function TodoDetailsSidebar({ detail, tab, onTab, openAttachmentId, closedTabs, onOpenAttachment, onOpenTodo, onAttached, onClose }: TodoDetailsSidebarProps) {
  const total = useMemo(() => todoFileRows(detail.attachments).length, [detail.attachments]);
  const closed = useMemo(() => new Set(closedTabs), [closedTabs]);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: TodoDetailsTab) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(current) + 1) % TABS.length];
    onTab(next);
    document.getElementById(`todo-details-tab-${next}`)?.focus();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="todo-details">
      <div role="tablist" aria-label="To-do details" className="flex h-9 shrink-0 items-stretch border-b border-border-primary bg-surface-secondary px-1">
        {TABS.map((name) => (
          <button
            key={name}
            id={`todo-details-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => onTab(name)}
            onKeyDown={(event) => onTabKey(event, name)}
            className={cn(
              'border-b-2 px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus',
              tab === name ? 'border-interactive font-semibold text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
            data-testid={`todo-details-tab-${name}`}
          >
            {name === 'details' ? 'Details' : `Files · ${total}`}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Hide details" title="Hide details" className="my-auto inline-flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div role="tabpanel" aria-labelledby={`todo-details-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {tab === 'details'
          ? <DetailsTab detail={detail} onOpenTodo={onOpenTodo} />
          : <FilesTab detail={detail} closedTabs={closed} openAttachmentId={openAttachmentId} onOpen={onOpenAttachment} onAttached={onAttached} />}
      </div>
    </div>
  );
}

function DetailsTab({ detail, onOpenTodo }: { detail: TodoDetail; onOpenTodo: (number: number) => void }) {
  const act = useTodosStore((state) => state.act);
  const now = useNow();
  const { todo, status } = detail;
  const closed = status.status === 'done' || status.status === 'dropped';
  const working = status.status === 'working' || status.status === 'waiting';
  const worker = todo.assignee ?? (detail.orchestrator ? { panelId: detail.orchestrator.panelId, name: detail.orchestrator.name } : null);
  const neverPause = todo.loadOverride === 'never_pause';
  const doneSubs = detail.subTodos.filter((row) => row.status.status === 'done').length;
  return (
    <>
      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-2 gap-y-[9px] text-[12.5px]" data-testid="todo-rail">
        <Prop label="Status"><TodoStatusPill status={status.status} className="h-6 text-[12px] font-medium" /></Prop>
        <Prop label="Session">
          {todo.sessionId || detail.parent?.todo.sessionId
            ? <LinkButton onClick={() => openTodoSession(detail)} testId="todo-rail-session">{detail.sessionName ?? todo.ref} <ExternalLink className="ml-0.5 inline h-3 w-3" aria-hidden="true" /></LinkButton>
            : <Muted>not created yet</Muted>}
        </Prop>
        <Prop label="Requested by">
          {todo.requester.kind === 'person'
            ? <><AgentAvatar name="you" /> <span className="truncate">{todo.requester.name}</span></>
            : <>
              <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', todo.requester.gone ? 'bg-border-hover' : 'bg-status-info')} aria-hidden="true" />
              <span className={cn('truncate', todo.requester.gone && 'text-text-tertiary line-through')} data-testid="todo-rail-requester" data-gone={todo.requester.gone || undefined}>{todo.requester.name}</span>
              {todo.requester.gone && <Muted>(gone)</Muted>}
            </>}
        </Prop>
        <Prop label="Managed by"><AgentAvatar agentId={detail.orchestrator?.agentId ?? todo.agent ?? undefined} name="orchestrator" /> <span className="truncate">its own orchestrator</span></Prop>
        <Prop label="Working it">
          {working && worker
            ? <><AgentAvatar agentId={detail.agentId} name={worker.name ?? 'agent'} /> <LinkButton onClick={() => focusTodoTab(detail, worker.panelId)}>{worker.name ?? 'its agent'}</LinkButton></>
            : <Muted>nobody right now</Muted>}
        </Prop>
        <Prop label="Chat goes to">
          <AgentAvatar agentId={detail.chatTarget.kind === 'orchestrator' ? detail.orchestrator?.agentId : detail.agentId} name={detail.chatTarget.name} />
          <span className="truncate">{detail.chatTarget.name}</span>
        </Prop>
        <Prop label="Repo"><span className="truncate">{detail.projectName ?? '–'}</span></Prop>
        <Prop label="Machine"><span className="truncate" data-testid="todo-rail-machine">{detail.machine}</span></Prop>
        {detail.pr && (
          <Prop label="PR">
            {detail.pr.url
              ? <LinkButton onClick={() => { if (detail.pr?.url) void window.electronAPI.openExternal(detail.pr.url); }}>{detail.pr.label}</LinkButton>
              : <span className="truncate">{detail.pr.label}</span>}
          </Prop>
        )}
        <Prop label="Machine load">
          {status.status === 'queued' ? (
            <>
              <span className="truncate text-text-secondary">held · {detail.load.reason ?? status.reason}</span>
              <span className="shrink-0"><LinkButton onClick={() => void act({ kind: 'start', number: todo.number, anyway: true })} testId="todo-rail-start-anyway">Start anyway</LinkButton></span>
            </>
          ) : closed ? <Muted>–</Muted> : (
            <>
              <span className="truncate">{neverPause ? 'never paused' : detail.load.canPause ? 'can pause' : detail.load.reason ?? 'won’t pause'}</span>
              <span className="text-text-tertiary">·</span>
              <LinkButton onClick={() => void act({ kind: 'never-pause', number: todo.number, on: !neverPause })} testId="todo-rail-never-pause">{neverPause ? 'Allow pause' : 'Never pause'}</LinkButton>
            </>
          )}
        </Prop>
        <Prop label="Keep moving"><span className={cn('truncate', status.alert && 'text-status-error')}>{detail.keepMoving}</span></Prop>
        <Prop label="Created"><span className="truncate">{agoText(todo.createdAt, now)} by {todo.createdBy}</span></Prop>
      </dl>
      {detail.subTodos.length > 0 && (
        <>
          <SectionLabel className="mt-4">Sub-to-dos · {doneSubs} of {detail.subTodos.length} done</SectionLabel>
          <SubTodoRows rows={detail.subTodos} onOpen={onOpenTodo} compact />
        </>
      )}
    </>
  );
}

function FilesTab({ detail, closedTabs, openAttachmentId, onOpen, onAttached }: {
  detail: TodoDetail; closedTabs: ReadonlySet<string>; openAttachmentId?: number; onOpen: (attachment: TodoAttachment) => void; onAttached: (target: string) => void;
}) {
  const now = useNow();
  const [attaching, setAttaching] = useState(false);
  const [query, setQuery] = useState('');
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  // The same detail the page watches, so a file attached anywhere shows here at once (T-26).
  const rows = useMemo(() => todoFileRows(detail.attachments), [detail.attachments]);
  const groups = useMemo(() => groupTodoFiles(rows, query), [rows, query]);
  // A file dropped here is attached to the to-do straight away (round 8, T-5).
  const drop = useAttachDrop(detail.todo.number, onAttached);
  return (
    <div onDragOver={drop.onDragOver} onDragLeave={drop.onDragLeave} onDrop={drop.onDrop}
      className={cn('-m-1.5 min-h-[120px] rounded-lg border-2 border-dashed p-1', drop.dragging ? 'border-border-interactive bg-interactive-surface' : 'border-transparent')}
      data-testid="todo-files" data-dragging={drop.dragging || undefined}>
      <div className="mb-2 flex items-center gap-1.5">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border-primary bg-surface-primary px-2 focus-within:border-border-interactive">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Esc clears the search first, before it reaches the page.
              if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
            }}
            placeholder="Search files"
            aria-label="Search files"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary"
            data-testid="todo-files-search"
          />
        </label>
        {attaching
          ? <AttachField number={detail.todo.number} onAttached={onAttached} onClose={() => setAttaching(false)} className="h-7 w-[150px]" />
          : <SectionAction label="Attach" onClick={() => setAttaching(true)} testId="todo-attach" />}
      </div>
      {rows.length === 0 && <p className="mb-1.5 px-1 text-[12.5px] text-text-tertiary">Nothing attached yet.</p>}
      {rows.length > 0 && groups.length === 0 && <p className="mb-1.5 px-1 text-[12.5px] text-text-tertiary" data-testid="todo-files-none">No files match “{query.trim()}”.</p>}
      {groups.map((group) => (
        <section key={group.kind} aria-label={group.label} data-testid="todo-files-group" data-kind={group.kind}>
          <SectionLabel className="mb-1 mt-2.5">{group.label} · {group.rows.length}</SectionLabel>
          {group.rows.map((row) => (
            <FileRow key={row.attachment.id} detail={detail} row={row} now={now} here={attachmentIsHere(detail, row.attachment, activeMachineId)}
              open={row.attachment.id === openAttachmentId} closed={closedTabs.has(`attachment:${row.attachment.id}`)} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** One file: its kind's icon and label; then where it came from, its machine when not here, and when. ⋯ has Open outside and Detach. */
function FileRow({ detail, row, now, here, open, closed, onOpen }: {
  detail: TodoDetail; row: TodoFileRow; now: number; here: boolean; open: boolean; closed: boolean; onOpen: (attachment: TodoAttachment) => void;
}) {
  const act = useTodosStore((state) => state.act);
  const { attachment } = row;
  const Icon = ATTACHMENT_KIND_ICON[attachment.kind];
  const meta = [fileOrigin(row), here ? null : `on ${attachment.machine ?? detail.machine}`, relativeAge(attachment.addedAt, now)].filter(Boolean).join(' · ');
  const menu: DropdownItem[] = [
    { id: 'open-outside', label: 'Open outside', disabled: !here, description: here ? undefined : `On ${attachment.machine ?? detail.machine}`, onClick: () => openAttachmentOutside(attachment) },
  ];
  if (!row.from) menu.push({ id: 'detach', label: 'Detach', variant: 'danger', onClick: () => void act({ kind: 'detach', number: detail.todo.number, attachmentId: attachment.id }) });
  return (
    <div className={cn('group mb-0.5 flex items-center rounded-md hover:bg-surface-hover', open && 'bg-surface-hover')} data-testid="todo-file-row">
      <button
        type="button"
        onClick={() => onOpen(attachment)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        title={attachment.target}
        aria-current={open || undefined}
        data-testid="todo-file"
        data-attachment={attachment.id}
        data-closed={closed || undefined}
      >
        <Icon className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-text-primary">{attachment.label}</span>
            {closed && <span className="shrink-0 rounded border border-border-secondary px-1 text-[10.5px] leading-[15px] text-text-tertiary" title="Its tab is closed: opening it reopens the tab" data-testid="todo-file-closed">closed</span>}
          </span>
          <span className="block truncate text-[11.5px] text-text-tertiary">{meta}</span>
        </span>
      </button>
      <Dropdown
        trigger={<button type="button" aria-label={`${attachment.label} actions`} className="mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary opacity-0 hover:bg-surface-tertiary hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100" data-testid="todo-file-more"><MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" /></button>}
        items={menu}
        position="bottom-right"
        menuLabel={`${attachment.label} actions`}
      />
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-text-primary">{children}</dd>
    </>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="truncate text-text-tertiary">{children}</span>;
}

function LinkButton({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return <button type="button" onClick={onClick} className="min-w-0 truncate text-left text-interactive-text hover:underline" data-testid={testId}>{children}</button>;
}
