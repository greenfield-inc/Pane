import { afterAll, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database';
import { panelManager } from './panelManager';
import { getPaneEventSink } from '../core/runtime';
import type { ToolPanel } from '../../../shared/types/panels';
import { logsManager } from './panels/logPanel/logsManager';

function createSession(id: string): void {
  databaseService.createSession({
    id, name: id, initial_prompt: '', worktree_name: id,
    worktree_path: process.env.PANE_DIR!, project_id: null, tool_type: 'none',
  });
}

afterAll(() => databaseService.close());

describe('panel state persistence', () => {
  it('keeps the first script running and stoppable through panel activation', async () => {
    createSession('first-script');
    const command = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
    let latestUpdate: ToolPanel | undefined;
    const send = vi.spyOn(getPaneEventSink(), 'send').mockImplementation((channel, ...args) => {
      if (channel === 'panel:updated') {
        // SAFETY: panel:updated publishes a ToolPanel on the renderer boundary.
        latestUpdate = structuredClone(args[0]) as ToolPanel;
      }
    });
    let panelId: string | undefined;
    try {
      await logsManager.runScript('first-script', command, process.env.PANE_DIR!);
      const panel = panelManager.getPanelsForSession('first-script')[0];
      panelId = panel.id;
      expect(latestUpdate?.state.customState).toMatchObject({ isRunning: true, command });
      expect(await logsManager.isRunning('first-script')).toBe(true);
      expect(panel.state.customState).toMatchObject({ isRunning: true, command });
      expect(await logsManager.getRunningProcess('first-script')).toBeDefined();
      await logsManager.stopScript(panel.id);
      await expect.poll(() => logsManager.isRunning('first-script')).toBe(false);
    } finally {
      if (panelId) {
        await logsManager.stopScript(panelId);
        await expect.poll(() => logsManager.isRunning('first-script')).toBe(false);
      }
      send.mockRestore();
    }
  });

  it('merges partial writes and explicit removals consistently for live and restored panels', async () => {
    createSession('panel-merge');
    const panel = await panelManager.createPanel({
      sessionId: 'panel-merge', type: 'browser', initialState: { isPopup: true, currentUrl: 'https://example.com' },
    });
    await panelManager.updatePanel(panel.id, { state: { isActive: true, hasBeenViewed: true } });
    await panelManager.updatePanel(panel.id, {
      state: { isActive: true, customState: { currentUrl: 'https://example.org', isPopup: undefined } },
    });
    const expected = { isActive: true, hasBeenViewed: true, customState: { currentUrl: 'https://example.org' } };
    expect(panelManager.getPanel(panel.id)?.state).toEqual(expected);
    expect(databaseService.getPanel(panel.id)?.state).toEqual(expected);
  });

  it('keeps a created panel current across listing and activation', async () => {
    createSession('panel-identity');
    const panel = await panelManager.createPanel({ sessionId: 'panel-identity', type: 'logs' });
    await panelManager.updatePanel(panel.id, {
      state: { isActive: true, customState: { isRunning: true, command: 'sleep 60' } },
    });
    await panelManager.setActivePanel('panel-identity', panel.id);
    expect(panel.state.customState).toEqual({ isRunning: true, command: 'sleep 60' });
    expect(panelManager.getPanelsForSession('panel-identity')[0]).toBe(panel);
  });
});
