import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Bell, ChevronDown, ChevronRight, ChevronUp, Circle, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CirclePause, Clock, ExternalLink, File, GripVertical, Moon, Paperclip, X } from 'lucide-react';
import type { TodoActivity, TodoDetail } from '../../../../../../shared/types/todos';
import { commentAttachments, type TodoThreadApproval, type TodoThreadComment, type TodoThreadDelivery, type TodoThreadFile, type TodoThreadFold, type TodoThreadReply, type TodoThreadRun } from '../../../../../../shared/todoThread';
import { MarkdownPreview } from '../../../MarkdownPreview';
import { relativeAge } from '../../../notify/notifyFormat';
import { cn } from '../../../../utils/cn';
import { TodoStatusIcon } from '../../TodoStatusIcon';
import { todoEventIcon, type TodoEventIcon } from '../chatEntries';
import { focusTodoTab } from '../todoNavigation';
import { AgentAvatar, COMPACT_MARKDOWN } from '../TodoPageParts';
import { heldText } from '../TodoSnoozed';
import { attachedLabel, attachmentAt, attachmentNamed, commentWithFiles, eventFiles } from './threadInputs';
import { TodoImageThumb } from './TodoImage';
import { sendThreadComment, useComposerAttach, useFileDropZone } from './useThreadSend';

/** What every card reads from the page. */
export interface ThreadContext {
  detail: TodoDetail;
  now: number;
  /** The approval shown over the split, if any: its card is ringed. */
  openApprovalId?: string;
  onOpenApproval?: (id: string) => void;
  onOpenAttachment?: (attachmentId: number) => void;
}

const CARD = 'my-2 overflow-hidden rounded-[10px] border border-border-primary bg-surface-primary';
const ICON_BUTTON = 'inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-text-tertiary outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-50';

/** The agent behind a tab, for its avatar: the orchestrator's, the assignee's, or a sub-to-do's. */
function agentIdForTab(detail: TodoDetail, tab: string | undefined): string | undefined {
  if (!tab) return undefined;
  if (detail.orchestrator?.panelId === tab) return detail.orchestrator.agentId;
  if (detail.todo.assignee?.panelId === tab) return detail.agentId;
  return detail.subTodos.find((sub) => sub.todo.assignee?.panelId === tab)?.agentId;
}

function Avatar({ name, agentId, small = false }: { name: string; agentId?: string; small?: boolean }) {
  return <AgentAvatar agentId={agentId} name={name} className={small ? 'h-3.5 w-3.5 rounded text-[8.5px] [&_svg]:h-2.5 [&_svg]:w-2.5' : 'h-[18px] w-[18px] rounded-[5px] text-[10px] [&_svg]:h-3 [&_svg]:w-3'} />;
}

/** An event's icon, in one 14 px box like every status icon. None spin: an event is a moment, not a state. */
function EventIcon({ icon }: { icon: TodoEventIcon }) {
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" data-icon={icon} aria-hidden="true">
      {icon === 'done' && <CircleCheck className="h-3 w-3 text-status-success" strokeWidth={2} />}
      {icon === 'queued' && <Clock className="h-3 w-3" strokeWidth={2} />}
      {icon === 'created' && <CircleDashed className="h-3 w-3" strokeWidth={2} />}
      {icon === 'stopped' && <CirclePause className="h-3 w-3" strokeWidth={2} />}
      {icon === 'started' && <span className="box-border h-2.5 w-2.5 rounded-full border-2 border-status-info/30 border-t-status-info" />}
      {icon === 'waiting' && <CircleHelp className="h-3 w-3 text-status-warning" strokeWidth={2} />}
      {icon === 'alert' && <CircleAlert className="h-3 w-3 text-status-error" strokeWidth={2} />}
      {icon === 'note' && <Circle className="h-1.5 w-1.5" strokeWidth={3} />}
      {icon === 'attached' && <Paperclip className="h-3 w-3" strokeWidth={2} />}
      {icon === 'snoozed' && <Moon className="h-3 w-3 text-status-snoozed" strokeWidth={2} />}
      {icon === 'reminder' && <Bell className="h-3 w-3 text-status-warning" strokeWidth={2} />}
    </span>
  );
}

/** An event's words: the author's name set off, and an attachment it names as a link. */
function EventWords({ event, ctx }: { event: TodoActivity; ctx: ThreadContext }) {
  const body = event.body;
  const label = attachedLabel(body);
  const attachment = label ? attachmentNamed(ctx.detail, label) : undefined;
  const lead = event.authorKind !== 'pane' && body.startsWith(`${event.authorName} `) ? event.authorName : '';
  let rest: ReactNode = body.slice(lead.length);
  const onOpen = ctx.onOpenAttachment;
  if (label && attachment && onOpen) {
    const text = body.slice(lead.length);
    const at = text.lastIndexOf(label);
    rest = (
      <>
        {text.slice(0, at)}
        <button type="button" onClick={() => onOpen(attachment.id)} className="rounded text-interactive-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-interactive" data-testid="todo-thread-attachment-link" data-attachment={attachment.id}>{label}</button>
        {text.slice(at + label.length)}
      </>
    );
  }
  return <span className="min-w-0">{lead && <span className="text-text-secondary">{lead}</span>}{rest}</span>;
}

/**
 * An event's line. One that attached an image (`attachedImage`, its label) reads "planner attached
 * image" with the image under it, so a screenshot an agent attached shows in the thread.
 */
export function EventLine({ event, ctx, attachedImage }: { event: TodoActivity; ctx: ThreadContext; attachedImage?: string }) {
  if (attachedImage !== undefined) return <ImageEventLine event={event} ctx={ctx} label={attachedImage} />;
  return (
    <div className="flex min-h-[26px] items-center gap-2 px-0.5 text-[12.5px] text-text-tertiary" data-testid="todo-thread-event" data-activity={event.id}>
      <EventIcon icon={todoEventIcon(event.body)} />
      <EventWords event={event} ctx={ctx} />
      <span className="shrink-0">· {relativeAge(event.createdAt, ctx.now)}</span>
    </div>
  );
}

function ImageEventLine({ event, ctx, label }: { event: TodoActivity; ctx: ThreadContext; label: string }) {
  const attachment = attachmentNamed(ctx.detail, label);
  const lead = event.authorKind === 'person' ? 'You' : event.authorName;
  const onOpen = ctx.onOpenAttachment;
  return (
    <div className="py-0.5" data-testid="todo-thread-event" data-activity={event.id} data-image={label}>
      <div className="flex min-h-[26px] items-center gap-2 px-0.5 text-[12.5px] text-text-tertiary">
        <EventIcon icon="attached" />
        <span className="min-w-0 truncate"><span className="text-text-secondary">{lead}</span> attached image</span>
        <span className="shrink-0">· {relativeAge(event.createdAt, ctx.now)}</span>
      </div>
      {attachment && (
        <div className="pb-1 pl-[22px]">
          <TodoImageThumb path={attachment.target} label={attachment.label} onOpen={onOpen ? () => onOpen(attachment.id) : undefined} />
        </div>
      )}
    </div>
  );
}

const FOLD_BUTTON = 'flex h-[26px] max-w-full items-center gap-2 rounded px-0.5 text-[12.5px] text-text-tertiary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-interactive';

/** "Show 3 events: …", and with them shown, "Hide events" after them. */
export function EventFold({ fold, open, onToggle, ctx }: { fold: TodoThreadFold; open: boolean; onToggle: () => void; ctx: ThreadContext }) {
  if (!open) {
    return (
      <button type="button" onClick={onToggle} aria-expanded={false} className={FOLD_BUTTON} data-testid="todo-thread-fold">
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">Show {fold.events.length} events: {fold.summary}</span>
      </button>
    );
  }
  return (
    <div data-testid="todo-thread-fold-open">
      {fold.events.map((event) => <EventLine key={event.id} event={event} ctx={ctx} />)}
      <button type="button" onClick={onToggle} aria-expanded className={FOLD_BUTTON} data-testid="todo-thread-fold">
        <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
        Hide events
      </button>
    </div>
  );
}

const RUN_STATE_LABEL = { working: 'Working', waiting: 'Waiting on you', finished: 'Finished' } as const;

/** A run's state mark, in one 14 px box: the Working spinner (the status icon's, same period), ?, or the grip. */
function RunStateIcon({ state }: { state: TodoThreadRun['state'] }) {
  if (state === 'working') return <TodoStatusIcon status="working" />;
  if (state === 'waiting') return <TodoStatusIcon status="waiting" />;
  return <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-tertiary" aria-hidden="true"><GripVertical className="h-3 w-3" strokeWidth={2} /></span>;
}

/** One agent tab's turn of work: header, state line, its messages and steps when opened, replies, and a reply box. */
export function RunCard({ run, open, onToggle, ctx }: { run: TodoThreadRun; open: boolean; onToggle: () => void; ctx: ThreadContext }) {
  const agentId = agentIdForTab(ctx.detail, run.authorTab);
  const chatRef = run.chatRef;
  const waitingId = run.waitingApprovalId;
  const onOpenApproval = ctx.onOpenApproval;
  return (
    <div className={CARD} data-testid="todo-thread-run" data-state={run.state} data-tab={run.authorTab} data-open={open || undefined}>
      <div className="flex items-center gap-2 px-3 py-[9px] text-[12.5px] text-text-tertiary">
        <Avatar name={run.authorName} agentId={agentId} />
        <b className="font-semibold text-text-primary">{run.authorName}</b>
        {run.startedBy && <span className="min-w-0 truncate">started by {run.startedBy}</span>}
        <span className="flex-1" />
        <span className="shrink-0">{relativeAge(run.startedAt, ctx.now)}</span>
      </div>
      <div className="flex items-center border-t border-border-secondary text-[12.5px]">
        {run.state === 'waiting' && waitingId && onOpenApproval ? (
          <button type="button" onClick={() => onOpenApproval(waitingId)} className="ml-3 inline-flex shrink-0 items-center gap-2 rounded font-medium text-text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-interactive" data-testid="todo-thread-run-waiting">
            <RunStateIcon state={run.state} />
            {RUN_STATE_LABEL[run.state]}
          </button>
        ) : (
          <span className="ml-3 inline-flex shrink-0 items-center gap-2 font-medium text-text-primary" data-testid="todo-thread-run-state">
            <RunStateIcon state={run.state} />
            {RUN_STATE_LABEL[run.state]}
          </span>
        )}
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${run.authorName}’s messages`} className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 pr-3 text-left outline-none hover:bg-surface-hover focus-visible:bg-surface-hover" data-testid="todo-thread-run-toggle">
          <span className="min-w-0 flex-1 truncate text-text-tertiary">{run.summary}</span>
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-text-tertiary" aria-hidden="true" /> : <ChevronRight className="h-3 w-3 shrink-0 text-text-tertiary" aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-border-secondary pb-2.5 pl-[38px] pr-3 pt-1 text-[13px] leading-[1.55]" data-testid="todo-thread-run-body">
          <RunSteps steps={run.steps} ctx={ctx} />
          {chatRef && (
            <button type="button" onClick={() => focusTodoTab(ctx.detail, chatRef.panelId)} className="mt-1 inline-flex items-center gap-1 rounded text-[13px] text-interactive-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-interactive" data-testid="todo-thread-open-session">
              <ExternalLink className="h-3 w-3" aria-hidden="true" /> Open in the Session chat
            </button>
          )}
        </div>
      )}
      <Replies replies={run.replies} ctx={ctx} />
      <ReplyBox ctx={ctx} replyTo={run.replyTarget} placeholder={`Reply to ${run.authorName}…`} />
    </div>
  );
}

/** A run's messages as Markdown, and its events as steps between them. */
function RunSteps({ steps, ctx }: { steps: readonly TodoActivity[]; ctx: ThreadContext }) {
  const blocks: ReactNode[] = [];
  let pending: TodoActivity[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    blocks.push(
      <ul key={`steps:${pending[0].id}`} className="my-1.5 list-none p-0 text-[12.5px] text-text-tertiary" data-testid="todo-thread-steps">
        {pending.map((step) => (
          <li key={step.id} className="flex min-h-[22px] items-center gap-[7px]"><EventIcon icon={todoEventIcon(step.body)} /><EventWords event={step} ctx={ctx} /></li>
        ))}
      </ul>,
    );
    pending = [];
  };
  for (const step of steps) {
    if (step.kind === 'event') {
      pending.push(step);
      continue;
    }
    flush();
    blocks.push(<div key={step.id} className="my-2" data-testid="todo-thread-run-message"><MarkdownPreview content={step.body} className={COMPACT_MARKDOWN} /></div>);
  }
  flush();
  return <>{blocks}</>;
}

/** "Delivered to planner", or why not yet. */
function deliveryText(delivery: TodoThreadDelivery): string {
  if (delivery.delivered) return delivery.toName ? `Delivered to ${delivery.toName}` : 'Delivered';
  return 'Waiting for the agent to finish its turn';
}

/** A comment's delivery; while the to-do is snoozed an undelivered one is held for the wake message (round 9). */
function DeliveryLine({ delivery, ctx, className }: { delivery: TodoThreadDelivery; ctx: ThreadContext; className?: string }) {
  const held = !delivery.delivered && ctx.detail.todo.snooze !== undefined;
  return (
    <div className={cn('text-[11.5px]', held ? 'text-status-snoozed-on-tint' : 'text-text-tertiary', className)} data-testid="todo-thread-delivery" data-delivered={delivery.delivered} data-held={held || undefined}>
      {held ? heldText(ctx.detail) : deliveryText(delivery)}
    </div>
  );
}

function authorLabel(activity: TodoActivity): string {
  return activity.authorKind === 'person' ? 'You' : activity.authorName;
}

/** The replies under a card: the person's, and agents' threaded answers. */
function Replies({ replies, ctx }: { replies: readonly TodoThreadReply[]; ctx: ThreadContext }) {
  return (
    <>
      {replies.map((reply) => (
        <div key={reply.activity.id} className="border-t border-border-secondary px-3 py-2" data-testid="todo-thread-reply" data-activity={reply.activity.id} data-author={reply.activity.authorKind}>
          <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary">
            <Avatar name={authorLabel(reply.activity)} agentId={reply.activity.authorKind === 'agent' ? agentIdForTab(ctx.detail, reply.activity.authorTab) : undefined} small />
            <b className="font-semibold text-text-primary">{authorLabel(reply.activity)}</b>
            {relativeAge(reply.activity.createdAt, ctx.now)}
          </div>
          <MessageBody body={reply.activity.body} ctx={ctx} className="pl-[22px] pt-[3px] text-[13.5px]" markdownClassName={COMPACT_MARKDOWN} />
          {reply.delivery && <DeliveryLine delivery={reply.delivery} ctx={ctx} className="pl-[22px] pt-0.5" />}
        </div>
      ))}
    </>
  );
}

/**
 * A comment's or reply's words, then what its Attached lines name (round 8, T-5): images as
 * thumbnails and other files as chips that open their attachment tab. The lines themselves stay
 * in the stored body (agents read the paths) but aren't shown as text.
 */
function MessageBody({ body, ctx, className, markdownClassName }: { body: string; ctx: ThreadContext; className: string; markdownClassName: string }) {
  const parts = commentAttachments(body);
  return (
    <div className={className}>
      {parts.text && <MarkdownPreview content={parts.text} className={markdownClassName} />}
      {parts.images.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', parts.text && 'mt-2')} data-testid="todo-thread-images">
          {parts.images.map((file) => <ImageOf key={file.path} file={file} ctx={ctx} />)}
        </div>
      )}
      {parts.files.length > 0 && (
        <div className={cn('flex flex-wrap gap-1.5', (parts.text || parts.images.length > 0) && 'mt-2')}>
          {parts.files.map((file) => <FileChip key={file.path} file={file} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

function ImageOf({ file, ctx }: { file: TodoThreadFile; ctx: ThreadContext }) {
  const attachment = attachmentAt(ctx.detail, file.path);
  const onOpen = ctx.onOpenAttachment;
  return <TodoImageThumb path={file.path} label={file.name} onOpen={attachment && onOpen ? () => onOpen(attachment.id) : undefined} />;
}

const FILE_CHIP = 'inline-flex h-[22px] max-w-full items-center gap-[5px] rounded-md bg-surface-tertiary px-[7px] text-[11.5px] text-text-secondary';

/** A file a message names: opens its attachment tab while it is still attached. */
function FileChip({ file, ctx }: { file: TodoThreadFile; ctx: ThreadContext }) {
  const attachment = attachmentAt(ctx.detail, file.path);
  const onOpen = ctx.onOpenAttachment;
  const inner = <><File className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{file.name}</span></>;
  if (!attachment || !onOpen) return <span className={FILE_CHIP} title={file.path} data-testid="todo-thread-file">{inner}</span>;
  return (
    <button type="button" onClick={() => onOpen(attachment.id)} title={file.path} className={cn(FILE_CHIP, 'outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-interactive')} data-testid="todo-thread-file" data-attachment={attachment.id}>
      {inner}
    </button>
  );
}

/** Your comment or the requester's, with its replies and "Leave a reply…". */
export function CommentCard({ comment, ctx }: { comment: TodoThreadComment; ctx: ThreadContext }) {
  const { activity } = comment;
  return (
    <div className={CARD} data-testid="todo-thread-comment" data-activity={activity.id} data-author={activity.authorKind}>
      <div className="flex items-center gap-2 px-3 pt-2.5 text-[12.5px] text-text-tertiary">
        <Avatar name={authorLabel(activity)} />
        <b className="font-semibold text-text-primary">{authorLabel(activity)}</b>
        {activity.authorKind === 'requester' && <span>requester</span>}
        {relativeAge(activity.createdAt, ctx.now)}
      </div>
      <MessageBody body={activity.body} ctx={ctx} className="pb-2.5 pl-[38px] pr-3 pt-1 text-[13.5px] leading-[1.55]" markdownClassName={cn(COMPACT_MARKDOWN, '!text-[13.5px]')} />
      {comment.delivery && <DeliveryLine delivery={comment.delivery} ctx={ctx} className="-mt-1.5 pb-2 pl-[38px] pr-3" />}
      <Replies replies={comment.replies} ctx={ctx} />
      <ReplyBox ctx={ctx} replyTo={comment.replyTarget} placeholder="Leave a reply…" />
    </div>
  );
}

/** An approval: amber with Answer while it waits, then "Q-11 answered: …". */
export function ApprovalCard({ approval, ctx }: { approval: TodoThreadApproval; ctx: ThreadContext }) {
  const waiting = approval.state === 'waiting';
  const open = ctx.openApprovalId === approval.id;
  const onOpenApproval = ctx.onOpenApproval;
  const onOpen = onOpenApproval ? () => onOpenApproval(approval.id) : undefined;
  const head = approval.qn ?? 'Approval';
  const meta = waiting
    ? [approval.qn, `${approval.askerName ?? 'an agent'} asks you`, relativeAge(approval.createdAt, ctx.now), approval.optionCount ? `${approval.optionCount} options` : ''].filter(Boolean).join(' · ')
    : [approval.state === 'answered' ? 'by you' : '', relativeAge(approval.resolvedAt ?? approval.createdAt, ctx.now)].filter(Boolean).join(' · ');
  const title = waiting ? approval.question
    : approval.state === 'answered' ? `${head} answered: ${approval.answer ?? 'answered'}`
      : `${head} closed: ${approval.question}`;
  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(); } } : undefined}
      className={cn(
        'my-2 flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-interactive',
        onOpen && 'cursor-pointer',
        waiting ? 'border-status-warning/50 bg-status-warning/5 hover:border-status-warning' : 'border-border-primary bg-surface-primary',
        open && 'ring-2 ring-status-warning/45',
      )}
      data-testid="todo-thread-approval"
      data-item-id={approval.id}
      data-state={approval.state}
      data-open={open || undefined}
    >
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        {waiting ? <CircleHelp className="h-3.5 w-3.5 text-status-warning" strokeWidth={2} /> : <CircleCheck className={cn('h-3.5 w-3.5', approval.state === 'answered' ? 'text-status-success' : 'text-text-tertiary')} strokeWidth={2} />}
      </span>
      <div className="min-w-0 flex-1">
        <b className="block text-[13.5px] font-semibold text-text-primary">{title}</b>
        <span className="text-[12px] text-text-tertiary">{meta}</span>
      </div>
      {waiting && onOpen && (
        <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(); }} className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-[7px] bg-interactive px-2.5 text-[12.5px] font-medium text-text-on-interactive outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-interactive focus-visible:ring-offset-1" data-testid="todo-thread-answer">
          Answer <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Attached files waiting to be named in the next comment or reply. */
export function AttachedChips({ files, onRemove }: { files: readonly { name: string; path: string }[]; onRemove: (path: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <span key={file.path} title={file.path} className="inline-flex h-[22px] items-center gap-[5px] rounded-md bg-surface-tertiary pl-[7px] pr-0.5 text-[11.5px] text-text-secondary" data-testid="todo-composer-attached">
          <Paperclip className="h-3 w-3" aria-hidden="true" />
          {file.name}
          <button type="button" onClick={() => onRemove(file.path)} aria-label={`Don’t name ${file.name} in the comment`} className="inline-flex h-[18px] w-[18px] items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary">
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** "Leave a reply…" under a card: sends `{ kind: 'comment', replyTo }`, and shows the backend's words if it's refused. */
function ReplyBox({ ctx, replyTo, placeholder }: { ctx: ThreadContext; replyTo: number; placeholder: string }) {
  const number = ctx.detail.todo.number;
  const attach = useComposerAttach(number);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // A file dropped on the reply goes with the reply, not with the next comment in the main composer.
  const drop = useFileDropZone((files) => void attach.addFiles(files), attach.available);
  const ready = text.trim().length > 0 || attach.files.length > 0;
  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    const result = await sendThreadComment({ kind: 'comment', number, body: commentWithFiles(text, attach.files), replyTo });
    setSending(false);
    if (result.ok) {
      setText('');
      attach.clear();
    } else {
      setError(result.error ?? 'The reply was not sent.');
    }
    box.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = eventFiles(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void attach.addFiles(files);
  };
  return (
    <div
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={cn('border-t', drop.dragging ? 'border-interactive bg-interactive/5' : 'border-border-secondary')}
      data-testid="todo-thread-reply-box"
      data-reply-to={replyTo}
      data-dragging={drop.dragging || undefined}
    >
      {attach.files.length > 0 && <div className="px-3 pt-2"><AttachedChips files={attach.files} onRemove={attach.remove} /></div>}
      <div className="flex items-center gap-2 py-[7px] pl-3 pr-2.5">
        <Avatar name="You" small />
        <textarea
          ref={box}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label={placeholder.replace('…', '')}
          className="max-h-[120px] min-h-[20px] flex-1 resize-none bg-transparent p-0 text-[13px] leading-normal text-text-primary outline-none placeholder:text-text-tertiary [field-sizing:content]"
          data-testid="todo-thread-reply-input"
        />
        {attach.available && <button type="button" onClick={() => void attach.pick()} disabled={attach.busy} aria-label="Attach a file" title="Attach a file" className={ICON_BUTTON} data-testid="todo-thread-reply-attach">
          <Paperclip className="h-3 w-3" aria-hidden="true" />
        </button>}
        <button type="button" onClick={() => void send()} disabled={sending} aria-label="Send reply (⌘↵)" title="Send reply (⌘↵)" className={cn(ICON_BUTTON, ready ? 'bg-interactive text-text-on-interactive hover:bg-interactive-hover hover:text-text-on-interactive' : 'text-text-secondary')} data-testid="todo-thread-reply-send">
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {error && <p className="px-3 pb-2 pl-[34px] text-[12px] text-status-error" role="alert" data-testid="todo-thread-reply-error">{error}</p>}
    </div>
  );
}
