import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';

function editor(id: string, filePath: string): ToolPanel {
  // SAFETY: openFileInEditor reads only id, type, session and editor state.
  return { id, sessionId: 'pane-p', type: 'editor', title: filePath, state: { isActive: false, customState: { filePath, isPreview: false } }, metadata: {} } as ToolPanel;
}

describe('openFileInEditor', () => {
  const savePaneLayout = vi.fn(() => Promise.resolve({ success: true }));

  beforeEach(() => {
    vi.resetModules();
    savePaneLayout.mockClear();
    vi.stubGlobal('window', {
      dispatchEvent: () => true,
      electronAPI: {
        invoke: () => Promise.resolve({ success: true }),
        panels: { setActivePanel: () => Promise.resolve({ success: true }) },
        uiState: { savePaneLayout },
      },
    });
  });

  it('remembers on this desktop the editor tab it reveals', async () => {
    const [{ openFileInEditor }, { usePanelStore }, { useConfigStore }] = await Promise.all([
      import('./openFileInEditor'),
      import('../stores/panelStore'),
      import('../stores/configStore'),
    ]);
    // SAFETY: Layout memory reads only remoteDaemon to name the host; a local host has no profile.
    useConfigStore.setState({ config: { remoteDaemon: { client: { mode: 'local', activeProfileId: null, profiles: [] } } } as never });
    const layout: SessionPanelLayout = { version: 1, root: { type: 'group', id: 'g1', panelIds: ['a', 'b'], activePanelId: 'a' }, focusedGroupId: 'g1' };
    usePanelStore.setState({ panels: { 'pane-p': [editor('a', '/repo/a.ts'), editor('b', '/repo/b.ts')] }, layouts: { 'pane-p': layout } });

    await openFileInEditor({ sessionId: 'pane-p', filePath: '/repo/b.ts' });

    expect(savePaneLayout).toHaveBeenCalledWith(null, 'pane-p', expect.objectContaining({
      root: expect.objectContaining({ activePanelId: 'b' }),
    }));
  });
});
