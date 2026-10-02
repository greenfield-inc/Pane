import { afterEach, expect, it, vi } from 'vitest';
import { panelApi } from './panelApi';
import type { ToolPanel } from '../../../shared/types/panels';

afterEach(() => vi.unstubAllGlobals());

it('refetches delayed outgoing panel responses after a host switch', async () => {
  const outgoing: ToolPanel = {
    id: 'same-panel', sessionId: 'same-session', type: 'browser', title: 'Old host',
    state: { isActive: true, customState: { currentUrl: 'file:///old/index.html' } },
    metadata: { createdAt: '', lastActiveAt: '', position: 0 },
  };
  const incoming = { ...outgoing, title: 'New host', state: { ...outgoing.state, customState: { currentUrl: 'file:///new/index.html' } } };
  let releaseOld!: (value: { success: boolean; data: ToolPanel[] }) => void;
  const getSessionPanels = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
    .mockResolvedValue({ success: true, data: [incoming] });
  vi.stubGlobal('window', { electronAPI: { panels: { getSessionPanels } } });
  const oldLoad = panelApi.loadPanelsForSession('same-session');
  panelApi.invalidateHostLoads();
  await expect(panelApi.loadPanelsForSession('same-session')).resolves.toEqual([incoming]);
  releaseOld({ success: true, data: [outgoing] });
  await expect(oldLoad).resolves.toEqual([incoming]);
  expect(getSessionPanels).toHaveBeenCalledTimes(3);
});
