import { API } from '../../utils/api';
import { onSessionOverviewChange } from '../../utils/sessionOverviewEvents';
import { showActionError } from '../../stores/errorStore';
import { openPaneTarget } from '../terminal/openPaneLink';
import type { SessionWorkerSource } from './sessionWorkers';

/** The desktop reads the Session overview over IPC and hears its updates as window events. */
export const DESKTOP_WORKERS: SessionWorkerSource = {
  overview: sessionId => API.orchestrationSessions.overview({ sessionId }).then(response => response.success ? response.data : undefined),
  onChange: callback => onSessionOverviewChange(callback),
};

/**
 * Opens a worker's Pane in Sessions view, at the named tab when there is one (D-276). The shared
 * opener asks the Pane view to apply the tab after its layout loads, so a remembered tab or a
 * collapsed dock doesn't win (review F-2 on #1281).
 */
export function openWorkerTab(paneId: string, panelId?: string): Promise<void> {
  return openPaneTarget({ paneId, panelId }).catch(error => showActionError('Could not open that agent', error));
}
