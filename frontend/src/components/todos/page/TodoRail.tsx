import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { TodoAttachment, TodoAttachmentKind, TodoAttachmentSource, TodoDetail } from '../../../../../shared/types/todos';
import { useTodosStore } from '../../../stores/todosStore';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { cn } from '../../../utils/cn';
import { TodoStatusPill } from '../TodoStatusIcon';
import { focusTodoTab, openTodoSession } from './todoNavigation';
import { AgentAvatar, SectionAction, SectionLabel, SubTodoRows } from './TodoPageParts';

/** Each attachment kind's word in the card's left column. */
export const ATTACHMENT_KIND_LABEL = {
  plan: 'Plan', mockup: 'Mock-up', design: 'Design', pr: 'PR', findings: 'Findings', decision: 'Decision',
  doc: 'Doc', image: 'Image', link: 'Link', status: 'Status', checklist: 'Checklist',
} as const satisfies Record<TodoAttachmentKind, string>;

/** How an attachment came, when Pane attached it on its own. */
const SOURCE_WORDS = {
  attached: undefined,
  pr: 'from an assigned PR',
  approval: 'from an approval',
  opened: 'opened beside you',
} as const satisfies Record<TodoAttachmentSource, string | undefined>;

export interface TodoRailProps {
  detail: TodoDetail;
  /** The attachment shown in the split, ringed here. */
  openAttachmentId?: number;
  onOpenAttachment: (attachment: TodoAttachment) => void;
  onOpenTodo: (number: number) => void;
}

/** The details rail: who and where, machine load, keep moving, attachments and sub-to-dos. */
export function TodoRail({ detail, openAttachmentId, onOpenAttachment, onOpenTodo }: TodoRailProps) {
  const act = useTodosStore((state) => state.act);
  const { todo, status } = detail;
  const closed = status.status === 'done' || status.status === 'dropped';
  const working = status.status === 'working' || status.status === 'waiting';
  const worker = todo.assignee ?? (detail.orchestrator ? { panelId: detail.orchestrator.panelId, name: detail.orchestrator.name } : null);
  const neverPause = todo.loadOverride === 'never_pause';
  const total = detail.attachments.reduce((sum, group) => sum + group.attachments.length, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5" data-testid="todo-rail">
      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-[9px] text-[12.5px]">
        <Prop label="Status"><TodoStatusPill status={status.status} className="h-[26px] text-[12.5px] font-medium" /></Prop>
        <Prop label="Session">
          {todo.sessionId || detail.parent?.todo.sessionId
            ? <LinkButton onClick={() => openTodoSession(detail)} testId="todo-rail-session">{detail.sessionName ?? todo.ref}</LinkButton>
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
        <Prop label="Machine"><span className="truncate">{detail.machine}</span></Prop>
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
              <LinkButton onClick={() => void act({ kind: 'start', number: todo.number, anyway: true })} testId="todo-rail-start-anyway">Start anyway</LinkButton>
            </>
          ) : closed ? <Muted>–</Muted> : (
            <>
              <span className="truncate">{neverPause ? 'never paused' : detail.load.canPause ? 'can pause' : detail.load.reason ?? 'won’t pause'}</span>
              <LinkButton onClick={() => void act({ kind: 'never-pause', number: todo.number, on: !neverPause })} testId="todo-rail-never-pause">{neverPause ? 'Allow pause' : 'Never pause'}</LinkButton>
            </>
          )}
        </Prop>
        <Prop label="Keep moving"><span className={cn('truncate', status.alert && 'text-status-error')}>{detail.keepMoving}</span></Prop>
      </dl>

      <SectionLabel className="mt-4" action={<AttachAction number={todo.number} />}>Attachments · {total}</SectionLabel>
      <Attachments detail={detail} openAttachmentId={openAttachmentId} onOpen={onOpenAttachment} />

      {detail.subTodos.length > 0 && (
        <>
          <SectionLabel className="mt-4">Sub-to-dos</SectionLabel>
          <SubTodoRows rows={detail.subTodos} onOpen={onOpenTodo} compact />
        </>
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

/** + Attach: paste a path or a URL; Enter attaches it, Esc cancels. */
function AttachAction({ number }: { number: number }) {
  const act = useTodosStore((state) => state.act);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  if (!open) return <SectionAction label="Attach" onClick={() => setOpen(true)} testId="todo-attach" />;
  const submit = async () => {
    const value = target.trim();
    if (!value) return;
    const result = await act({ kind: 'attach', number, target: value });
    if (result) {
      setTarget('');
      setOpen(false);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      // Esc closes the field, not the page.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setTarget('');
    }
  };
  return (
    <input
      autoFocus
      value={target}
      onChange={(event) => setTarget(event.target.value)}
      onKeyDown={onKey}
      onBlur={() => { if (!target.trim()) setOpen(false); }}
      placeholder="Paste a path or URL, then ↵"
      aria-label="Attach a file path or URL"
      className="ml-2 h-6 w-[190px] rounded-md border border-border-interactive bg-surface-primary px-2 text-[12px] normal-case tracking-normal text-text-primary outline-none placeholder:text-text-tertiary"
      data-testid="todo-attach-input"
    />
  );
}

/** Its own attachments, then the inherited groups: "From T-12 (parent)", "From T-14". */
function Attachments({ detail, openAttachmentId, onOpen }: { detail: TodoDetail; openAttachmentId?: number; onOpen: (attachment: TodoAttachment) => void }) {
  const now = useNow();
  const own = detail.attachments.find((group) => !group.from);
  const inherited = detail.attachments.filter((group) => group.from && group.attachments.length > 0);
  return (
    <div data-testid="todo-attachments">
      {(own?.attachments.length ?? 0) === 0 && <p className="mb-1.5 text-[12.5px] text-text-tertiary">Nothing attached here yet.</p>}
      {own?.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} now={now} open={attachment.id === openAttachmentId} onOpen={onOpen} />)}
      {inherited.map((group) => group.from && (
        <div key={`${group.from.relation}:${group.from.number}`} data-testid="todo-attachment-group" data-from={group.from.number}>
          <div className="mb-1 mt-2 text-[11.5px] text-text-tertiary">From T-{group.from.number}{group.from.relation === 'parent' ? ' (parent)' : ''}</div>
          {group.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} now={now} open={attachment.id === openAttachmentId} onOpen={onOpen} />)}
        </div>
      ))}
    </div>
  );
}

function AttachmentCard({ attachment, now, open, onOpen }: { attachment: TodoAttachment; now: number; open: boolean; onOpen: (attachment: TodoAttachment) => void }) {
  const meta = [attachment.note, SOURCE_WORDS[attachment.source], attachment.addedBy, relativeAge(attachment.addedAt, now)].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={() => onOpen(attachment)}
      className={cn('mb-1.5 flex w-full items-center gap-[9px] rounded-lg border bg-surface-primary px-2.5 py-[7px] text-left hover:border-border-hover', open ? 'border-interactive' : 'border-border-secondary')}
      title={attachment.target}
      data-testid="todo-attachment"
      data-attachment={attachment.id}
    >
      <span className="w-[58px] shrink-0 text-[11.5px] text-text-tertiary">{ATTACHMENT_KIND_LABEL[attachment.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-interactive-text">{attachment.label}</span>
        <span className="mt-px block text-[11px] text-text-tertiary">{meta}</span>
      </span>
    </button>
  );
}
