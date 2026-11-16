import type { DevicePanelState } from '../../../../shared/types/devices';
import { usePanelStore } from '../../stores/panelStore';

/** The device tab's Pane and state, from the panels this window has loaded. */
export function useDeviceTab(panelId: string): { paneId?: string; state?: DevicePanelState } {
  const panel = usePanelStore((store) => {
    for (const panels of Object.values(store.panels)) {
      const found = panels.find(candidate => candidate.id === panelId);
      if (found) return found;
    }
    return undefined;
  });
  // SAFETY: the panel type discriminator determines the custom-state shape.
  return panel ? { paneId: panel.sessionId, state: panel.type === 'device' ? panel.state.customState as DevicePanelState : undefined } : {};
}
