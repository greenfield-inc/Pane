import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';

/** The Session orchestrator's chat tab, which reads quietly (D-18). */
export function isSessionChat(panel: ToolPanel): boolean {
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  return panel.type === 'chat' && !!(panel.state.customState as ChatPanelState | undefined)?.orchestrationSessionId;
}
