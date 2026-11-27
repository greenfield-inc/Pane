import { createContext } from 'react';

import type { Direction, Rect } from './focusRegistry';

/** The focus scope controls under it join: '' for screens, a sheet's own key inside it. */
export const FocusScopeKey = createContext('');

/** A scrolling list's hooks for its rows: reveal a focused row, scroll a step at the edge. */
export interface FocusListHandle {
  reveal(rect: Rect): void;
  onEdge(direction: Direction): boolean;
}

export const FocusListContext = createContext<FocusListHandle | null>(null);

/** False for a tab column the controller isn't driving: the other side of a split, or a screen out of view. */
export const ColumnActive = createContext(true);
