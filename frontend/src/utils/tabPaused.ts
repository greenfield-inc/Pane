import { chatPausedMarkOf, pausedMarkOf, type ToolPanel } from '../../../shared/types/panels';

/**
 * Whether a tab draws the pause glyph in place of its status dot: a paused terminal, or a paused
 * chat (QA 1781: a paused chat's dot showed green).
 */
export function tabShowsPaused(panel: Pick<ToolPanel, 'type' | 'state'>): boolean {
  return (pausedMarkOf(panel) ?? chatPausedMarkOf(panel)) !== undefined;
}
