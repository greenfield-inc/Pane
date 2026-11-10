import type { ChatTabConversation } from '../../../../shared/types/chatTab';

/** A row can be opened unless another Pane tab has it open (two processes must never write one conversation). */
export function canPick(row: ChatTabConversation): boolean {
  return !row.openIn;
}

/** The row's name: its title, or its short ID when the agent gave none. */
export function conversationTitle(row: ChatTabConversation): string {
  return row.title?.trim() || `Conversation ${row.sessionId.slice(0, 8)}`;
}

/** Rows whose title contains the filter, ignoring case. */
export function filterConversations(rows: readonly ChatTabConversation[], filter: string): ChatTabConversation[] {
  const query = filter.trim().toLowerCase();
  return query ? rows.filter(row => conversationTitle(row).toLowerCase().includes(query)) : [...rows];
}

/** The first row that can be opened, or -1. */
export function firstPickable(rows: readonly ChatTabConversation[]): number {
  return rows.findIndex(canPick);
}

/** The next pickable row from `index` in direction `step`, wrapping; `index` itself when there is no other. */
export function stepPickable(rows: readonly ChatTabConversation[], index: number, step: 1 | -1): number {
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const next = (index + step * offset + rows.length * rows.length) % rows.length;
    if (canPick(rows[next])) return next;
  }
  return index;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** When a conversation last changed: "Just now", "2 min ago", "4 h ago", "Yesterday", "Nov 3", or "Nov 3, 2025". */
export function conversationTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  const ms = now.getTime() - at.getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (sameDay(at, now)) return `${Math.floor(minutes / 60)} h ago`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return 'Yesterday';
  return at.toLocaleDateString('en-US', at.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Enter opens the selection from the filter or the list; a focused button gets its own press instead (review F-5). */
export function enterOpens(focusedTag: string | undefined): boolean {
  return focusedTag !== 'BUTTON';
}
