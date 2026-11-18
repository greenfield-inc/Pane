import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, ChevronDown, Paperclip } from 'lucide-react';
import type { TodoAction, TodoDetail } from '../../../../../../shared/types/todos';
import { Dropdown } from '../../../ui/Dropdown';
import { cn } from '../../../../utils/cn';
import { paneName } from '../todoNavigation';
import { AgentAvatar } from '../TodoPageParts';
import { AttachedChips } from './ThreadCards';
import { commentWithFiles, eventFiles } from './threadInputs';
import { sendThreadComment, useComposerAttach, useComposerFileInbox, useFileDropZone } from './useThreadSend';
import { useTodosStore } from '../../../../stores/todosStore';
import { HeldHint, isReminderOnly } from '../TodoSnoozed';

const ICON_BUTTON = 'inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-50';

/**
 * The composer, always at the bottom: "Leave a comment…", 📎 (or paste or drop a file), and send
 * (↑, ⌘↵). Comments go to the orchestrator; on a sub-to-do the "To" switch picks its agent or the
 * orchestrator, as before. An attached file becomes a to-do attachment and the comment names it.
 */
export interface ThreadComposerProps {
  detail: TodoDetail;
  /**
   * The phone's layout (P7): full width, 16 px text so Safari doesn't zoom, clear of the home
   * indicator, and Send keeps the keyboard up.
   */
  phone?: boolean;
}

export function ThreadComposer({ detail, phone = false }: ThreadComposerProps) {
  const { todo, chatTarget, orchestrator } = detail;
  const attach = useComposerAttach(todo.number);
  const [text, setText] = useState('');
  const [toOrchestrator, setToOrchestrator] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const canSwitch = chatTarget.kind === 'assignee';
  const ready = text.trim().length > 0 || attach.files.length > 0;

  const act = useTodosStore((state) => state.act);
  const send = async (): Promise<boolean> => {
    if (!ready || sending) return false;
    setSending(true);
    setError(null);
    const body = commentWithFiles(text, attach.files);
    const action: TodoAction = canSwitch && toOrchestrator
      ? { kind: 'comment', number: todo.number, body, toOrchestrator: true }
      : { kind: 'comment', number: todo.number, body };
    const result = await sendThreadComment(action);
    setSending(false);
    if (result.ok) {
      setText('');
      attach.clear();
    } else {
      setError(result.error ?? 'The comment was not sent.');
    }
    box.current?.focus();
    return result.ok;
  };
  // Snoozed (round 9): comments are held until it wakes; "Wake now and send" sends this one, then wakes it,
  // so it goes inside the wake message at once.
  const wakeAndSend = async () => {
    if (ready && !await send()) return;
    await act({ kind: 'wake', number: todo.number });
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
  const addFiles = attach.addFiles;
  const drop = useFileDropZone((files) => void addFiles(files), attach.available);
  useComposerFileInbox(todo.number, (files) => void addFiles(files));

  const assigneeLabel = `${chatTarget.name} · ${paneName(todo.assignee?.paneId) ?? 'its tab'}`;
  const orchestratorLabel = `${orchestrator?.name ?? 'orchestrator'} · its own Session`;
  const target = canSwitch && !toOrchestrator
    ? { name: chatTarget.name, agentId: detail.agentId }
    : { name: orchestrator?.name ?? 'orchestrator', agentId: orchestrator?.agentId };
  return (
    <div className={phone ? 'shrink-0 border-t border-border-primary bg-bg-primary px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2' : 'shrink-0 px-7 pb-3.5 pt-2.5'} data-testid="todo-composer">
      <div
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
        className={cn('mx-auto rounded-[10px] border', phone ? 'max-w-none' : 'max-w-[760px]', 'bg-surface-primary px-3 pb-1.5 pt-2.5 focus-within:border-border-hover', drop.dragging ? 'border-interactive' : 'border-border-primary')}
        data-dragging={drop.dragging || undefined}
      >
        {todo.snooze && <HeldHint snooze={todo.snooze} onWakeAndSend={() => void wakeAndSend()} />}
        <AttachedChips files={attach.files} onRemove={attach.remove} />
        <textarea
          ref={box}
          rows={phone ? 1 : 2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={todo.snooze ? 'Comment… held until it wakes' : 'Leave a comment…'}
          aria-label={`Comment on ${todo.ref}`}
          className={cn('w-full resize-none bg-transparent p-0 leading-normal text-text-primary outline-none placeholder:text-text-tertiary', phone ? 'max-h-[120px] min-h-[24px] text-[16px]' : 'max-h-[160px] min-h-[40px] text-[13px]')}
          data-testid="todo-composer-input"
        />
        {error && <p className="mb-1 text-[12px] text-status-error" role="alert" data-testid="todo-composer-error">{error}</p>}
        <div className="flex items-center gap-1.5 text-[11.5px] text-text-tertiary">
          {canSwitch ? (
            <span className="inline-flex items-center gap-1.5">
              To
              <Dropdown
                trigger={(
                  <button type="button" aria-haspopup="menu" className="inline-flex h-[22px] items-center gap-[5px] rounded-md border border-border-primary px-[7px] text-text-secondary outline-none hover:border-border-hover focus-visible:ring-2 focus-visible:ring-interactive" data-testid="todo-composer-to">
                    <AgentAvatar agentId={target.agentId} name={target.name} className="h-3.5 w-3.5 rounded text-[8.5px] [&_svg]:h-2.5 [&_svg]:w-2.5" />
                    {target.name}
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
                items={[
                  { id: 'assignee', label: assigneeLabel, onClick: () => setToOrchestrator(false) },
                  { id: 'orchestrator', label: orchestratorLabel, onClick: () => setToOrchestrator(true) },
                ]}
                selectedId={toOrchestrator ? 'orchestrator' : 'assignee'}
                position="top-left"
                width="lg"
                menuLabel="Send to"
              />
            </span>
          ) : <span data-testid="todo-composer-to">{isReminderOnly(detail) ? 'Comments stay here: no agent works on this reminder' : 'Comments go to the orchestrator'}</span>}
          <span className="flex-1" />
          {attach.available && <button type="button" onClick={() => void attach.pick()} disabled={attach.busy} aria-label="Attach a file" title="Attach a file (or paste or drop one)" className={cn(ICON_BUTTON, 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary')} data-testid="todo-composer-attach">
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          </button>}
          {/* On a phone the box keeps focus through the tap, so the keyboard stays up. */}
          <button type="button" onClick={() => void send()} onPointerDown={phone ? (event) => event.preventDefault() : undefined} disabled={sending} aria-label="Send (⌘↵)" title="Send (⌘↵)" className={cn(ICON_BUTTON, ready ? 'bg-interactive text-text-on-interactive hover:bg-interactive-hover' : 'text-text-secondary hover:bg-surface-hover')} data-testid="todo-composer-send">
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
