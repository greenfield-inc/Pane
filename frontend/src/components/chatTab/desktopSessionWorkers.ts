import { useCallback } from 'react';
import { API } from '../../utils/api';
import { onSessionOverviewChange } from '../../utils/sessionOverviewEvents';
import { panelApi } from '../../services/panelApi';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import type { SessionWorkerSource } from './sessionWorkers';

/** The desktop reads the Session overview over IPC and hears its updates as window events. */
export const DESKTOP_WORKERS: SessionWorkerSource = {
  overview: sessionId => API.orchestrationSessions.overview({ sessionId }).then(response => response.success ? response.data : undefined),
  onChange: callback => onSessionOverviewChange(callback),
};

/** Opens a worker's Pane in Sessions view, at the named tab when there is one (D-276). */
export function useOpenWorkerTab(): (paneId: string, panelId?: string) => void {
  const setActiveSession = useSessionStore(store => store.setActiveSession);
  const navigateToSessions = useNavigationStore(store => store.navigateToSessions);
  return useCallback((paneId: string, panelId?: string) => {
    if (panelId) {
      // Remembered first, so the Pane opens on this tab rather than the one it last showed.
      usePanelStore.getState().setActivePanel(paneId, panelId);
      void panelApi.setActivePanel(paneId, panelId).catch(() => undefined);
    }
    setActiveSession(paneId);
    navigateToSessions();
  }, [navigateToSessions, setActiveSession]);
}
