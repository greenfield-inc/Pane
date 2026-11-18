import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { todoRef, type TodoListRow } from '../../../../shared/types/todos';
import { cn } from '../../utils/cn';
import type { TodoRowActionKind } from './todoList';
import { TODOS_BUTTON } from './todoStyles';

export interface TodoConfirmRequest {
  kind: TodoRowActionKind;
  row: TodoListRow;
  /** LOCAL_MACHINE_ID, or the saved machine the action runs on. */
  machineId: string;
  /** Where to open: under the button or row that asked. */
  anchor: DOMRect;
}

interface TodoConfirmProps {
  request: TodoConfirmRequest;
  onCancel: () => void;
  onConfirm: () => void;
}

const WIDTH = 340;

interface ConfirmCopy {
  title: string;
  body: string;
  confirm: string;
}

function copyFor(kind: TodoRowActionKind, row: TodoListRow): ConfirmCopy {
  const ref = todoRef(row.todo.number);
  switch (kind) {
    case 'stop':
      return { title: `Stop ${ref}?`, body: `Pane tells ${ref}’s orchestrator to stop work on it: its workers finish the step they are on, then wait. No reminders until you resume.`, confirm: 'Stop' };
    case 'resume':
      return { title: `Resume ${ref}?`, body: `Pane tells ${ref}’s orchestrator to pick it up where it stopped. Reminders come back on: after 10 quiet minutes Pane reminds the orchestrator, and after 40 it asks you.`, confirm: 'Resume' };
    case 'start':
      return { title: `Start ${ref}?`, body: 'Pane makes its Session and starts an orchestrator on it, as soon as machine load allows. Reminders are on from the start.', confirm: 'Start' };
    case 'wake':
      return { title: `Wake ${ref} now?`, body: row.todo.snooze?.action === 'remind' || !row.todo.sessionId
        ? `Pane ends the snooze now and raises its reminder card, as if its time had come.`
        : `Pane ends the snooze now: it sets ${ref} back to In progress and types the wake-up note to its orchestrator, with any held comments.`, confirm: 'Wake now' };
    case 'start-anyway':
      return { title: `Start ${ref} anyway?`, body: `${row.machine} is busy, so Pane is holding new agents. Starting anyway adds one more agent now; Pane won’t pause this to-do for load.`, confirm: 'Start anyway' };
  }
}

/**
 * The confirmation S, R and Start anyway ask for (D-393): a small card under the row, Cancel or
 * the action, which has focus. Esc or a click elsewhere cancels.
 */
export function TodoConfirm({ request, onCancel, onConfirm }: TodoConfirmProps) {
  const ref = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [top, setTop] = useState(request.anchor.bottom + 6);
  const copy = copyFor(request.kind, request.row);
  const right = Math.max(12, window.innerWidth - request.anchor.right);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    // Opens above the row when there is no room below it.
    const below = request.anchor.bottom + 6;
    setTop(below + height > window.innerHeight - 12 ? Math.max(12, request.anchor.top - height - 6) : below);
    confirmRef.current?.focus({ preventScroll: true });
  }, [request.anchor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onCancel]);

  const danger = request.kind === 'stop';
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-labelledby="todo-confirm-title"
      aria-describedby="todo-confirm-body"
      data-todos-confirm
      data-testid="todo-confirm"
      className="fixed z-50 rounded-xl border border-border-primary bg-surface-primary px-3.5 py-3 text-[12.5px] text-text-primary shadow-modal"
      style={{ top, right, width: WIDTH }}
    >
      <h3 id="todo-confirm-title" className="mb-1.5 text-[13.5px] font-semibold">{copy.title}</h3>
      <p id="todo-confirm-body" className="leading-[1.45] text-text-secondary">{copy.body}</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <button type="button" className={TODOS_BUTTON} onClick={onCancel}>Cancel</button>
        <button
          ref={confirmRef}
          type="button"
          data-testid="todo-confirm-action"
          onClick={onConfirm}
          className={cn(TODOS_BUTTON, 'border-transparent font-medium', danger ? 'bg-status-error text-text-on-status-error hover:bg-status-error-hover' : 'bg-interactive text-text-on-interactive hover:bg-interactive-hover')}
        >
          {danger
            ? <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
            : <Play className="h-2.5 w-2.5 fill-current" aria-hidden="true" />}
          {copy.confirm}
        </button>
      </div>
    </div>
  );
}
