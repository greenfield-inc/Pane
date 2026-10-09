import { useEffect } from 'react';

interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

/** A transient "done · Undo" notice. Remount it (change its key) to restart the timer. */
export function UndoToast({ message, onUndo, onDismiss, durationMs = 6000 }: UndoToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onDismiss]);

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-[13px] text-text-primary shadow-dropdown"
    >
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        onClick={onUndo}
        className="flex-shrink-0 rounded px-1 font-medium text-interactive hover:underline focus:outline-none focus:ring-2 focus:ring-interactive"
      >
        Undo
      </button>
    </div>
  );
}
