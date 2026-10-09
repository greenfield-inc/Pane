import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './notesDialog.css';

const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** Excalidraw portals its own dialogs to body, outside a native modal's top layer. */
export default function NotesDialog({ label, children, onDismiss }: {
  label: string; children: ReactNode; onDismiss?: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== overlay.current && !element.inert);
    for (const element of siblings) element.inert = true;
    content.current?.focus();
    return () => {
      for (const element of siblings) element.inert = false;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return createPortal(<div ref={overlay} className="pane-notes-dialog fixed inset-0 z-modal bg-modal-overlay p-4">
    <div ref={content} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      className="flex h-full flex-col rounded-lg border border-border-primary bg-bg-primary text-text-primary shadow-xl outline-none"
      onKeyDown={event => {
        // Nested Excalidraw portals manage their own focus and Escape.
        if (!(event.target instanceof Node) || !content.current?.contains(event.target)) return;
        if (event.key === 'Escape' && onDismiss && !event.defaultPrevented) { event.stopPropagation(); onDismiss(); }
        if (event.key !== 'Tab' || event.defaultPrevented) return;
        const elements = Array.from(content.current.querySelectorAll<HTMLElement>(focusable)).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === content.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}>
      {children}
    </div>
  </div>, document.body);
}
