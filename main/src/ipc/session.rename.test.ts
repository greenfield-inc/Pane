import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { Session as DbSession, UpdateSessionData } from '../database/models';
import { SessionManager } from '../services/sessionManager';
import type { AppServices } from './types';
import { registerSessionHandlers } from './session';

const originalSession: DbSession = {
  id: 'session-1',
  name: 'Original label',
  initial_prompt: '',
  worktree_name: 'feature-branch',
  worktree_path: '/repo/worktrees/feature-branch',
  status: 'stopped',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  base_branch: 'main',
};

describe('sessions:rename', () => {
  let row: DbSession | undefined;
  let updateSession: ReturnType<typeof vi.fn>;
  let emitSessionUpdated: ReturnType<typeof vi.fn>;
  let registry: PaneCommandRegistry;

  beforeEach(() => {
    row = { ...originalSession };
    updateSession = vi.fn((id: string, update: UpdateSessionData) => {
      if (!row || id !== row.id) return undefined;
      row = { ...row, ...update };
      return row;
    });
    const databaseService = {
      getSession: vi.fn((id: string) => id === row?.id ? row : undefined),
      updateSession,
    };
    // SAFETY: This database fixture implements the only DatabaseService methods exercised by rename.
    const sessionManager = new SessionManager(databaseService as never);
    emitSessionUpdated = vi.fn();
    sessionManager.on('session-updated', emitSessionUpdated);

    registry = new PaneCommandRegistry();
    // SAFETY: These fixtures supply the IPC and AppServices members exercised by sessions:rename.
    registerSessionHandlers(
      { handle: vi.fn() } as never,
      ({
        databaseService,
        sessionManager,
        gitStatusManager: { getCachedStatus: vi.fn() },
      }) as AppServices,
      registry,
    );
  });

  it('trims and writes only the display name and provenance bit', async () => {
    const result = await registry.invoke('sessions:rename', ['session-1', '  Human label  ']);

    expect(result).toMatchObject({
      success: true,
      data: { name: 'Human label', name_manually_set: true },
    });
    expect(updateSession).toHaveBeenCalledOnce();
    expect(updateSession).toHaveBeenCalledWith('session-1', {
      name: 'Human label',
      name_manually_set: true,
    });
    expect(row).toMatchObject({
      worktree_name: 'feature-branch',
      worktree_path: '/repo/worktrees/feature-branch',
      base_branch: 'main',
    });
    expect(emitSessionUpdated).toHaveBeenCalledOnce();
    expect(emitSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Human label',
      nameManuallySet: true,
    }));
  });

  it.each(['', '   '])('rejects a blank name without side effects', async (name) => {
    const result = await registry.invoke('sessions:rename', ['session-1', name]);

    expect(result).toEqual({ success: false, error: 'Pane name cannot be blank' });
    expect(updateSession).not.toHaveBeenCalled();
    expect(emitSessionUpdated).not.toHaveBeenCalled();
  });

  it('returns not found without writing or emitting', async () => {
    row = undefined;

    const result = await registry.invoke('sessions:rename', ['missing', 'New label']);

    expect(result).toEqual({ success: false, error: 'Session not found' });
    expect(updateSession).not.toHaveBeenCalled();
    expect(emitSessionUpdated).not.toHaveBeenCalled();
  });

  it('does not expose unexpected rename errors', async () => {
    updateSession.mockImplementationOnce(() => {
      throw new Error('database connection details');
    });

    const result = await registry.invoke('sessions:rename', ['session-1', 'New label']);

    expect(result).toEqual({ success: false, error: 'Failed to rename session' });
  });
});
