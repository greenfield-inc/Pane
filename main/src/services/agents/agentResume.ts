import { TerminalPanelState } from '../../../../shared/types/panels';
import { CliAgentType } from './agentIdentity';

/**
 * The resume id surfaced to the resume-sessions dialog. New Claude panels use their panel id at launch; migrated panels retain their
 * original conversation id; Codex and Cursor own their ids, so an uncaptured
 * id falls back to each CLI's own recovery entry point ('interactive' picker /
 * 'latest' chat).
 */
export function resolveResumeId(
  agentType: CliAgentType | undefined,
  panelId: string,
  state: Pick<TerminalPanelState, 'agentSessionId' | 'customResume'>,
): string | undefined {
  if (state.customResume) return state.agentSessionId;
  switch (agentType) {
    case 'claude':
      return state.agentSessionId ?? panelId;
    case 'codex':
      return state.agentSessionId ?? 'interactive';
    case 'cursor':
      return state.agentSessionId ?? 'latest';
    default:
      return undefined;
  }
}
