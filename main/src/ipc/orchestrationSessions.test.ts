import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerOrchestrationSessionHandlers } from './orchestrationSessions';
import { PaneError } from '../../../shared/paneError';
import type { AppServices } from './types';

describe('orchestration-sessions:create', () => {
  it('passes a requested pin and blank-name intent through to the new Session', async () => {
    const create = vi.fn(async () => ({}));
    const registry = new PaneCommandRegistry();
    registerOrchestrationSessionHandlers(
      // SAFETY: The handlers only call ipcMain.handle, and this test invokes the registry directly.
      { handle: () => undefined } as IpcMain,
      // SAFETY: The create channel reads only orchestrationSessionManager.create.
      { orchestrationSessionManager: { create } } as AppServices,
      registry,
    );

    await registry.invokeRemote('orchestration-sessions:create', [{ name: 'New chat', nameFromFirstMessage: true, agent: 'codex', isPinned: true }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'New chat', nameFromFirstMessage: true, isPinned: true }));
  });
});

describe('orchestration-sessions:reorder', () => {
  function registerWith(reorder: (sessionIds: string[]) => Promise<object>): PaneCommandRegistry {
    const registry = new PaneCommandRegistry();
    registerOrchestrationSessionHandlers(
      // SAFETY: The handlers only call ipcMain.handle, and this test invokes the registry directly.
      { handle: () => undefined } as IpcMain,
      // SAFETY: The reorder channel reads only orchestrationSessionManager.reorder.
      { orchestrationSessionManager: { reorder } } as AppServices,
      registry,
    );
    return registry;
  }

  it('passes the requested order to the host and returns the reordered list', async () => {
    const reorder = vi.fn(async () => ({ sessions: [] }));

    const result = await registerWith(reorder).invokeRemote('orchestration-sessions:reorder', [{ sessionIds: ['b', 'a'] }]);

    expect(reorder).toHaveBeenCalledWith(['b', 'a']);
    expect(result).toEqual({ success: true, data: { sessions: [] } });
  });

  it('keeps the next step of a Pane error', async () => {
    const reorder = vi.fn(async () => {
      throw new PaneError('ERR_SESSION_ORDER_TOO_LONG', 'Too many Sessions.', 'Send fewer.');
    });

    const result = await registerWith(reorder).invokeRemote('orchestration-sessions:reorder', [{ sessionIds: ['a'] }]);

    expect(result).toEqual({ success: false, error: 'Too many Sessions. Next: Send fewer.' });
  });
});

describe('orchestration-sessions:update', () => {
  it('names every problem in an update payload at once and leaves the Session alone', async () => {
    const update = vi.fn(async () => ({}));
    const registry = new PaneCommandRegistry();
    registerOrchestrationSessionHandlers(
      // SAFETY: The handlers only call ipcMain.handle, and this test invokes the registry directly.
      { handle: () => undefined } as IpcMain,
      // SAFETY: The update channel reads only orchestrationSessionManager.update.
      { orchestrationSessionManager: { update } } as AppServices,
      registry,
    );

    const result = await registry.invokeRemote('orchestration-sessions:update', [
      { sessionId: 'coordinator' },
      { outputs: [{}], evidence: [{ label: 'x', url: 'ftp://x', addedAt: 'now' }], decisions: [1] },
    ]);

    for (const part of [
      'The Session update payload has 6 problems: decisions[0]: expected string;',
      'outputs[0].label: missing; outputs[0].url: missing; outputs[0].addedAt: missing. Nothing was changed.',
      'Next: Fix every field listed',
    ]) {
      expect(result).toMatchObject({ success: false, error: expect.stringContaining(part) });
    }
    expect(update).not.toHaveBeenCalled();
  });
});
