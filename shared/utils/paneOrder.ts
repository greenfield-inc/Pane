/** Where a host puts a new Pane in its project's list: top under Newest first, bottom under Oldest first. */
export type NewPanePlacement = 'top' | 'bottom';

/** How a host orders its Panes. `chosen` is false until Sort was picked on this host. */
export interface PaneOrderSettings {
  newPanes: NewPanePlacement;
  chosen: boolean;
}

interface OrderedPane {
  displayOrder?: number | null;
  createdAt: string | Date;
}

const time = (value: string | Date) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * A project's Panes in the order its host saved: the highest display order first, so a new Pane
 * (given the highest) lands on top and Panes created before any arranging read newest first.
 * Ties, and Panes with no order, fall back to newest first.
 */
export function comparePaneOrder(a: OrderedPane, b: OrderedPane): number {
  const ao = a.displayOrder;
  const bo = b.displayOrder;
  if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return (bo ?? 0) - (ao ?? 0);
  return time(b.createdAt) - time(a.createdAt);
}
