import type { LegendListRef } from '@legendapp/list/react-native';
import { useEffect, useRef, type RefObject } from 'react';

import type { FocusListHandle } from './focusContext';
import type { Direction, Rect } from './focusRegistry';

/** Room kept between a focused row and the list's edge. */
const MARGIN = 24;
/** How far one step at the edge scrolls, as a share of the list's height. */
const EDGE_STEP = 0.6;

/**
 * Hooks a Legend List up to the focus ring: wrap its rows in
 * `<FocusListContext value={handle}>`. A focused row scrolls into view, and a
 * move past the last mounted row scrolls a step so the next rows mount.
 */
export function useFocusList(list: RefObject<LegendListRef | null>, bottomInset = 0): FocusListHandle {
  const inset = useRef(bottomInset);
  useEffect(() => {
    inset.current = bottomInset;
  }, [bottomInset]);
  const handle = useRef<FocusListHandle>(null);
  handle.current ??= {
    reveal(rect: Rect) {
      const view = viewport(list.current);
      if (!view || !list.current) return;
      const above = view.y + MARGIN - rect.y;
      // A bar drawn over the list's bottom (Home's search) hides rows behind it.
      const below = rect.y + rect.height - (view.y + view.height - inset.current - MARGIN);
      const delta = above > 0 ? -above : below > 0 ? below : 0;
      if (delta !== 0) void list.current.scrollToOffset({ offset: Math.max(0, list.current.getState().scroll + delta), animated: true });
    },
    onEdge(direction: Direction) {
      const current = list.current;
      const view = viewport(current);
      if (!current || !view || (direction !== 'up' && direction !== 'down')) return false;
      const { scroll, scrollLength, contentLength } = current.getState();
      const max = Math.max(0, contentLength - scrollLength);
      const next = Math.min(max, Math.max(0, scroll + (direction === 'down' ? 1 : -1) * view.height * EDGE_STEP));
      if (Math.abs(next - scroll) < 1) return false;
      void current.scrollToOffset({ offset: next, animated: false });
      return true;
    },
  };
  return handle.current;
}

function viewport(list: LegendListRef | null): Rect | null {
  // SAFETY: on the New Architecture the native scroll ref is a host element, which measures itself.
  const scroll = list?.getNativeScrollRef() as unknown as { getBoundingClientRect?(): DOMRect } | undefined;
  const box = scroll?.getBoundingClientRect?.();
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}
