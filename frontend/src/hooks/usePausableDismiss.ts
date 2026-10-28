import { useEffect, useRef, useState, type FocusEvent } from 'react';

/**
 * Calls `onDismiss` after `durationMs`, paused while the toast is hovered or
 * holds focus. Spread the returned handlers on the toast's root element.
 */
export function usePausableDismiss(onDismiss: () => void, durationMs: number) {
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

  return {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: (event: FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); },
  };
}
