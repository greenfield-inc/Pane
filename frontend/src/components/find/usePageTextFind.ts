import { useEffect, useState, type RefObject } from 'react';
import { createPageTextAdapter } from './pageTextFinder';
import { usePanelFind } from './usePanelFind';

/** Make a tab's rendered page text searchable with Pane's find. */
export function usePageTextFind(panelId: string, rootRef: RefObject<HTMLElement | null>): void {
  const [adapter] = useState(() => createPageTextAdapter(panelId, () => rootRef.current));
  useEffect(() => () => adapter.dispose(), [adapter]);
  usePanelFind(panelId, rootRef, adapter);
}
