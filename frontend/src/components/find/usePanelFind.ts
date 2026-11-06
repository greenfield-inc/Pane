import { useEffect, type RefObject } from 'react';
import { registerFindTarget, type FindAdapter } from './findController';

/**
 * Make a tab searchable with Pane's find. `rootRef` is the tab's content
 * element (focus or clicks inside it route Cmd/Ctrl+F here); pass a null
 * adapter while the tab has nothing to offer yet.
 */
export function usePanelFind(panelId: string, rootRef: RefObject<Element | null>, adapter: FindAdapter | null): void {
  useEffect(() => {
    if (!adapter) return;
    return registerFindTarget(panelId, { adapter, root: () => rootRef.current });
  }, [panelId, rootRef, adapter]);
}
