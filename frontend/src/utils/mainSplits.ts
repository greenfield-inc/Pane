import { createContext, useContext } from 'react';

/**
 * The main content area's one split rule (D-448): it shows at most two splits side by side, and
 * nothing ever opens a third column. A surface that wants another split asks `canOpenSplit`; when
 * it is refused, what it would have opened lands as a tab in the split it already has.
 *
 * Today the to-do page obeys it (T-38). Session panel splits are to adopt it next.
 */
export const MAX_MAIN_SPLITS = 2;

/** The splits a surface may use: at most `max`, of which `shown` are already taken around it. */
export interface SplitArea {
  max: number;
  shown: number;
}

/** The whole main content area, with nothing in it yet: the full To-dos page. */
export const MAIN_AREA: SplitArea = { max: MAX_MAIN_SPLITS, shown: 0 };

/**
 * An area with room for one thing and no split views: one of a Session's two splits, a sidebar, an
 * iPad. Anything not given the main area is this, so a surface never splits by accident.
 */
export const NO_SPLIT_AREA: SplitArea = { max: 1, shown: 0 };

/** Whether a surface in `area`, showing `shownInside` splits itself, may open one more. */
export function canOpenSplit(area: SplitArea, shownInside: number): boolean {
  return area.shown + shownInside < area.max;
}

/** The area a surface is drawn in; the main content area provides `MAIN_AREA` where it has room for two. */
export const SplitAreaContext = createContext<SplitArea>(NO_SPLIT_AREA);

export function useSplitArea(): SplitArea {
  return useContext(SplitAreaContext);
}
