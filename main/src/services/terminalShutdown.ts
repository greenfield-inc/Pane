import { boundary, decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import { customCommandResumeSchema, effectiveCustomResume } from '../../../shared/types/customCommandResume';
import type { ToolPanel, ToolPanelState } from '../../../shared/types/panels';
import { isCliAgentType, resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { configuredAgentSchema } from '../../../shared/agents';

const shutdownResumeStateSchema = boundary.object({
  agentType: boundary.optional(configuredAgentSchema),
  initialCommand: boundary.optional(boundary.string),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
});

export type ShutdownPanelLookup = (panelId: string) => ToolPanel | undefined;
export type ShutdownPanelUpdate = (panelId: string, updates: Partial<ToolPanel>) => Promise<void>;

/**
 * The saved state that makes a tab resumable on the next start, or undefined for a tab with nothing
 * to resume (a plain shell, or a wrapper Pane cannot reopen). Throws on malformed state.
 */
export function interruptedTerminalState(savedState: ToolPanelState['customState']): JsonObject | undefined {
  const customState = decodeBoundary(savedState ?? {}, boundary.jsonObject);
  const resumeState = decodeBoundary(customState, shutdownResumeStateSchema);
  const agentType = resumeState.agentType ?? resolveAgentTypeFromCommand(resumeState.initialCommand);
  if (!isCliAgentType(agentType) && !effectiveCustomResume(resumeState)) return undefined;
  return agentType ? { ...customState, wasInterrupted: true, agentType } : { ...customState, wasInterrupted: true };
}

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
      const customState = interruptedTerminalState(panel.state?.customState);
      // An agent that already ended on purpose has nothing to resume; one saved before the mark existed does.
      if (!customState || customState.agentLive === false) continue;

      panel.state.customState = customState;
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

/**
 * Marks every live agent tab, and its Pane, interrupted for Pane's quit. Runs first, before anything
 * that can stall, so a quit cut short by its safety timeout still leaves them resumable; it runs
 * again after the terminals are saved to refresh the marks. Returns the Panes marked.
 */
export async function markAgentsInterruptedForQuit(
  panelIds: readonly string[],
  getPanel: ShutdownPanelLookup,
  updatePanel: ShutdownPanelUpdate,
  markPaneInterrupted: (paneId: string) => void,
): Promise<Map<string, string[]>> {
  const interruptedPanels = await markTerminalPanelsInterrupted(panelIds, getPanel, updatePanel);
  for (const paneId of interruptedPanels.keys()) {
    try {
      markPaneInterrupted(paneId);
    } catch (error) {
      console.warn(`[Main] Could not mark Pane ${paneId} interrupted during shutdown:`, error);
    }
  }
  return interruptedPanels;
}
