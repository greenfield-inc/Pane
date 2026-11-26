import { createContext, useContext } from 'react';
import type { SessionViewEntry } from '../stores/sessionViewCache';

/**
 * How a Session's workspace is being shown (T-87), for the parts that read or write the host.
 *
 * - `peeking`: the sidebar cursor shows it and has not settled. Nothing may be saved for
 *   it (layout, active tab) and no chat in it may start its agent.
 * - `entry`: what the Session view cache holds for it, so the tabs, layout and chat
 *   paint at once instead of reading them one after another.
 *
 * Outside a cached Session tile (a worktree Pane, the old path) it is `{ peeking: false }`.
 */
export interface SessionShow {
  peeking: boolean;
  entry?: SessionViewEntry;
}

const NOT_CACHED: SessionShow = { peeking: false };

export const SessionShowContext = createContext<SessionShow>(NOT_CACHED);

export function useSessionShow(): SessionShow {
  return useContext(SessionShowContext);
}
