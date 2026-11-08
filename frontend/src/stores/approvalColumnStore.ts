import { create } from 'zustand';

/**
 * Which approval the column shows on each surface (P4): a Session (keyed `session:<id>`),
 * Autopilot, or the Approvals screen. One column per surface; ✕ closes it and shows what was
 * underneath again.
 */
export type ApprovalSurface = `session:${string}` | 'autopilot' | 'approvals';

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
  /** The last approval the person replied to: a quiet line on whichever approval opens next says how it was taken. */
  lastReplied: string | null;
  /** What's typed and picked on each approval (by `<id>:<version>`), kept until its Send is accepted (F-4). */
  drafts: Record<string, ApprovalDraft>;
  setDraft(key: string, draft: ApprovalDraft | null): void;
  openApproval(surface: ApprovalSurface, itemId: string, tab?: string): void;
  setTab(surface: ApprovalSurface, itemId: string, tab: string): void;
  openNested(surface: ApprovalSurface, itemId: string, nested: string | undefined): void;
  close(surface: ApprovalSurface): void;
  noteReplied(itemId: string | null): void;
}

export const useApprovalColumnStore = create<ApprovalColumnState>((set) => ({
  open: {},
  lastReplied: null,
  drafts: {},
  setDraft: (key, draft) => set((state) => {
    const drafts = { ...state.drafts };
    if (draft) drafts[key] = draft;
    else delete drafts[key];
    return { drafts };
  }),
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
  noteReplied: (itemId) => set({ lastReplied: itemId }),
}));

/** Opens an approval in a Session's column (from its count, an inline card, or a link). */
export function openSessionApproval(sessionId: string, itemId: string): void {
  useApprovalColumnStore.getState().openApproval(`session:${sessionId}`, itemId);
}
