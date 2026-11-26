import type { ToolPanel } from '../../../../shared/types/panels';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { panelManager } from '../panelManager';
import { isTranscriptAgent, type TranscriptLocator } from './index';

const agentSessionState = boundary.object({ agentSessionId: boundary.optional(boundary.string) });

/**
 * Where a Claude or Codex panel's transcript is: the agent's own files for the panel's working
 * directory (its Pane's worktree), its conversation id when Pane knows it, and nothing written
 * before the panel existed. Undefined for any other agent, or without a working directory.
 */
export function panelTranscriptLocator(panel: ToolPanel, cwd: string | undefined, agentType: string | undefined): TranscriptLocator | undefined {
  if (!cwd || !isTranscriptAgent(agentType)) return undefined;
  const current = panelManager.getPanel(panel.id) ?? panel;
  const customState = decodeOptionalBoundary(current.state?.customState ?? {}, agentSessionState);
  const createdAt = Date.parse(panel.metadata?.createdAt ?? '');
  return {
    agent: agentType,
    cwd,
    sessionId: customState?.agentSessionId,
    notBeforeMs: Number.isNaN(createdAt) ? undefined : createdAt,
  };
}
