import { useEffect, useState, type RefObject } from 'react';
import { useFindBarOpen } from './findController';
import { createPageTextAdapter, watchFindMode } from './pageTextFinder';
import { usePanelFind } from './usePanelFind';

/** Make a tab's rendered page text searchable with Pane's find. */
export function usePageTextFind(panelId: string, rootRef: RefObject<HTMLElement | null>): void {
  const [adapter] = useState(() => createPageTextAdapter(panelId, () => rootRef.current));
  useEffect(() => () => adapter.dispose(), [adapter]);
  usePanelFind(panelId, rootRef, adapter);

  const open = useFindBarOpen(panelId);
  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    return watchFindMode(panelId, root);
  }, [open, panelId, rootRef]);
}
