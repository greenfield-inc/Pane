import { usePausableDismiss } from '../../hooks/usePausableDismiss';
import { cn } from '../../utils/cn';

interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
  /** Places it elsewhere than the window's bottom centre. */
  className?: string;
}

/**
 * A transient "done · Undo" notice. Its timer pauses while hovered or focused.
 * Remount it (change its key) to restart the timer.
 */
export function UndoToast({ message, onUndo, onDismiss, durationMs = 6000, className }: UndoToastProps) {
  const pauseHandlers = usePausableDismiss(onDismiss, durationMs);

  return (
    <div
      role="status"
      {...pauseHandlers}
      className={cn('fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-[13px] text-text-primary shadow-dropdown', className)}
    >
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        onClick={onUndo}
        className="min-h-11 flex-shrink-0 rounded px-1 font-medium md:min-h-0 text-interactive hover:underline focus:outline-none focus:ring-2 focus:ring-interactive"
      >
        Undo
      </button>
    </div>
  );
}
