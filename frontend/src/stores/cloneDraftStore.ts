import { create } from 'zustand';

/** The draft's host: a remote profile id, or this key for this computer. */
export const LOCAL_CLONE_HOST = 'local';

export interface CloneDraft {
  url: string;
  destPath: string;
  error: string;
  /** Remote host whose git could not sign in to the server; null when the error is not about signing in. */
  signInHost: string | null;
}

interface CloneDraftState extends CloneDraft {
  /** Host the draft was filled in for; a draft never follows the user to another host. */
  hostId: string | null;
  /** Updates the draft for `hostId`, starting a fresh one when the draft belongs to another host. */
  update: (hostId: string, draft: Partial<CloneDraft>) => void;
  reset: () => void;
}

export const EMPTY_CLONE_DRAFT: CloneDraft = { url: '', destPath: '', error: '', signInHost: null };

/**
 * What the Clone from GitHub dialog was filled in with. It outlives the dialog
 * so a user sent to the host terminal to sign in can come back and try the
 * same clone again.
 */
export const useCloneDraftStore = create<CloneDraftState>((set) => ({
  ...EMPTY_CLONE_DRAFT,
  hostId: null,
  update: (hostId, draft) => set((state) => (
    state.hostId === hostId ? draft : { ...EMPTY_CLONE_DRAFT, ...draft, hostId }
  )),
  reset: () => set({ ...EMPTY_CLONE_DRAFT, hostId: null }),
}));
