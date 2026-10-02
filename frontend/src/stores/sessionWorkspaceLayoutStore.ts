import { create } from 'zustand';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import {
  decodeSessionWorkspaceLayout,
  type SessionWorkspaceLayout,
} from '../../../shared/types/sessionWorkspaceLayout';
import {
  createSessionWorkspaceLayout,
  reconcileSessionWorkspaceLayout,
} from '../utils/sessionWorkspaceLayout';
import { useConfigStore } from './configStore';

/**
 * How the window is divided between Sessions, for the host on screen.
 *
 * Scope is per host for the same reason `navigation.lastLocation` is (PR #880):
 * a Session id only means something on the host it came from. The layout is
 * stored beside that memory, under its own per-host ui-state key, and the host
 * it was loaded for is kept here so a switch reloads rather than overwriting
 * the host we are leaving.
 *
 * Sash drags coalesce: writes are debounced, exactly as the per-Pane panel
 * layout does, so a drag does not write once per frame.
 */

const WRITE_DEBOUNCE_MS = 300;

/** Undefined means "not known yet" — config has not loaded. */
type HostId = string | null | undefined;

interface SessionWorkspaceLayoutState {
  layout: SessionWorkspaceLayout | null;
  /** The host `layout` was loaded for; writes only land while it still matches. */
  hostId: HostId;
  loaded: boolean;
  /**
   * Read the host's stored layout and fit it to the Sessions that exist now.
   * Resolves with the layout only on the call that actually hydrated this host,
   * so the caller can align the Session selection to it exactly once.
   */
  hydrate: (liveSessionIds: readonly string[], fallbackSessionId?: string) => Promise<SessionWorkspaceLayout | null>;
  /** Replace the layout after a user gesture and remember it. */
  apply: (layout: SessionWorkspaceLayout) => void;
  /** Fit the layout to a changed Session list. */
  reconcile: (liveSessionIds: readonly string[], fallbackSessionId?: string) => void;
  /** Forget everything, for a host switch or a sign-out. */
  reset: () => void;
}

function activeHostId(): HostId {
  const config = useConfigStore.getState().config;
  return config ? getActiveRemoteHostId(config.remoteDaemon) : undefined;
}

function uiState(): typeof window.electronAPI.uiState | undefined {
  return window.electronAPI?.uiState;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let hydrateGeneration = 0;

function cancelPendingWrite(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

function scheduleWrite(hostId: HostId, layout: SessionWorkspaceLayout | null): void {
  cancelPendingWrite();
  if (hostId === undefined) return;
  const api = uiState();
  if (!api?.saveSessionWorkspaceLayout) return;
  writeTimer = setTimeout(() => {
    void (async () => {
      writeTimer = null;
      // A host switch between the gesture and the write would file this layout
      // under the wrong host; drop it instead and let the new host hydrate.
      if (activeHostId() !== hostId) return;
      try {
        await api.saveSessionWorkspaceLayout(hostId, layout);
      } catch (error) {
        console.warn('[sessionWorkspaceLayout] Failed to remember the Session layout:', error);
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

async function readStoredLayout(hostId: string | null): Promise<SessionWorkspaceLayout | null> {
  const api = uiState();
  if (!api?.getSessionWorkspaceLayout) return null;
  try {
    const response = await api.getSessionWorkspaceLayout(hostId);
    return response.success ? decodeSessionWorkspaceLayout(response.data ?? null) : null;
  } catch (error) {
    console.warn('[sessionWorkspaceLayout] Failed to read the remembered Session layout:', error);
    return null;
  }
}

/** The layout a host falls back to: the whole window showing one Session. */
function fallbackLayout(
  liveSessionIds: readonly string[],
  fallbackSessionId?: string,
): SessionWorkspaceLayout | null {
  const sessionId = fallbackSessionId && liveSessionIds.includes(fallbackSessionId)
    ? fallbackSessionId
    : liveSessionIds[0];
  return sessionId ? createSessionWorkspaceLayout(sessionId) : null;
}

export const useSessionWorkspaceLayoutStore = create<SessionWorkspaceLayoutState>((set, get) => ({
  layout: null,
  hostId: undefined,
  loaded: false,

  hydrate: async (liveSessionIds, fallbackSessionId) => {
    const hostId = activeHostId();
    const current = get();
    if (hostId === undefined) {
      // Config has not landed, so no host owns a stored layout yet. Showing one
      // Session is never wrong, and the real hydrate replaces it once the host
      // is known — the view must not wait on config to render at all.
      if (!current.layout) set({ layout: fallbackLayout(liveSessionIds, fallbackSessionId) });
      return null;
    }
    if (current.loaded && current.hostId === hostId) return null;

    const generation = ++hydrateGeneration;
    const stored = await readStoredLayout(hostId);
    if (generation !== hydrateGeneration) return null;

    // A stored layout wins; failing that, keep whatever is already on screen.
    const base = stored ?? get().layout;
    const reconciled = base ? reconcileSessionWorkspaceLayout(base, liveSessionIds).layout : null;

    if (stored && !reconciled) {
      // Every stored tile pruned. A host switch renames the active host in
      // config before that host's Session list arrives, so a list that overlaps
      // this layout nowhere is far more likely to be the outgoing host's than a
      // reason to throw the incoming host's layout away. Show something usable
      // and remember which host it belongs to, but neither persist it nor mark
      // the host hydrated: the next call, with the host's own Sessions, restores
      // what was stored. A deliberate gesture in the meantime wins, because
      // `apply` marks the layout loaded.
      set({ layout: fallbackLayout(liveSessionIds, fallbackSessionId), hostId });
      return null;
    }

    const layout = reconciled ?? fallbackLayout(liveSessionIds, fallbackSessionId);
    set({ layout, hostId, loaded: true });
    // Only write back a layout the host did not already have in this shape.
    if (layout && JSON.stringify(layout) !== JSON.stringify(stored)) scheduleWrite(hostId, layout);
    return layout;
  },

  apply: (layout) => {
    const { layout: current, hostId } = get();
    if (current && JSON.stringify(current) === JSON.stringify(layout)) return;
    set({ layout, loaded: true });
    scheduleWrite(hostId, layout);
  },

  reconcile: (liveSessionIds, fallbackSessionId) => {
    const { layout, hostId, loaded } = get();
    if (!loaded || !layout) return;
    const { layout: next, changed } = reconcileSessionWorkspaceLayout(layout, liveSessionIds);
    if (!changed) return;
    const repaired = next ?? fallbackLayout(liveSessionIds, fallbackSessionId);
    set({ layout: repaired });
    scheduleWrite(hostId, repaired);
  },

  reset: () => {
    hydrateGeneration += 1;
    cancelPendingWrite();
    set({ layout: null, hostId: undefined, loaded: false });
  },
}));
