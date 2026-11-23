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
  /** Reads Pane Cloud again now. */
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  stop: (vmId: string) => Promise<void>;
  start: (vmId: string) => Promise<void>;
  remove: (vmId: string) => Promise<void>;
  updatePane: (vmId: string) => Promise<void>;
  archive: (vmId: string) => Promise<void>;
  restore: (vmId: string) => Promise<void>;
  /** New cloud Session; with `projectId`, its VM clones that project's repo. Throws PaneCloudCallError with the next step. */
  create: (input: OrchestrationSessionCreateInput, projectId?: number) => Promise<PaneCloudCreated>;
  /** Asks for a sealing key while the create dialog is open, so Create waits on nothing extra. */
  prepareCreate: () => void;
  retryClone: (vmId: string) => Promise<void>;
  /** The new cloud Session the waking view shows, from Create until its Pane opens or the person leaves it. */
  waking: PaneCloudWaking | null;
  setWaking: (waking: PaneCloudWaking | null) => void;
}

/** What the waking view shows about a cloud Session being made (frame D2). */
export interface PaneCloudWaking {
  name: string;
  /** When Create was pressed, for the time so far. */
  startedAt: number;
  /** Known once the service made the VM; its clone is read from the snapshot. */
  vmId: string | null;
  machineId: string | null;
  sessionId: string | null;
  /** Why the create failed, when it did. */
  error: PaneCloudError | null;
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
      // Pane Cloud never takes the views that show it down: a bridge without it (an older preload) leaves it signed out.
      try {
        if (followers === 0) unsubscribe = cloud.onChanged(apply);
        // Each view that starts following reads afresh: a limit may have changed on another device since the last read.
        void cloud.get().then((response) => { if (response.data) apply(response.data); }).catch((error) => {
          console.warn('[paneCloud] Could not read Pane Cloud:', error);
        });
      } catch (error) {
        console.warn('[paneCloud] This window cannot reach Pane Cloud:', error);
        return () => undefined;
      }
      followers += 1;
      return () => {
        if (--followers === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
    refresh: () => run(api()?.get),
    signIn: () => run(api()?.signIn),
    signOut: () => run(api()?.signOut),
    stop: (vmId) => run(() => api()?.stop(vmId) ?? Promise.resolve({ success: false })),
    start: (vmId) => run(() => api()?.start(vmId) ?? Promise.resolve({ success: false })),
    remove: (vmId) => run(() => api()?.remove(vmId) ?? Promise.resolve({ success: false })),
    updatePane: (vmId) => run(() => api()?.updatePane(vmId) ?? Promise.resolve({ success: false })),
    archive: (vmId) => run(() => api()?.archive(vmId) ?? Promise.resolve({ success: false })),
    restore: (vmId) => run(() => api()?.restore(vmId) ?? Promise.resolve({ success: false })),
    waking: null,
    setWaking: (waking) => set({ waking }),
    prepareCreate: () => {
      void api()?.prepareCreate().catch(() => undefined);
    },
    retryClone: (vmId) => run(() => api()?.retryClone(vmId) ?? Promise.resolve({ success: false })),
    create: async (input, projectId) => {
      const cloud = api();
      if (!cloud) throw new PaneCloudCallError({ message: 'This version of Pane cannot reach Pane Cloud.', next: 'Update Pane, then try again.' });
      const response = await cloud.create(input, projectId);
      if (!response.success || !response.data) {
        throw new PaneCloudCallError({ message: response.error ?? 'Pane Cloud did not create the Session and gave no reason.', next: response.details ?? null, code: response.code });
      }
      apply(response.data.snapshot);
      return response.data;
    },
  };
});
