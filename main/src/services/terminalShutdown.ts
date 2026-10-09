import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { customCommandResumeSchema } from '../../../shared/types/customCommandResume';
import type { ToolPanel } from '../../../shared/types/panels';
import { isCliAgentType, resolveAgentTypeFromCommand } from './agents/agentIdentity';

const shutdownResumeStateSchema = boundary.object({
  agentType: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor', 'opencode')),
  initialCommand: boundary.optional(boundary.string),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
});

export type ShutdownPanelLookup = (panelId: string) => ToolPanel | undefined;
export type ShutdownPanelUpdate = (panelId: string, updates: Partial<ToolPanel>) => Promise<void>;

/** Mark each valid native terminal independently so malformed persisted state cannot abort shutdown. */
export async function markTerminalPanelsInterrupted(
  panelIds: readonly string[],
  getPanel: ShutdownPanelLookup,
  updatePanel: ShutdownPanelUpdate,
): Promise<Map<string, string[]>> {
  const interruptedPanels = new Map<string, string[]>();

  for (const panelId of panelIds) {
    const panel = getPanel(panelId);
    if (!panel) continue;

    try {
      const customState = decodeBoundary(panel.state?.customState ?? {}, boundary.jsonObject);
      const resumeState = decodeBoundary(customState, shutdownResumeStateSchema);
      const agentType = resumeState.agentType ?? resolveAgentTypeFromCommand(resumeState.initialCommand);
      if (!isCliAgentType(agentType) && !resumeState.customResume) continue;

      panel.state.customState = { ...customState, wasInterrupted: true, agentType };
      await updatePanel(panelId, { state: panel.state });

      const existing = interruptedPanels.get(panel.sessionId);
      if (existing) existing.push(panelId);
      else interruptedPanels.set(panel.sessionId, [panelId]);
    } catch (error) {
      console.warn(`[Main] Skipping malformed terminal state during shutdown for panel ${panelId}:`, error);
    }
  }

  return interruptedPanels;
}
