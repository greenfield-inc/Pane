import { useEffect, useRef, type RefObject } from 'react';
import { useHotkey } from './useHotkey';
import {
  focusSidebar,
  handleSidebarListKey,
  minimizeAtFocus,
  moveFocus,
  noteFocusIn,
  registerRegionActions,
  toggleMaximizeAtFocus,
  type RegionActions,
  stepFocus,
} from '../services/regionFocus';
import type { FocusDirection } from '../utils/focusStops';

const DIRECTIONS: ReadonlyArray<{ id: 'focus-group-left' | 'focus-group-right' | 'focus-group-up' | 'focus-group-down'; dir: FocusDirection; label: string }> = [
  { id: 'focus-group-left', dir: 'left', label: 'Focus Left' },
  { id: 'focus-group-right', dir: 'right', label: 'Focus Right' },
  { id: 'focus-group-up', dir: 'up', label: 'Focus Up' },
  { id: 'focus-group-down', dir: 'down', label: 'Focus Down' },
];

function useDirectionHotkey({ id, dir, label }: typeof DIRECTIONS[number]): void {
  useHotkey({ id, label, category: 'navigation', action: () => { moveFocus(dir); } });
}

/**
 * Keyboard focus across the whole window (P3): ⌘0 to the sidebar, ⌘⌥+arrows
 * across region edges, F6 / ⇧F6 through the regions, and the sidebar as a
 * keyboard list. Mounted once, at the app root.
 */
export function useRegionNavigation(): void {
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      // SAFETY: focusin targets on the window are elements.
      noteFocusIn(event.target as Element | null);
    };
    window.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', handleSidebarListKey);
    return () => {
      window.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', handleSidebarListKey);
    };
  }, []);

  useHotkey({ id: 'focus-sidebar', label: 'Focus Sidebar', category: 'navigation', action: focusSidebar });
  useDirectionHotkey(DIRECTIONS[0]);
  useDirectionHotkey(DIRECTIONS[1]);
  useDirectionHotkey(DIRECTIONS[2]);
  useDirectionHotkey(DIRECTIONS[3]);
  useHotkey({ id: 'focus-next-region', label: 'Focus Next Region', category: 'navigation', action: () => stepFocus(1) });
  useHotkey({ id: 'focus-previous-region', label: 'Focus Previous Region', category: 'navigation', action: () => stepFocus(-1) });
  useHotkey({ id: 'zoom-toggle', label: 'Maximize or Restore Focused Region', category: 'view', action: () => { toggleMaximizeAtFocus(); } });
  useHotkey({ id: 'minimize-region', label: 'Minimize Focused Side Region', category: 'view', action: () => { minimizeAtFocus(); } });
}

/**
 * Says what maximize and minimize mean for the region rendered at `ref`. The
 * latest callbacks are used, so callers need not memoize them.
 */
export function useRegionActions(ref: RefObject<Element | null>, actions: RegionActions): void {
  const latest = useRef(actions);
  useEffect(() => { latest.current = actions; });
  const canMaximize = Boolean(actions.toggleMaximize);
  const canMinimize = Boolean(actions.minimize);
  useEffect(() => {
    const element = ref.current;
    if (!element || (!canMaximize && !canMinimize)) return undefined;
    return registerRegionActions(element, {
      toggleMaximize: canMaximize ? () => latest.current.toggleMaximize?.() : undefined,
      minimize: canMinimize ? () => latest.current.minimize?.() : undefined,
    });
  }, [ref, canMaximize, canMinimize]);
}
