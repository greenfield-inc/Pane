import { TerminalPanelState } from '../../../../shared/types/panels';
import { CliAgentType } from './agentIdentity';
import { isValidOpenCodeSessionId } from './opencodeLaunch';

/**
 * The resume id surfaced to the resume-sessions dialog. Claude's panel id was
 * its --session-id at launch; Codex and Cursor own their ids, so an uncaptured
 * id falls back to each CLI's own recovery entry point ('interactive' picker /
 * 'latest' chat). OpenCode resumes only a captured, validated session id.
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
    case 'opencode':
      return state.agentSessionId && isValidOpenCodeSessionId(state.agentSessionId)
        ? state.agentSessionId
        : undefined;
    default:
      return undefined;
  }
}
