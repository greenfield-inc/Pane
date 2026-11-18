import type { UsageIndexStatus } from '../../../../shared/types/usage';

/**
 * Whether Usage & Limits shows "No agent transcripts found" instead of the report.
 * The index reads several roots (Claude Code, Codex and Pane's own agent logs) and most
 * people have only some of them, so a missing root alone never hides real data: the
 * empty state needs a finished index with nothing in it.
 */
export function hasNoAgentTranscripts(index: UsageIndexStatus | undefined): boolean {
  if (!index || index.scanning) return false;
  return index.eventsIndexed === 0 && index.missingRoots.length > 0;
}
