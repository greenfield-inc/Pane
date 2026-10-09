import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Pane's whole navigation model (it has no router). The renderer's `ActiveView`
 * aliases this, because a host's remembered location crosses the IPC boundary
 * and has to be decodable in main.
 */
export const PANE_NAVIGATION_VIEWS = ['sessions', 'project', 'pane-chat', 'mission-control'] as const;

export type PaneNavigationView = (typeof PANE_NAVIGATION_VIEWS)[number];

/**
 * Where the user was on one host. Panes, repositories and Sessions all carry
 * per-host ids, so a memory is only ever meaningful for the host it was saved
 * under, and every id in it still has to be revalidated before it is restored.
 *
 * The tabs and split inside a Pane live in their own per-Pane memory.
 */
export interface HostNavigationMemory {
  view: PaneNavigationView;
  /** Repository view's project id, or null when no repository view was open. */
  projectId: number | null;
  /** Active Pane, or null when the Panes home view was showing. */
  paneId: string | null;
  /** Selected Session on this desktop. Absent in memories saved before it was kept. */
  orchestrationSessionId?: string | null;
}

const hostNavigationMemorySchema: BoundarySchema<HostNavigationMemory> = boundary.object({
  view: boundary.enumeration(...PANE_NAVIGATION_VIEWS),
  projectId: boundary.nullable(boundary.number),
  paneId: boundary.nullable(boundary.string),
  orchestrationSessionId: boundary.optional(boundary.nullable(boundary.string)),
});

/** Returns null for anything that is not a usable memory, including older shapes. */
export function decodeHostNavigationMemory<Value>(value: Value): HostNavigationMemory | null {
  return decodeOptionalBoundary(value, hostNavigationMemorySchema) ?? null;
}
