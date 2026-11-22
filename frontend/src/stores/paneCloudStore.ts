import { create } from 'zustand';
import type { OrchestrationSessionCreateInput } from '../../../shared/types/orchestrationSession';
import { SIGNED_OUT_PANE_CLOUD, type PaneCloudCreated, type PaneCloudError, type PaneCloudSnapshot } from '../../../shared/types/paneCloud';

/** A Pane Cloud call that failed, with the next step main gave. */
export class PaneCloudCallError extends Error {
  readonly next: string | null;
  readonly code: string | undefined;

  constructor(error: PaneCloudError) {
    super(error.message);
    this.name = 'PaneCloudCallError';
    this.next = error.next;
    this.code = error.code;
  }
}

interface PaneCloudState {
  snapshot: PaneCloudSnapshot;
  /** Main has answered once: until then signed-out may only mean "not read yet". */
  loaded: boolean;
  /** Reads the snapshot and follows main's pushes. Returns the stop function. */
  follow: () => () => void;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  stop: (vmId: string) => Promise<void>;
  start: (vmId: string) => Promise<void>;
  remove: (vmId: string) => Promise<void>;
  /** New cloud Session. Throws PaneCloudCallError with the next step. */
  create: (input: OrchestrationSessionCreateInput) => Promise<PaneCloudCreated>;
}

function api() {
  return window.electronAPI?.paneCloud;
}

let followers = 0;
let unsubscribe: (() => void) | null = null;

/**
 * Pane Cloud as main holds it: one snapshot for the Create Session dialog, the sidebar and Usage &
 * Limits. Main pushes every change; each call also answers with the new snapshot.
 */
export const usePaneCloudStore = create<PaneCloudState>((set) => {
  const apply = (snapshot: PaneCloudSnapshot) => set({ snapshot, loaded: true });
  /** Main answers with the snapshot, whose `error` says what failed. */
  const run = async (call: (() => Promise<{ success: boolean; data?: PaneCloudSnapshot; error?: string }>) | undefined) => {
    if (!call) return;
    try {
      const response = await call();
      if (response.data) apply(response.data);
    } catch (error) {
      set((state) => ({ snapshot: { ...state.snapshot, error: { message: error instanceof Error ? error.message : String(error), next: null } } }));
    }
  };
  return {
    snapshot: SIGNED_OUT_PANE_CLOUD,
    loaded: false,
    follow: () => {
      const cloud = api();
      if (!cloud) return () => undefined;
      if (followers++ === 0) unsubscribe = cloud.onChanged(apply);
      // Each view that starts following reads afresh: a limit may have changed on another device since the last read.
      void cloud.get().then((response) => { if (response.data) apply(response.data); }).catch((error) => {
        console.warn('[paneCloud] Could not read Pane Cloud:', error);
      });
      return () => {
        if (--followers === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
    signIn: () => run(api()?.signIn),
    signOut: () => run(api()?.signOut),
    stop: (vmId) => run(() => api()?.stop(vmId) ?? Promise.resolve({ success: false })),
    start: (vmId) => run(() => api()?.start(vmId) ?? Promise.resolve({ success: false })),
    remove: (vmId) => run(() => api()?.remove(vmId) ?? Promise.resolve({ success: false })),
    create: async (input) => {
      const cloud = api();
      if (!cloud) throw new PaneCloudCallError({ message: 'This version of Pane cannot reach Pane Cloud.', next: 'Update Pane, then try again.' });
      const response = await cloud.create(input);
      if (!response.success || !response.data) {
        throw new PaneCloudCallError({ message: response.error ?? 'Pane Cloud did not create the Session and gave no reason.', next: response.details ?? null, code: response.code });
      }
      apply(response.data.snapshot);
      return response.data;
    },
  };
});
