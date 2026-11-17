import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Circle, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CirclePause, Clock, ExternalLink } from 'lucide-react';
import type { NotifyItem } from '../../../../../shared/types/notify';
import type { TodoActivity, TodoDetail } from '../../../../../shared/types/todos';
import { MarkdownPreview } from '../../MarkdownPreview';
import { Dropdown } from '../../ui/Dropdown';
import { selectNotifyItems, useNotifyStore } from '../../../stores/notifyStore';
import { useTodosStore } from '../../../stores/todosStore';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { cn } from '../../../utils/cn';
import { approvalCardView, deliveryLine, mergeTodoChat, todoEventIcon, type TodoEventIcon } from './chatEntries';
import { focusTodoTab, paneName } from './todoNavigation';
import { AgentAvatar, COMPACT_MARKDOWN, agoText } from './TodoPageParts';

export interface TodoChatProps {
  detail: TodoDetail;
  /** The approval shown in the split, if any: its card is ringed. */
  openApprovalId?: string;
  onOpenApproval: (id: string) => void;
}

/** The to-do's chat (round 3's, D-407): one-line events, your messages, agents' replies and approval cards. */
export function TodoChatTimeline({ detail, openApprovalId, onOpenApproval }: TodoChatProps) {
  const items = useNotifyStore(selectNotifyItems);
  const entries = useMemo(() => mergeTodoChat(detail.activity, detail.approvalIds, items), [detail.activity, detail.approvalIds, items]);
  const now = useNow();
  return (
    <div data-testid="todo-chat">
      <div className="mb-1.5 mt-3.5 flex items-center gap-2 text-[12px] text-text-tertiary" data-testid="todo-chat-divider">
        <span className="h-px flex-1 bg-border-secondary" />
        <span className="min-w-0 text-center">This to-do’s chat · messages go to {detail.chatTarget.name}, replies come back here</span>
        <span className="h-px flex-1 bg-border-secondary" />
      </div>
      {entries.map((entry) => (entry.kind === 'approval'
        ? <ApprovalChatCard key={`approval:${entry.item.id}`} item={entry.item} open={entry.item.id === openApprovalId} onOpen={() => onOpenApproval(entry.item.id)} />
        : <ActivityRow key={`activity:${entry.activity.id}`} activity={entry.activity} detail={detail} now={now} />))}
    </div>
  );
}

function ActivityRow({ activity, detail, now }: { activity: TodoActivity; detail: TodoDetail; now: number }) {
  if (activity.kind === 'event') {
    return (
      <div className="my-2 ml-0.5 flex items-start gap-2 text-[12px] text-text-tertiary" data-testid="todo-chat-event">
        <span className="flex h-[17px] items-center"><EventIcon icon={todoEventIcon(activity.body)} /></span>
        <span className="min-w-0">{activity.body} · {agoText(activity.createdAt, now)}</span>
      </div>
    );
  }
  if (activity.authorKind === 'person') {
    return (
      <div className="my-3.5 flex justify-end" data-testid="todo-chat-mine">
        <div className="max-w-[560px]">
          <div className="rounded-[14px] border border-border-secondary bg-surface-secondary px-3 py-2 text-[13px] leading-[1.6] text-text-primary">
            <MarkdownPreview content={activity.body} className={COMPACT_MARKDOWN} />
          </div>
          <div className="mt-0.5 text-right text-[11.5px] text-text-tertiary" data-testid="todo-chat-delivery" data-delivered={activity.deliveredAt !== undefined}>
            You · {relativeAge(activity.createdAt, now)} · {deliveryLine(activity)}
          </div>
        </div>
      </div>
    );
  }
  const orchestrator = detail.orchestrator?.panelId !== undefined && activity.authorTab === detail.orchestrator.panelId;
  const where = activity.authorKind === 'requester' ? 'requester'
    : activity.authorKind === 'pane' ? 'Pane'
      : orchestrator || !activity.authorTab ? 'its own Session'
        : paneName(detail.todo.assignee?.panelId === activity.authorTab ? detail.todo.assignee.paneId : undefined) ?? 'its own Session';
  const agentId = orchestrator ? detail.orchestrator?.agentId : detail.agentId;
  const chatRef = activity.chatRef;
  return (
    <div className="my-3.5 flex gap-2.5" data-testid="todo-chat-reply">
      <AgentAvatar agentId={activity.authorKind === 'agent' ? agentId : undefined} name={activity.authorName} />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[12px] text-text-tertiary"><b className="font-semibold text-text-primary">{activity.authorName}</b> · {where} · {relativeAge(activity.createdAt, now)}</div>
        <MarkdownPreview content={activity.body} className={COMPACT_MARKDOWN} />
        {chatRef && (
          <button type="button" onClick={() => focusTodoTab(detail, chatRef.panelId)} className="mt-1 inline-flex items-center gap-1 text-[12px] text-interactive-text hover:underline" data-testid="todo-chat-open-session">
            Open in the Session chat <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/** An approval linked to the to-do, as a card: amber while it waits on you; opens in the split. */
function ApprovalChatCard({ item, open, onOpen }: { item: NotifyItem; open: boolean; onOpen: () => void }) {
  const view = approvalCardView(item);
  const waiting = view.state === 'waiting';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
      className={cn(
        'my-3.5 cursor-pointer rounded-xl border bg-surface-primary px-3.5 py-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-interactive',
        waiting ? 'border-status-warning/50' : 'border-border-primary',
        open && 'ring-2 ring-interactive',
      )}
      data-testid="todo-chat-approval"
      data-item-id={item.id}
      data-state={view.state}
      data-open={open || undefined}
    >
      <div className={cn('flex items-center gap-1.5 text-[11.5px] font-semibold', waiting ? 'text-status-warning-on-tint' : 'text-text-tertiary')}>
        {waiting && <CircleHelp className="h-3.5 w-3.5 text-status-warning" strokeWidth={2.25} aria-hidden="true" />}
        <span className="min-w-0 truncate">{view.label}</span>
        {waiting && <span className="ml-auto shrink-0 font-normal text-text-tertiary">also in Approvals</span>}
      </div>
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="my-1 text-[13.5px] font-semibold text-text-primary">{view.question}</div>
          {waiting && view.context && <div className="line-clamp-2 text-text-secondary">{view.context}</div>}
          {view.answer && (
            <div className="flex items-center gap-1.5 text-text-primary">
              <CircleCheck className="h-3.5 w-3.5 shrink-0 text-status-success" strokeWidth={2.25} aria-hidden="true" />
              <span className="min-w-0">{view.answer}</span>
            </div>
          )}
        </div>
        {waiting && (open
          ? <span className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-border-primary px-2 text-[11.5px] text-text-secondary">Open</span>
          : <span className="inline-flex h-7 shrink-0 items-center rounded-[7px] bg-interactive px-2.5 text-[12.5px] font-medium text-text-on-interactive">Open ›</span>)}
      </div>
    </div>
  );
}

/** An event's icon, in one 14 px box like every status icon. None spin: an event is a moment, not a state. */
function EventIcon({ icon }: { icon: TodoEventIcon }) {
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" data-icon={icon} aria-hidden="true">
      {icon === 'done' && <CircleCheck className="h-3.5 w-3.5 text-status-success" strokeWidth={2} />}
      {icon === 'queued' && <Clock className="h-3.5 w-3.5 text-text-secondary" strokeWidth={2} />}
      {icon === 'created' && <CircleDashed className="h-3.5 w-3.5" strokeWidth={2} />}
      {icon === 'stopped' && <CirclePause className="h-3.5 w-3.5" strokeWidth={2} />}
      {/* The Working ring, still: it started, it isn't necessarily working now. */}
      {icon === 'started' && <span className="box-border h-3 w-3 rounded-full border-2 border-status-info/30 border-t-status-info" />}
      {icon === 'waiting' && <CircleHelp className="h-3.5 w-3.5 text-status-warning" strokeWidth={2} />}
      {icon === 'alert' && <CircleAlert className="h-3.5 w-3.5 text-status-error" strokeWidth={2} />}
      {icon === 'note' && <Circle className="h-2 w-2" strokeWidth={3} />}
    </span>
  );
}

/**
 * The composer: "To [orchestrator · its own Session]", the hint, and the box. On a sub-to-do the
 * chat goes to its agent, and the switch sends it to the orchestrator instead.
 */
export function TodoComposer({ detail }: { detail: TodoDetail }) {
  const act = useTodosStore((state) => state.act);
  const [text, setText] = useState('');
  const [toOrchestrator, setToOrchestrator] = useState(false);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const { todo, chatTarget, orchestrator } = detail;
  const canSwitch = chatTarget.kind === 'assignee';
  const target = canSwitch && toOrchestrator
    ? { name: orchestrator?.name ?? 'orchestrator', role: 'its own Session', agentId: orchestrator?.agentId }
    : { name: chatTarget.name, role: chatTarget.kind === 'orchestrator' ? 'its own Session' : paneName(todo.assignee?.paneId) ?? 'its tab', agentId: chatTarget.kind === 'orchestrator' ? orchestrator?.agentId : detail.agentId };
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const result = await act(canSwitch && toOrchestrator ? { kind: 'comment', number: todo.number, body, toOrchestrator: true } : { kind: 'comment', number: todo.number, body });
    setSending(false);
    if (result) setText('');
    box.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
  const chip = (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border-primary bg-surface-primary px-2 text-[12px] text-text-primary" data-testid="todo-composer-to">
      <AgentAvatar agentId={target.agentId} name={target.name} className="h-[18px] w-[18px]" />
      {target.name} · {target.role}
      {canSwitch && <ChevronDown className="h-3 w-3 text-text-tertiary" aria-hidden="true" />}
    </span>
  );
  return (
    <div className="shrink-0 border-t border-border-primary px-7 pb-3.5 pt-2.5" data-testid="todo-composer">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-text-tertiary">
          <span>To</span>
          {canSwitch ? (
            <Dropdown
              trigger={<button type="button" aria-haspopup="menu">{chip}</button>}
              items={[
                { id: 'assignee', label: `${chatTarget.name} · ${paneName(todo.assignee?.paneId) ?? 'its tab'}`, onClick: () => setToOrchestrator(false) },
                { id: 'orchestrator', label: `${orchestrator?.name ?? 'orchestrator'} · its own Session`, onClick: () => setToOrchestrator(true) },
              ]}
              selectedId={toOrchestrator ? 'orchestrator' : 'assignee'}
              position="top-left"
              width="lg"
              menuLabel="Send to"
            />
          ) : chip}
          <span>· it replies here, and sees your message in its own tab as “[From the person, via To-dos {todo.ref}]”</span>
        </div>
        <div className="flex items-end gap-2 rounded-xl border border-border-primary bg-surface-primary py-2 pl-3 pr-2 focus-within:border-interactive">
          <textarea
            ref={box}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKey}
            placeholder={`Ask about ${todo.ref}, comment, or give direction…`}
            aria-label={`Message about ${todo.ref}`}
            className="max-h-[140px] min-h-[40px] flex-1 resize-none bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-tertiary"
            data-testid="todo-composer-input"
          />
          <button type="button" onClick={() => void send()} disabled={sending} title="Send (⌘↵)" className="h-7 shrink-0 rounded-[7px] bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive disabled:opacity-60" data-testid="todo-composer-send">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
