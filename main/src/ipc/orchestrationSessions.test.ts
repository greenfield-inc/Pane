import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerOrchestrationSessionHandlers } from './orchestrationSessions';
import type { AppServices } from './types';

describe('orchestration-sessions:create', () => {
  it('passes a requested pin through to the new Session', async () => {
    const create = vi.fn(async () => ({}));
    const registry = new PaneCommandRegistry();
    registerOrchestrationSessionHandlers(
      // SAFETY: The handlers only call ipcMain.handle, and this test invokes the registry directly.
      { handle: () => undefined } as IpcMain,
      // SAFETY: The create channel reads only orchestrationSessionManager.create.
      { orchestrationSessionManager: { create } } as AppServices,
      registry,
    );

    await registry.invokeRemote('orchestration-sessions:create', [{ name: 'Release prep', agent: 'codex', isPinned: true }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Release prep', isPinned: true }));
  });
});
