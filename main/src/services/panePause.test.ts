import { describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import { panelManager } from './panelManager';
import { chatPanelIdsOf, chatTabsNotPausedNote, terminalPanelIdsOf } from './panePause';

describe('what a pause says about chat tabs (D-187)', () => {
  it('says plainly that chat tabs keep running, and says nothing when there are none', () => {
    expect(chatTabsNotPausedNote(0)).toBe('');
    expect(chatTabsNotPausedNote(1)).toContain('1 chat tab was not paused');
    expect(chatTabsNotPausedNote(1)).toContain('their agents keep running');
    expect(chatTabsNotPausedNote(3)).toContain('3 chat tabs were not paused');
  });

  it('counts chat tabs apart from the terminal tabs a pause stops', () => {
    // SAFETY: The tested functions read only a panel's id and type.
    const panel = (id: string, type: ToolPanel['type']) => ({ id, type }) as ToolPanel;
    vi.spyOn(panelManager, 'getPanelsForSession').mockImplementation(paneId => paneId === 'session-chat'
      ? [panel('orchestrator', 'chat')]
      : [panel('worker', 'terminal'), panel('side-chat', 'chat'), panel('files', 'explorer')]);
    expect(chatPanelIdsOf(['session-chat', 'pane'])).toEqual(['orchestrator', 'side-chat']);
    expect(terminalPanelIdsOf(['session-chat', 'pane'])).toEqual(['worker']);
  });
});
