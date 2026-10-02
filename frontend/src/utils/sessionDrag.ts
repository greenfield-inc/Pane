import { useEffect, useState } from 'react';

/**
 * Dragging a Session, the gesture that tiles it.
 *
 * The payload is a custom MIME type so a Session drag is never mistaken for a
 * tab drag, a file drop or dragged text. Which Session is in flight is also
 * tracked here, because `dataTransfer` is deliberately unreadable during
 * `dragover` — and a tile needs to know, while the cursor is still moving,
 * whether it is being offered a Session it already shows.
 */
const SESSION_DRAG_MIME = 'application/x-pane-session-id';

let draggedSessionId: string | null = null;
const listeners = new Set<() => void>();

function publish(sessionId: string | null): void {
  if (draggedSessionId === sessionId) return;
  draggedSessionId = sessionId;
  for (const listener of listeners) listener();
}

/** Mark a drag as carrying a Session. Call from the drag source's onDragStart. */
export function startSessionDrag(dataTransfer: DataTransfer, sessionId: string): void {
  dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
  // Plain text keeps the drag legible to anything outside the app.
  dataTransfer.setData('text/plain', sessionId);
  dataTransfer.effectAllowed = 'move';
  publish(sessionId);
}

/** The Session a drop is carrying, or null. Only readable in a drop handler. */
export function readDraggedSessionId(dataTransfer: DataTransfer): string | null {
  const value = dataTransfer.getData(SESSION_DRAG_MIME).trim();
  return value.length > 0 ? value : null;
}

/**
 * The Session being dragged anywhere in the window, or null when no Session
 * drag is in flight. Drop targets mount only while this is set, so nothing
 * listens for drags it cannot serve.
 *
 * The end listeners are window-level and capture-phase so a drag that is
 * cancelled, or dropped somewhere unrelated, still clears the flag.
 */
export function useDraggedSessionId(): string | null {
  const [sessionId, setSessionId] = useState(draggedSessionId);

  useEffect(() => {
    const sync = () => setSessionId(draggedSessionId);
    listeners.add(sync);
    const end = () => publish(null);
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', end, true);
    sync();
    return () => {
      listeners.delete(sync);
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('drop', end, true);
    };
  }, []);

  return sessionId;
}
