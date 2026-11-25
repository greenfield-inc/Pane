import { beforeEach, describe, expect, it, vi } from 'vitest';

import { panelApi } from '../../services/panelApi';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';
import { openPaneLink, openPaneTarget } from './openPaneLink';
import { parsePaneLink, PANE_LINK_REGEX } from './paneLink';

const paneUrl = 'pane://open?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547&panel=5d7f9f91-8301-4ba9-842c-7dcad54c92f1';

describe('Pane terminal links', () => {
  it('recognizes the CLI link and its pane and panel targets', () => {
    expect(PANE_LINK_REGEX.exec(`Open it: ${paneUrl} (Pane)`)?.[0]).toBe(paneUrl);
    expect(parsePaneLink(paneUrl)).toEqual({
      paneId: 'fd3f9b5a-17ef-4385-917e-e5e8039fb547',
      panelId: '5d7f9f91-8301-4ba9-842c-7dcad54c92f1',
    });
  });

  it('recognizes a start link up to the first space, quote or bracket', () => {
    const startUrl = 'pane://new?repo=acme%2Fapp&prompt=Fix+the+%22login%22+test&agent=codex';
    expect(PANE_LINK_REGEX.exec(`Start it: ${startUrl} (or ask)`)?.[0]).toBe(startUrl);
    expect(PANE_LINK_REGEX.exec(`"${startUrl}"`)?.[0]).toBe(startUrl);
    expect(parsePaneLink(startUrl)).toBeNull();
  });

  it('hands a start link to main, which asks the person before anything starts', async () => {
    const openInMain = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { electronAPI: { window: { openPaneLink: openInMain } } });
    try {
      await openPaneLink('pane://new?repo=app&prompt=hi');
      expect(openInMain).toHaveBeenCalledWith('pane://new?repo=app&prompt=hi');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects links outside the Pane open route', () => {
    expect(parsePaneLink('pane://delete?pane=fd3f9b5a-17ef-4385-917e-e5e8039fb547')).toBeNull();
    expect(parsePaneLink('https://example.com')).toBeNull();
  });
});

describe('openPaneTarget', () => {
  const paneId = 'pane-1';
  const panelId = 'panel-1';

  beforeEach(() => {
    vi.restoreAllMocks();
    usePanelStore.setState({ activationRequests: {}, activePanels: {} });
    // SAFETY: openPaneTarget reads only the id and archived flag of a Pane.
    useSessionStore.setState({ sessions: [{ id: paneId, archived: false } as Session] });
    vi.spyOn(panelApi, 'loadPanelsForSession').mockResolvedValue([
      // SAFETY: openPaneTarget reads only the panel id.
      { id: panelId, sessionId: paneId } as ToolPanel,
    ]);
    vi.spyOn(panelApi, 'setActivePanel').mockResolvedValue(undefined);
    vi.spyOn(useSessionStore.getState(), 'setActiveSession').mockResolvedValue(undefined);
  });

  // The Pane view applies a queued request after loading the remembered layout, so a
  // returning visit shows the requested tab, and the dock expands for its terminal.
  it('queues a layout activation request for the requested panel', async () => {
    await openPaneTarget({ paneId, panelId });
    expect(usePanelStore.getState().activationRequests[paneId]).toEqual({ sessionId: paneId, panelId });
  });

  it('queues no request when the Pane has no such panel', async () => {
    await openPaneTarget({ paneId, panelId: 'missing' });
    expect(usePanelStore.getState().activationRequests[paneId]).toBeUndefined();
  });
});
