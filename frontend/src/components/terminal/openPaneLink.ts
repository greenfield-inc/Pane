import { panelApi } from '../../services/panelApi';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { parsePaneLink } from './paneLink';

export async function openPaneLink(uri: string): Promise<void> {
  if (!parsePaneLink(uri)) return;

  // A remote daemon has no Electron window. Navigate the connected renderer instead.
  if (useConfigStore.getState().config?.remoteDaemon?.client.mode === 'remote') {
    const params = new URL(uri).searchParams;
    const paneId = params.get('pane');
    if (paneId) {
      const pane = useSessionStore.getState().sessions.find(session => session.id === paneId);
      if (!pane || pane.archived) return;
      const panelId = params.get('panel');
      if (panelId) {
        const panels = await panelApi.loadPanelsForSession(paneId);
        if (!panels.some(panel => panel.id === panelId)) return;
        await panelApi.setActivePanel(paneId, panelId);
        usePanelStore.getState().setActivePanel(paneId, panelId);
      }
      await useSessionStore.getState().setActiveSession(paneId);
      useNavigationStore.getState().navigateToSessions();
      return;
    }
    const repoId = params.get('repo');
    if (repoId) {
      useNavigationStore.getState().navigateToProject(Number(repoId));
      return;
    }
    const sessionId = params.get('session');
    if (sessionId) {
      useNavigationStore.getState().navigateToPaneChat();
      await useOrchestrationSessionStore.getState().select({ sessionId });
    }
    return;
  }

  const result: { success: boolean; error?: string } = await window.electronAPI.invoke('pane:open-link-local', uri);
  if (!result.success) throw new Error(result.error ?? 'Failed to open Pane link');
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
