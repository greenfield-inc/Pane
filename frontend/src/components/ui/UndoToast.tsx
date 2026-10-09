import { useEffect, useRef, useState } from 'react';

interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

/**
 * A transient "done · Undo" notice. Its timer pauses while hovered or focused.
 * Remount it (change its key) to restart the timer.
 */
export function UndoToast({ message, onUndo, onDismiss, durationMs = 6000 }: UndoToastProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingMs = useRef(durationMs);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(onDismiss, remainingMs.current);
    return () => {
      window.clearTimeout(timer);
      remainingMs.current -= Date.now() - startedAt;
    };
  }, [paused, onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
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
