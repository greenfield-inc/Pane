import { describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { logsManager } from './panels/logPanel/logsManager';
import { ChatTabManager } from './chatTabs/manager';
import { chatPanelIdsOf, pausePanes, terminalPanelIdsOf } from './panePause';

// SAFETY: The tested functions read only a panel's id and type.
const panel = (id: string, type: ToolPanel['type']) => ({ id, type }) as ToolPanel;

describe('manual Pause and chat tabs (D-187)', () => {
  it('counts chat tabs apart from the terminal tabs a pause stops', () => {
    vi.spyOn(panelManager, 'getPanelsForSession').mockImplementation(paneId => paneId === 'session-chat'
      ? [panel('orchestrator', 'chat')]
      : [panel('worker', 'terminal'), panel('side-chat', 'chat'), panel('files', 'explorer')]);
    expect(chatPanelIdsOf(['session-chat', 'pane'])).toEqual(['orchestrator', 'side-chat']);
    expect(terminalPanelIdsOf(['session-chat', 'pane'])).toEqual(['worker']);
  });

  it('pauses a Pane\'s terminal tabs and leaves its chat tabs running', async () => {
    vi.spyOn(panelManager, 'getPanelsForSession').mockReturnValue([panel('worker', 'terminal'), panel('side-chat', 'chat')]);
    vi.spyOn(logsManager, 'getRunningProcess').mockResolvedValue(undefined);
    vi.spyOn(logsManager, 'isRunning').mockResolvedValue(false);
    const chatPause = vi.spyOn(ChatTabManager.prototype, 'pause');
    const pausePanels = vi.spyOn(terminalPanelManager, 'pausePanels').mockResolvedValue({ paused: ['worker'], failed: [] });
    // SAFETY: No run script is running, so the registry is never called.
    const registry = {} as PaneCommandRegistry;
    const mark = { at: '2026-11-13T00:00:00.000Z', by: 'manual' as const };

    expect(await pausePanes(registry, ['pane'], mark)).toEqual({ paused: ['worker'], failed: [] });
    expect(pausePanels).toHaveBeenCalledWith(['worker'], mark);
    expect(chatPause).not.toHaveBeenCalled();
  });
});
