import { panelApi } from '../../services/panelApi';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';

import { parsePaneLink } from './paneLink';

export async function openPaneLink(uri: string): Promise<void> {
  const target = parsePaneLink(uri);
  if (target) await openPaneTarget(target);
}

/** Opens a Pane, and optionally one of its panels, when the active host has it. */
export async function openPaneTarget(target: { paneId: string; panelId?: string }): Promise<void> {
  const pane = useSessionStore.getState().sessions.find(session => session.id === target.paneId);
  if (!pane || pane.archived) return;

  if (target.panelId) {
    const panels = await panelApi.loadPanelsForSession(target.paneId);
    if (!panels.some(panel => panel.id === target.panelId)) return;
    await panelApi.setActivePanel(target.paneId, target.panelId);
    usePanelStore.getState().setActivePanel(target.paneId, target.panelId);
  }

  await useSessionStore.getState().setActiveSession(target.paneId);
  useNavigationStore.getState().navigateToSessions();
}
