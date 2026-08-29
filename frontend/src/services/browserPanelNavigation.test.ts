import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';

import { usePanelStore } from '../stores/panelStore';
import {
  canHostSessionBrowser,
  openUrlInSessionBrowser,
  resolveBrowserNavigation,
  type BrowserPanelApi,
} from './browserPanelNavigation';

const browserPanel = (id: string, sessionId: string, currentUrl: string): ToolPanel => ({
  id,
  sessionId,
  type: 'browser',
  title: 'Browser',
  state: { isActive: false, customState: { currentUrl } },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});

interface FakePanelApi extends BrowserPanelApi {
  createPanel: ReturnType<typeof vi.fn<BrowserPanelApi['createPanel']>>;
  updatePanel: ReturnType<typeof vi.fn<BrowserPanelApi['updatePanel']>>;
  setActivePanel: ReturnType<typeof vi.fn<BrowserPanelApi['setActivePanel']>>;
}

let panelApi: FakePanelApi;

const reset = () => {
  usePanelStore.setState({ panels: {}, activePanels: {}, activityStatus: {}, agentStatus: {}, agentStatusSession: {} });
  panelApi = {
    createPanel: vi.fn<BrowserPanelApi['createPanel']>(async (request) => browserPanel('created', request.sessionId, '')),
    updatePanel: vi.fn<BrowserPanelApi['updatePanel']>(async () => undefined),
    setActivePanel: vi.fn<BrowserPanelApi['setActivePanel']>(async () => undefined),
  };
};

describe('openUrlInSessionBrowser', () => {
  beforeEach(reset);

  it('reuses the first Browser panel with one update and one activation, no event', async () => {
    usePanelStore.setState({ panels: { s1: [browserPanel('b1', 's1', 'https://old'), browserPanel('b2', 's1', 'https://other')] } });

    const result = await openUrlInSessionBrowser('s1', 'https://new/', {}, panelApi);

    expect(result).toEqual({ panelId: 'b1', created: false });
    expect(panelApi.createPanel).not.toHaveBeenCalled();
    expect(panelApi.updatePanel).toHaveBeenCalledTimes(1);
    expect(panelApi.setActivePanel).toHaveBeenCalledWith('s1', 'b1');
    expect(panelApi.setActivePanel).toHaveBeenCalledTimes(1);
    const stored = usePanelStore.getState().panels.s1.find((panel) => panel.id === 'b1');
    expect(stored?.state.customState).toMatchObject({ currentUrl: 'https://new/' });
    expect(stored?.title).toBe('Browser');
    expect(usePanelStore.getState().activePanels.s1).toBe('b1');
  });

  it('gives two concurrent same-URL requests distinct nonces', async () => {
    usePanelStore.setState({ panels: { s1: [browserPanel('b1', 's1', 'https://same')] } });
    const releases: Array<() => void> = [];
    panelApi.updatePanel.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve()); }));

    const first = openUrlInSessionBrowser('s1', 'https://same', {}, panelApi);
    const second = openUrlInSessionBrowser('s1', 'https://same', {}, panelApi);
    const nonces = panelApi.updatePanel.mock.calls.map(([, updates]) => {
      // SAFETY: the helper always writes BrowserPanelState into customState.
      const customState = updates.state?.customState as { navigationNonce?: number } | undefined;
      return customState?.navigationNonce;
    });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const release of releases) release();
    await Promise.all([first, second]);
  });

  it('creates a Browser panel titled by host when none exists and activates it once', async () => {
    const result = await openUrlInSessionBrowser('s2', 'https://example.com/path', {}, panelApi);

    expect(result).toEqual({ panelId: 'created', created: true });
    expect(panelApi.createPanel).toHaveBeenCalledWith({
      sessionId: 's2',
      type: 'browser',
      title: 'example.com',
      initialState: { customState: { currentUrl: 'https://example.com/path' } },
    });
    expect(panelApi.updatePanel).not.toHaveBeenCalled();
    expect(panelApi.setActivePanel).toHaveBeenCalledTimes(1);
    // The panel:created broadcast (handled by SessionView) adds it to the store and layout.
    expect(usePanelStore.getState().panels.s2).toBeUndefined();
    expect(usePanelStore.getState().activePanels.s2).toBe('created');
  });

  it('retitles an existing panel only when asked (HTML previews)', async () => {
    usePanelStore.setState({ panels: { s1: [browserPanel('b1', 's1', 'https://old')] } });
    await openUrlInSessionBrowser('s1', 'file:///tmp/index.html', { title: 'index.html', retitleExisting: true }, panelApi);
    expect(panelApi.updatePanel.mock.calls[0][1]).toMatchObject({ title: 'index.html' });
    expect(usePanelStore.getState().panels.s1[0].title).toBe('index.html');
  });
});

describe('canHostSessionBrowser', () => {
  it('allows ordinary worktree sessions only', () => {
    expect(canHostSessionBrowser({ id: 'w1' })).toBe(true);
    expect(canHostSessionBrowser({ id: 'w1', isMainRepo: false })).toBe(true);
    expect(canHostSessionBrowser({ id: 'main', isMainRepo: true })).toBe(false);
    expect(canHostSessionBrowser({ id: '__pane_chat_session__' })).toBe(false);
    expect(canHostSessionBrowser(null)).toBe(false);
    expect(canHostSessionBrowser(undefined)).toBe(false);
  });
});

describe('resolveBrowserNavigation', () => {
  it('navigates on a new URL, reloads on a new nonce for the same URL, otherwise no-ops', () => {
    expect(resolveBrowserNavigation({ url: '', nonce: undefined }, { currentUrl: 'https://a' })).toBe('navigate');
    expect(resolveBrowserNavigation({ url: 'https://a', nonce: undefined }, { currentUrl: 'https://b' })).toBe('navigate');
    expect(resolveBrowserNavigation({ url: 'https://a', nonce: 1 }, { currentUrl: 'https://a', nonce: 2 })).toBe('reload');
    expect(resolveBrowserNavigation({ url: 'https://a', nonce: 2 }, { currentUrl: 'https://a', nonce: 2 })).toBe('none');
    expect(resolveBrowserNavigation({ url: 'https://a', nonce: 2 }, { currentUrl: 'https://a' })).toBe('none');
    expect(resolveBrowserNavigation({ url: 'https://a', nonce: undefined }, {})).toBe('none');
  });
});
