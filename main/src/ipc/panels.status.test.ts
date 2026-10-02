import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { Session } from '../types/session';
import type { ToolPanel } from '../../../shared/types/panels';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { registerPanelHandlers } from './panels';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested handlers.
  return value as Contract;
}
const panel = (id: string, sessionId: string): ToolPanel => ({
  id, sessionId, type: 'terminal', title: id, state: { isActive: false },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});

afterEach(() => vi.restoreAllMocks());

describe('panel status snapshot IPC', () => {
  it('includes background shells, stopped terminals, and hidden Pane Chat with current monitor states', async () => {
    vi.spyOn(panelManager, 'getPanelsForSession').mockImplementation(sessionId => sessionId === PANE_CHAT_SESSION_ID
      ? [panel('chat', sessionId)]
      : [panel('agent', sessionId), panel('shell', sessionId), panel('stopped', sessionId)]);
    vi.spyOn(terminalPanelManager, 'getAgentStatus').mockImplementation(panelId => {
      if (panelId === 'agent') return 'working';
      if (panelId === 'chat') return 'blocked';
      return undefined;
    });
    vi.spyOn(terminalPanelManager, 'isTerminalInitialized').mockImplementation(panelId => panelId !== 'stopped');
    const services = partial<AppServices>({ sessionManager: partial<AppServices['sessionManager']>({
      getAllSessions: () => [partial<Session>({ id: 'background', archived: false })],
    }) });
    const registry = new PaneCommandRegistry();
    const handle = vi.fn();
    registerPanelHandlers(partial<IpcMain>({ handle }), services, registry);
    expect(handle).toHaveBeenCalledWith('panels:agent-statuses', expect.any(Function));
    await expect(registry.invoke('panels:agent-statuses')).resolves.toEqual({ success: true, data: [
      { panelId: 'agent', sessionId: 'background', state: 'working', reason: null },
      { panelId: 'shell', sessionId: 'background', state: 'unknown', reason: null },
      { panelId: 'stopped', sessionId: 'background', state: 'unknown', reason: null },
      { panelId: 'chat', sessionId: PANE_CHAT_SESSION_ID, state: 'blocked', reason: null },
    ] });
  });
});

describe('panel deletion IPC', () => {
  it('awaits terminal teardown without saving a snapshot before deleting the row', async () => {
    vi.spyOn(panelManager, 'getPanel').mockReturnValue(panel('p', 's'));
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const destroy = vi.spyOn(terminalPanelManager, 'destroyTerminal').mockReturnValue(pending);
    const remove = vi.spyOn(panelManager, 'deletePanel').mockResolvedValue();
    const registry = new PaneCommandRegistry();
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    const deleting = registry.invoke('panels:delete', 'p');
    expect(destroy).toHaveBeenCalledWith('p', { saveState: false });
    expect(remove).not.toHaveBeenCalled();
    release();
    await expect(deleting).resolves.toEqual({ success: true });
    expect(remove).toHaveBeenCalledWith('p');
  });
});
