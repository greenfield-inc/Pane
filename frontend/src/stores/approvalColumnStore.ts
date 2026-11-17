import { create } from 'zustand';
import type { NotifyItem } from '../../../shared/types/notify';

/**
 * Which approval the column shows on each surface (P4): a Session (keyed `session:<id>`), a
 * to-do's split (keyed `todo:<number>`, D-407), Autopilot, or the Approvals screen. One column per
 * surface; ✕ closes it and shows what was underneath again.
 */
export type ApprovalSurface = `session:${string}` | `todo:${number}` | 'autopilot' | 'approvals';

interface OpenApproval {
  itemId: string;
  /** The column's tab: `qa`, `summary`, `origin` or a link's key. */
  tab: string;
  /** Another approval opened in place from a link: Back returns to `itemId`. */
  nested?: string;
}

/** One approval's unsent reply: one pick per question ('' for none) and the words typed. */
interface ApprovalDraft {
  picks: string[];
  text: string;
}

interface ApprovalColumnState {
  open: Partial<Record<ApprovalSurface, OpenApproval>>;
  /** What's typed and picked on each approval (by `<id>:<version>`), kept until its Send is accepted (F-4). */
  drafts: Record<string, ApprovalDraft>;
  setDraft(key: string, draft: ApprovalDraft | null): void;
  /**
   * After an accepted Send: clears the draft only if it is still what was sent, and says whether it
   * did. Words or picks changed while Send was pending stay (F-15).
   */
  clearSentDraft(key: string, sent: ApprovalDraft): boolean;
  openApproval(surface: ApprovalSurface, itemId: string, tab?: string): void;
  setTab(surface: ApprovalSurface, itemId: string, tab: string): void;
  openNested(surface: ApprovalSurface, itemId: string, nested: string | undefined): void;
  close(surface: ApprovalSurface): void;
  /** Cards dismissed from a chat's dock (Q-389): chat → item id → the `dockKey` it was dismissed at. */
  docked: Record<string, Record<string, string>>;
  dismissDocked(chat: string, itemId: string, key: string): void;
}

export const useApprovalColumnStore = create<ApprovalColumnState>((set, get) => ({
  open: {},
  drafts: {},
  setDraft: (key, draft) => set((state) => {
    const drafts = { ...state.drafts };
    if (draft) drafts[key] = draft;
    else delete drafts[key];
    return { drafts };
  }),
  clearSentDraft: (key, sent) => {
    const current = get().drafts[key];
    if (current && (current.text !== sent.text || current.picks.length !== sent.picks.length || current.picks.some((pick, at) => pick !== sent.picks[at]))) return false;
    get().setDraft(key, null);
    return true;
  },
  openApproval: (surface, itemId, tab = 'qa') => set((state) => ({ open: { ...state.open, [surface]: { itemId, tab } } })),
  // Approvals opens its column from the list's selection, so a tab can be the first thing set.
  setTab: (surface, itemId, tab) => set((state) => ({ open: { ...state.open, [surface]: { itemId, tab } } })),
  openNested: (surface, itemId, nested) => set((state) => {
    const next: OpenApproval = { itemId, tab: 'qa' };
    if (nested) next.nested = nested;
    return { open: { ...state.open, [surface]: next } };
  }),
  close: (surface) => set((state) => {
    const open = { ...state.open };
    delete open[surface];
    return { open };
  }),
  docked: {},
  dismissDocked: (chat, itemId, key) => set((state) => ({ docked: { ...state.docked, [chat]: { ...state.docked[chat], [itemId]: key } } })),
}));

/** Opens an approval in a Session's column (from its count, an inline card, or a link). */
export function openSessionApproval(sessionId: string, itemId: string): void {
  useApprovalColumnStore.getState().openApproval(`session:${sessionId}`, itemId);
}

/** A to-do page's split column: the approval it shows, opened on its Q&A tab. */
export function todoApprovalSurface(todoNumber: number): `todo:${number}` {
  return `todo:${todoNumber}`;
}

/** The key an approval's unsent reply is kept under: one draft per version, shared by every surface. */
export function draftKey(item: Pick<NotifyItem, 'id' | 'version'>): string {
  return `${item.id}:${item.version ?? 1}`;
}

/**
 * A one-question card's pick (an options card or an approval's Approve/Deny), as an index into
 * `labels`: -1 until the person picks one. Nothing starts selected, recommended or not (D-385); a
 * pick the person made is kept in the approval's draft, so it comes back after paging and remounts
 * and on any other surface in the same window. The draft store is per window: Notify's round runs
 * in its own window, so a pick made there doesn't reach the main window's column.
 */
export function useDraftChoice(item: Pick<NotifyItem, 'id' | 'version'>, labels: readonly string[]): [number, (index: number) => void] {
  const key = draftKey(item);
  const draft = useApprovalColumnStore((state) => state.drafts[key]);
  const setDraft = useApprovalColumnStore((state) => state.setDraft);
  const picked = draft?.picks[0];
  const index = picked ? labels.indexOf(picked) : -1;
  const pick = (next: number) => {
    const label = labels[next];
    if (label !== undefined) setDraft(key, { picks: [label], text: draft?.text ?? '' });
  };
  return [index, pick];
}
