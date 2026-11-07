import { useCallback, useEffect, useState } from 'react';
import { API } from '../utils/api';
import { showActionError } from '../stores/errorStore';
import type { NewPanePlacement } from '../../../shared/utils/paneOrder';

/**
 * The sidebar's Sort, an action on the host the app is on: picking it re-sorts every project's
 * Panes once and sets where new Panes land (top under Newest first, bottom under Oldest first).
 * `newPanes` is the host's current choice; a host on an older Pane reads as Newest first.
 *
 * Sort used to be a view setting kept on this computer. A host that has never had Sort picked,
 * opened as this computer while that old setting said Oldest first, is sorted oldest first once,
 * so the list looks as it did.
 */
export function usePaneSort(host: { id: string | undefined; local: boolean }) {
  const [newPanes, setNewPanes] = useState<NewPanePlacement>('top');

  useEffect(() => {
    let cancelled = false;
    setNewPanes('top');
    const load = async () => {
      try {
        const response = await API.sessions.getPaneOrder();
        if (cancelled || !response.success || !response.data) return;
        let placement = response.data.newPanes;
        if (!response.data.chosen && host.local) {
          const view = await window.electronAPI.uiState.getExpanded();
          if (!cancelled && view.success && view.data?.sessionSortAscending) {
            const sorted = await API.sessions.sortPanes('oldest');
            if (sorted.success) placement = 'bottom';
          }
        }
        if (!cancelled) setNewPanes(placement);
      } catch (error) {
        // An older host has no Pane order: it lists newest first.
        console.warn('[sidebar] Could not read where new Panes go:', error);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [host.id, host.local]);

  const sort = useCallback(async (order: 'newest' | 'oldest') => {
    try {
      const response = await API.sessions.sortPanes(order);
      if (!response.success) throw new Error(response.error ?? 'The host did not sort its Panes.');
      setNewPanes(order === 'newest' ? 'top' : 'bottom');
    } catch (cause) {
      showActionError(`The Panes were not sorted ${order} first`, cause);
    }
  }, []);

  return { newPanes, sort };
}
