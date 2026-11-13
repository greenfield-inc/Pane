import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
});

import { panelApi } from '../../services/panelApi';
import { useErrorStore } from '../../stores/errorStore';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';
import { openWorkerTab } from './desktopSessionWorkers';

describe('openWorkerTab (review F-2 on #1281)', () => {
  const paneId = 'pane-1';

  beforeEach(() => {
    vi.restoreAllMocks();
    // A returning visit: the Pane last showed another tab.
    usePanelStore.setState({ activationRequests: {}, activePanels: { [paneId]: 'remembered' } });
    // SAFETY: the opener reads only the id and archived flag of a Pane.
    useSessionStore.setState({ sessions: [{ id: paneId, archived: false } as Session] });
    vi.spyOn(panelApi, 'setActivePanel').mockResolvedValue(undefined);
    vi.spyOn(useSessionStore.getState(), 'setActiveSession').mockResolvedValue(undefined);
  });

  it('asks the Pane view for the working tab, so it wins over the remembered one', async () => {
    // SAFETY: the opener reads only the panel ids.
    vi.spyOn(panelApi, 'loadPanelsForSession').mockResolvedValue([{ id: 'remembered' }, { id: 'reviewer' }] as ToolPanel[]);
    await openWorkerTab(paneId, 'reviewer');
    expect(usePanelStore.getState().activationRequests[paneId]).toEqual({ sessionId: paneId, panelId: 'reviewer' });
    expect(usePanelStore.getState().activePanels[paneId]).toBe('reviewer');
  });

  it('says so when the Pane cannot be opened', async () => {
    vi.spyOn(panelApi, 'loadPanelsForSession').mockRejectedValue(new Error('host went away'));
    const showError = vi.spyOn(useErrorStore.getState(), 'showError').mockImplementation(() => undefined);
    await openWorkerTab(paneId, 'reviewer');
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not open that agent' }));
  });
});
