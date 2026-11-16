import type { ToolPanel } from '../../../shared/types/panels';

/**
 * Reads a time Pane's database wrote: SQLite `CURRENT_TIMESTAMP` is UTC with no zone
 * ("2026-11-04 12:00:00"), which `new Date` would read as local time. ISO strings pass through.
 */
export function parseSessionTimestampMs(value: string): number {
  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
  return Date.parse(sqliteTimestamp ? `${value.replace(' ', 'T')}Z` : value);
}

export interface PaneActivityInput {
  createdAt: Date;
  /** When the person last opened the Pane (`sessions.last_viewed_at`). */
  lastViewedAt?: string;
  panels: readonly Pick<ToolPanel, 'id' | 'type' | 'state' | 'metadata'>[];
}

/**
 * When a Pane was last used: the latest of any terminal output or input or chat agent activity in
 * its tabs and the last time the person selected the Pane or one of its tabs. Auto-pause and
 * `panes list` read the same value. `liveActivity` gives a running tab's in-memory activity time;
 * a stopped terminal tab uses the time saved with its state.
 */
export function paneInactiveSince(pane: PaneActivityInput, liveActivity: (panelId: string) => Date | undefined): Date {
  let latest = pane.createdAt.getTime();
  const consider = (ms: number) => { if (Number.isFinite(ms) && ms > latest) latest = ms; };
  if (pane.lastViewedAt) consider(parseSessionTimestampMs(pane.lastViewedAt));
  for (const panel of pane.panels) {
    consider(Date.parse(panel.metadata.lastActiveAt));
    if (panel.type !== 'terminal' && panel.type !== 'chat') continue;
    const live = liveActivity(panel.id);
    if (live) consider(live.getTime());
    if (panel.type !== 'terminal') continue;
    // SAFETY: a terminal panel's custom state is the TerminalPanelState contract.
    const saved = (panel.state.customState as { lastActivityTime?: string } | undefined)?.lastActivityTime;
    if (saved) consider(Date.parse(saved));
  }
  return new Date(latest);
}
