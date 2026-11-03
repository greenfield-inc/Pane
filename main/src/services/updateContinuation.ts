import type { TerminalPanelState } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { detectAgentComposer } from './agents/agentScreenSignature';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { effectiveCustomResume } from '../../../shared/types/customCommandResume';

export function updateContinuation(state: TerminalPanelState, activity: AgentState | undefined) {
  if (activity !== 'working') return { eligible: false, requiresAttention: false, reason: activity === 'blocked' ? 'Approval or input was pending; review the saved conversation.' : 'The panel was not actively working; it remains stopped.' };
  if (state.agentReport?.state === 'done' || state.agentReport?.state === 'blocked' || state.agentReport?.state === 'failed') return { eligible: false, requiresAttention: false, reason: `The agent reported ${state.agentReport.state}; it remains stopped.` };
  if (!state.agentSessionId) return { eligible: false, requiresAttention: true, reason: 'No exact conversation ID was recorded; choose the conversation manually.' };
  const custom = effectiveCustomResume(state);
  if (custom) return { eligible: custom.config.resumeTemplate.includes('{sessionId}'), requiresAttention: !custom.config.resumeTemplate.includes('{sessionId}'), reason: 'Restore the recorded conversation using the saved custom resume profile.' };
  if (!state.agentType || state.launchMode === 'wrapped' || state.preserveLaunchCommand) return { eligible: false, requiresAttention: true, reason: 'The saved command has no explicit resume contract; it remains stopped.' };
  return { eligible: true, requiresAttention: false, reason: 'Reopen the exact recorded conversation without submitting input.' };
}

/** Capture before quit marks every resumable terminal interrupted and sends Ctrl+C. */
export function checkpointUpdatePanel(state: TerminalPanelState, activity: AgentState | undefined, sessionCwd?: string) {
  const cwd = state.orchestrationWorkspace || state.cwd || sessionCwd;
  const composer = detectAgentComposer(state.screenText ?? '', state.agentType);
  const pendingInput = composer.hasUndeliveredText || Boolean((state.initialInput || state.initialInputFile) && !state.initialInputSentAt);
  const continuation = updateContinuation(state, activity);
  const safety = pendingInput
    ? { eligible: false, requiresAttention: true, reason: 'Unsubmitted input was saved in the checkpoint; review it manually. No input was replayed.' }
    : !cwd && continuation.eligible
      ? { eligible: false, requiresAttention: true, reason: 'No panel launch or Session working directory was recorded; choose it manually.' }
      : continuation;
  return {
    ...safety, activity: activity ?? 'unknown', cwd, resumeId: state.agentSessionId,
    // JSON roundtrip makes the checkpoint independent of subsequent nested mutations
    // and omits undefined fields before validating the durable boundary.
    priorState: decodeBoundary(JSON.parse(JSON.stringify(state)), boundary.jsonObject),
  };
}

export const checkpointSchema = boundary.object({
  bootId: boundary.string,
  panels: boundary.array(boundary.object({ panelId: boundary.string, sessionId: boundary.string, resumeId: boundary.optional(boundary.string), cwd: boundary.optional(boundary.nonEmptyString), activity: boundary.enumeration('working', 'idle', 'blocked', 'unknown'), priorState: boundary.jsonObject, eligible: boundary.boolean, requiresAttention: boundary.optional(boundary.boolean), reason: boundary.string })),
});
