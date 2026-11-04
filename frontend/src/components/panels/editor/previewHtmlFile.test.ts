import { describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../../shared/types/panels';
import type { BrowserNavigateRequest } from '../browser/browserNavigation';

const pageUrl = 'file:///repo/wt/site/index.html';
const browserTab: ToolPanel = {
  id: 'tab-1',
  sessionId: 'session',
  type: 'browser',
  title: 'index.html',
  state: { isActive: false, customState: { currentUrl: pageUrl } },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
};

async function setup() {
  vi.resetModules();
  const requests: BrowserNavigateRequest[] = [];
  // The Electron calls a preview makes: opening the file's tab and focusing it.
  const electronAPI = {
    invoke: (channel: string) => Promise.resolve(channel === 'panels:open-html-file' ? { success: true, data: browserTab } : { success: false }),
    panels: { setActivePanel: () => Promise.resolve({ success: true }) },
  };
  const events = Object.assign(new EventTarget(), { electronAPI });
  vi.stubGlobal('window', events);
  const { BROWSER_NAVIGATE_EVENT } = await import('../browser/browserNavigation');
  events.addEventListener(BROWSER_NAVIGATE_EVENT, (e) => {
    // SAFETY: requestBrowserNavigation is the only sender of this event.
    requests.push((e as CustomEvent<BrowserNavigateRequest>).detail);
  });
  const [{ previewHtmlFileInBrowser }, { usePanelStore }] = await Promise.all([
    import('./previewHtmlFile'),
    import('../../../stores/panelStore'),
  ]);
  return { previewHtmlFileInBrowser, usePanelStore, requests };
}

describe('previewHtmlFileInBrowser', () => {
  it('asks the tab already showing the file to reload, so a saved edit appears', async () => {
    const { previewHtmlFileInBrowser, usePanelStore, requests } = await setup();
    usePanelStore.getState().addPanel(browserTab);

    await previewHtmlFileInBrowser('session', 'site/index.html');

    expect(requests).toEqual([{ url: pageUrl, sessionId: 'session', panelId: 'tab-1' }]);
  });

  it('leaves a newly opened tab to its own first load', async () => {
    const { previewHtmlFileInBrowser, requests } = await setup();

    await previewHtmlFileInBrowser('session', 'site/index.html');

    expect(requests).toEqual([]);
  });
});
