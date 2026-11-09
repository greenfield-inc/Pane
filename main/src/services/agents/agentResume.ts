import { TerminalPanelState } from '../../../../shared/types/panels';
import { effectiveCustomResume } from '../../../../shared/types/customCommandResume';
import { CliAgentType } from './agentIdentity';
import { isValidOpenCodeSessionId } from './opencodeLaunch';
import { isValidPiSessionId } from './piLaunch';

/**
 * The resume id surfaced to the resume-sessions dialog. Claude's panel id was
 * its --session-id at launch; Codex and Cursor own their ids, so an uncaptured
 * id falls back to each CLI's own recovery entry point ('interactive' picker /
 * 'latest' chat). OpenCode resumes only a captured, validated session id, and
 * Pi only the id Pane gave it with `--session-id`.
 * Custom resumes, including recognized Agent Farm commands, need a recorded id.
 */
export function resolveResumeId(
  agentType: CliAgentType | undefined,
  panelId: string,
  state: Pick<TerminalPanelState, 'agentSessionId' | 'customResume' | 'initialCommand'>,
): string | undefined {
  if (effectiveCustomResume(state)) return state.agentSessionId;
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
    case 'pi':
      return isValidPiSessionId(state.agentSessionId) ? state.agentSessionId : undefined;
    default:
      return undefined;
  }
}
