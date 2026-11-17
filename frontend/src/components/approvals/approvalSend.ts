/**
 * ⌘↩ (the send-approval command) sends from anywhere in an approval: each open Decide tab says
 * how to send it, and the command finds the one in the column that has keyboard focus.
 */

const senders = new Map<HTMLElement, () => void>();

/** A Decide tab says how to send it; returns the unregister. */
export function registerApprovalSend(root: HTMLElement, send: () => void): () => void {
  senders.set(root, send);
  return () => {
    if (senders.get(root) === send) senders.delete(root);
  };
}

function focusedSend(): (() => void) | null {
  const column = document.activeElement?.closest('[data-testid="approval-column"]');
  if (!column) return null;
  for (const [root, send] of senders) {
    if (root.isConnected && column.contains(root)) return send;
  }
  return null;
}

/** Keyboard focus is in an approval with a reply form: the Send key answers it. */
export function canSendFocusedApproval(): boolean {
  return focusedSend() !== null;
}

export function sendFocusedApproval(): void {
  focusedSend()?.();
}
