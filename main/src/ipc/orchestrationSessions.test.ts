import type { IpcMain } from 'electron';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerOrchestrationSessionHandlers } from './orchestrationSessions';
import { SessionSnapshotService } from '../services/sessionSnapshots';
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

    expect(create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ name: 'New chat', nameFromFirstMessage: true, isPinned: true }));
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

    expect(reorder).toHaveBeenCalledWith(['b', 'a'], { summary: false });
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

describe('the Session list channels (T-127)', () => {
  type ListingManager = Partial<Record<'list' | 'select' | 'reorder', Mock>>;

  function registerWith(manager: ListingManager): PaneCommandRegistry {
    const registry = new PaneCommandRegistry();
    registerOrchestrationSessionHandlers(
      // SAFETY: The handlers only call ipcMain.handle, and this test invokes the registry directly.
      { handle: () => undefined } as IpcMain,
      // SAFETY: These channels read only the manager's list, select and reorder.
      { orchestrationSessionManager: manager } as AppServices,
      registry,
    );
    return registry;
  }

  it('passes a summary request through to list, select and reorder', async () => {
    const answer = async () => ({ sessions: [] });
    const manager = { list: vi.fn(answer), select: vi.fn(answer), reorder: vi.fn(answer) };
    const registry = registerWith(manager);

    await registry.invokeRemote('orchestration-sessions:list', [{ summary: true }]);
    await registry.invokeRemote('orchestration-sessions:select', [{ sessionId: 's1' }, { summary: true }]);
    await registry.invokeRemote('orchestration-sessions:reorder', [{ sessionIds: ['a'] }, { summary: true }]);

    expect(manager.list).toHaveBeenCalledWith({ summary: true });
    expect(manager.select).toHaveBeenCalledWith({ sessionId: 's1' }, { summary: true });
    expect(manager.reorder).toHaveBeenCalledWith(['a'], { summary: true });
  });

  it('asks for full records when a caller sends no options, or options it does not understand', async () => {
    const list = vi.fn(async () => ({ sessions: [] }));
    const registry = registerWith({ list });

    await registry.invokeRemote('orchestration-sessions:list', []);
    await registry.invokeRemote('orchestration-sessions:list', ['summary']);

    expect(list.mock.calls).toEqual([[{ summary: false }], [{ summary: false }]]);
  });
});

describe('orchestration-sessions:snapshots', () => {
  /** A host with one chat Session; `snapshots` is a spy on the real service's read. */
  function host() {
    const service = new SessionSnapshotService({
      sessions: async () => [],
      tabs: () => [],
      panel: () => undefined,
      layout: () => null,
      chat: () => undefined,
      announce: () => undefined,
    });
    const snapshots = vi.spyOn(service, 'snapshots');
    const registry = new PaneCommandRegistry();
    registerOrchestrationSessionHandlers(
      // SAFETY: The handlers only call ipcMain.handle, and this test invokes the registry directly.
      { handle: () => undefined } as IpcMain,
      // SAFETY: The snapshots channel reads only sessionSnapshots.
      { sessionSnapshots: service } as AppServices,
      registry,
    );
    return { registry, snapshots };
  }

  it('answers the machine\'s owner with the snapshots newer than since', async () => {
    const { registry, snapshots } = host();
    snapshots.mockResolvedValue({ revision: 7, sessionIds: ['a'], snapshots: [] });

    const result = await registry.invokeRemote('orchestration-sessions:snapshots', [{ since: 5, held: { a: { generation: 2, count: 40 } } }]);

    expect(snapshots).toHaveBeenCalledWith({ since: 5, held: { a: { generation: 2, count: 40 } } });
    expect(result).toEqual({ success: true, data: { revision: 7, sessionIds: ['a'], snapshots: [] } });
  });

  it('reads everything when asked with no arguments', async () => {
    const { registry, snapshots } = host();

    await registry.invokeRemote('orchestration-sessions:snapshots', []);

    expect(snapshots).toHaveBeenCalledWith({});
  });

  it('refuses a teammate on a shared tailnet and reads nothing', async () => {
    const { registry, snapshots } = host();

    const result = await registry.invokeRemote('orchestration-sessions:snapshots', [{}], { teammate: 'sam@example.com' });

    expect(snapshots).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: expect.stringContaining('Only this computer\'s owner') });
  });

  it('refuses a device paired Read only and reads nothing', async () => {
    const { registry, snapshots } = host();

    const result = await registry.invokeRemote('orchestration-sessions:snapshots', [{}], { readOnly: true });

    expect(snapshots).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: expect.stringContaining('Only this computer\'s owner') });
  });

  it('names a malformed request and reads nothing', async () => {
    const { registry, snapshots } = host();

    const result = await registry.invokeRemote('orchestration-sessions:snapshots', [{ since: 'yesterday' }]);

    expect(snapshots).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: expect.stringContaining('since') });
  });
});
