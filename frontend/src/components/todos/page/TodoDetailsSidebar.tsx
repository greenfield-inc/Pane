import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { TodoAttachment, TodoAttachmentSource, TodoDetail } from '../../../../../shared/types/todos';
import { useTodosStore } from '../../../stores/todosStore';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { cn } from '../../../utils/cn';
import { TodoStatusPill } from '../TodoStatusIcon';
import { focusTodoTab, openTodoSession } from './todoNavigation';
import { AgentAvatar, SectionAction, SectionLabel, SubTodoRows, agoText } from './TodoPageParts';
import { ATTACHMENT_KIND_ICON, ATTACHMENT_KIND_LABEL, AttachField } from './TodoAttach';

/** How an attachment came, when Pane attached it on its own. */
const SOURCE_WORDS = {
  attached: undefined,
  pr: 'from an assigned PR',
  approval: 'from an approval',
  opened: 'opened beside you',
} as const satisfies Record<TodoAttachmentSource, string | undefined>;

export type TodoDetailsTab = 'details' | 'attachments';
const TABS: readonly TodoDetailsTab[] = ['details', 'attachments'];

export interface TodoDetailsSidebarProps {
  detail: TodoDetail;
  tab: TodoDetailsTab;
  onTab: (tab: TodoDetailsTab) => void;
  /** The attachment shown in the split, ringed here. */
  openAttachmentId?: number;
  onOpenAttachment: (attachment: TodoAttachment) => void;
  onOpenTodo: (number: number) => void;
  /** + Attach landed this target: the split shows it. */
  onAttached: (target: string) => void;
  onClose: () => void;
}

/**
 * The details sidebar on the page's right edge (round 7, D-418): closed by default on every to-do,
 * toggled from the header as a Session's is. Details: who and where, machine load, keep moving and
 * the sub-to-dos. Attachments: every attachment, who added it and when, + Attach and Detach.
 */
export function TodoDetailsSidebar({ detail, tab, onTab, openAttachmentId, onOpenAttachment, onOpenTodo, onAttached, onClose }: TodoDetailsSidebarProps) {
  const total = detail.attachments.reduce((sum, group) => sum + group.attachments.length, 0);
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
            {name === 'details' ? 'Details' : `Attachments · ${total}`}
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
          : <AttachmentsTab detail={detail} openAttachmentId={openAttachmentId} onOpen={onOpenAttachment} onAttached={onAttached} />}
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

function AttachmentsTab({ detail, openAttachmentId, onOpen, onAttached }: {
  detail: TodoDetail; openAttachmentId?: number; onOpen: (attachment: TodoAttachment) => void; onAttached: (target: string) => void;
}) {
  const now = useNow();
  const [attaching, setAttaching] = useState(false);
  const own = detail.attachments.find((group) => !group.from);
  const inherited = detail.attachments.filter((group) => group.from && group.attachments.length > 0);
  const total = detail.attachments.reduce((sum, group) => sum + group.attachments.length, 0);
  return (
    <div data-testid="todo-attachments">
      <SectionLabel className="mt-0" action={attaching
        ? <AttachField number={detail.todo.number} onAttached={onAttached} onClose={() => setAttaching(false)} className="ml-2" />
        : <SectionAction label="Attach" onClick={() => setAttaching(true)} testId="todo-attach" />}>
        Attachments · {total}
      </SectionLabel>
      {(own?.attachments.length ?? 0) === 0 && <p className="mb-1.5 text-[12.5px] text-text-tertiary">Nothing attached here yet.</p>}
      {own?.attachments.map((attachment) => <AttachmentRow key={attachment.id} detail={detail} attachment={attachment} now={now} open={attachment.id === openAttachmentId} onOpen={onOpen} canDetach />)}
      {inherited.map((group) => group.from && (
        <div key={`${group.from.relation}:${group.from.number}`} data-testid="todo-attachment-group" data-from={group.from.number}>
          <div className="mb-1 mt-2 text-[11.5px] text-text-tertiary">From T-{group.from.number}{group.from.relation === 'parent' ? ' (parent)' : ''}</div>
          {group.attachments.map((attachment) => <AttachmentRow key={attachment.id} detail={detail} attachment={attachment} now={now} open={attachment.id === openAttachmentId} onOpen={onOpen} canDetach={false} />)}
        </div>
      ))}
    </div>
  );
}

function AttachmentRow({ detail, attachment, now, open, onOpen, canDetach }: {
  detail: TodoDetail; attachment: TodoAttachment; now: number; open: boolean; onOpen: (attachment: TodoAttachment) => void; canDetach: boolean;
}) {
  const act = useTodosStore((state) => state.act);
  const Icon = ATTACHMENT_KIND_ICON[attachment.kind];
  const meta = [ATTACHMENT_KIND_LABEL[attachment.kind], attachment.note, SOURCE_WORDS[attachment.source], attachment.addedBy, relativeAge(attachment.addedAt, now)].filter(Boolean).join(' · ');
  return (
    <div className={cn('group mb-0.5 flex items-center rounded-md hover:bg-surface-hover', open && 'bg-surface-hover')}>
      <button
        type="button"
        onClick={() => onOpen(attachment)}
        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left"
        title={attachment.target}
        aria-current={open || undefined}
        data-testid="todo-attachment"
        data-attachment={attachment.id}
      >
        <Icon className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-text-primary">{attachment.label}</span>
          <span className="block truncate text-[11.5px] text-text-tertiary">{meta}</span>
        </span>
      </button>
      {canDetach && (
        <button
          type="button"
          onClick={() => void act({ kind: 'detach', number: detail.todo.number, attachmentId: attachment.id })}
          className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-text-tertiary opacity-0 hover:bg-surface-tertiary hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={`Detach ${attachment.label}`}
          data-testid="todo-attachment-detach"
        >
          Detach
        </button>
      )}
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
