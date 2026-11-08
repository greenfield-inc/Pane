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

interface ApprovalColumnState {
  open: Partial<Record<ApprovalSurface, OpenApproval>>;
  /** The last approval the person replied to: a quiet line on whichever approval opens next says how it was taken. */
  lastReplied: string | null;
  openApproval(surface: ApprovalSurface, itemId: string, tab?: string): void;
  setTab(surface: ApprovalSurface, tab: string): void;
  openNested(surface: ApprovalSurface, itemId: string | undefined): void;
  close(surface: ApprovalSurface): void;
  noteReplied(itemId: string | null): void;
}

export const useApprovalColumnStore = create<ApprovalColumnState>((set) => ({
  open: {},
  lastReplied: null,
  openApproval: (surface, itemId, tab = 'qa') => set((state) => ({ open: { ...state.open, [surface]: { itemId, tab } } })),
  setTab: (surface, tab) => set((state) => {
    const current = state.open[surface];
    return current ? { open: { ...state.open, [surface]: { ...current, tab } } } : state;
  }),
  openNested: (surface, itemId) => set((state) => {
    const current = state.open[surface];
    if (!current) return state;
    const next: OpenApproval = { itemId: current.itemId, tab: 'qa' };
    if (itemId) next.nested = itemId;
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
