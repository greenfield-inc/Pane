import fs from 'fs';
import os from 'os';
import path from 'path';
import SQLite from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database';
import { SessionManager } from '../services/sessionManager';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { registerSessionHandlers } from './session';
import { registerRunpaneHandlers } from './runpane';

let directory: string;
let db: DatabaseService;
let manager: SessionManager;
let services: AppServices;
let registry: PaneCommandRegistry;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-session-metadata-'));
  const databasePath = path.join(directory, 'sessions.db');
  db = new DatabaseService(databasePath);
  db.initialize();
  const project = db.createProject('Repo', directory);
  db.createSession({ id: 'pane', name: 'Original', initial_prompt: '', worktree_name: '', worktree_path: directory, project_id: project.id, tool_type: 'none' });
  const fixture = new SQLite(databasePath);
  fixture.prepare("UPDATE sessions SET updated_at = '2020-01-02 03:04:05' WHERE id = 'pane'").run();
  fixture.close();
  manager = new SessionManager(db);
  // SAFETY: These public handlers only use the supplied services in this fixture.
  services = { sessionManager: manager, databaseService: db, workspaceJournal: new WorkspaceJournal(), archiveProgressManager: new ArchiveProgressManager() } as AppServices;
  registry = new PaneCommandRegistry();
  // SAFETY: Registration only needs the IPC handle boundary; invocation uses the real registry.
  registerSessionHandlers({ handle: vi.fn() } as never, services, registry);
  // SAFETY: RunPane handlers register with the registry and do not access Electron IPC.
  registerRunpaneHandlers({} as never, services, registry);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await manager.cleanup();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('session metadata through UI and CLI commands', () => {
  it('rejects blank names through both paths without writing or emitting', async () => {
    const event = vi.fn();
    manager.on('session-updated', event);
    expect(await registry.invoke('sessions:rename', ['pane', '   '])).toMatchObject({ success: false });
    await expect(registry.invoke('runpane:panes:rename', [{ paneId: 'pane', name: '   ' }])).rejects.toThrow(/non-empty/);
    expect(db.getSession('pane')?.name).toBe('Original');
    expect(event).not.toHaveBeenCalled();
  });

  it('publishes persisted rename metadata once from each command', async () => {
    const event = vi.fn();
    manager.on('session-updated', event);
    for (const [channel, args] of [
      ['sessions:rename', ['pane', '  UI name  ']],
      ['runpane:panes:rename', [{ paneId: 'pane', name: 'CLI name' }]],
    ] as const) {
      await registry.invoke(channel, args);
      const stored = db.getSession('pane');
      const session = manager.getSession('pane');
      expect(session?.name).toBe(channel === 'sessions:rename' ? 'UI name' : 'CLI name');
      expect(session?.lastActivity).toEqual(new Date(stored!.updated_at));
      expect(event).toHaveBeenLastCalledWith(session);
    }
    expect(event).toHaveBeenCalledTimes(2);
  });

  it('pins idempotently with persisted timestamps without changing activity', async () => {
    const event = vi.fn();
    manager.on('session-updated', event);
    const ui = await registry.invoke('sessions:toggle-favorite', ['pane']);
    const pinnedAt = db.getSession('pane')?.favorite_pinned_at;
    expect(pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(ui).toMatchObject({ success: true, data: { isFavorite: true, favoritePinnedAt: pinnedAt } });
    const cli = await registry.invoke('runpane:panes:pin', [{ paneId: 'pane', pinned: true }]);
    expect(cli).toMatchObject({ ok: true, pinned: true, favoritePinnedAt: pinnedAt });
    expect(db.getSession('pane')?.updated_at).toBe('2020-01-02 03:04:05');
    expect(manager.getSession('pane')?.favoritePinnedAt).toBe(pinnedAt);
    expect(event).toHaveBeenCalledTimes(2);
    expect(event).toHaveBeenLastCalledWith(manager.getSession('pane'));
    await registry.invoke('runpane:panes:pin', [{ paneId: 'pane', pinned: false }]);
    expect(db.getSession('pane')?.favorite_pinned_at).toBeNull();
    expect(manager.getSession('pane')?.favoritePinnedAt).toBeUndefined();
  });

  it('persists run timestamps and publishes resolved values rather than SQL sentinels', () => {
    const event = vi.fn();
    manager.on('session-updated', event);
    manager.updateSession('pane', { run_started_at: '2026-01-02 03:04:05' });
    expect(db.getSession('pane')?.run_started_at).toBe('2026-01-02 03:04:05');
    expect(manager.getSession('pane')?.runStartedAt).toBe('2026-01-02 03:04:05');
    manager.updateSession('pane', { run_started_at: 'CURRENT_TIMESTAMP' });
    expect(manager.getSession('pane')?.runStartedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(event.mock.lastCall?.[0]).not.toHaveProperty('run_started_at');
    manager.updateSession('pane', { run_started_at: null });
    expect(db.getSession('pane')?.run_started_at).toBeNull();
    expect(manager.getSession('pane')?.runStartedAt).toBeNull();
  });

  it.each([
    { reason: 'empty worktree name', worktree_name: '', is_main_repo: false, worktree_ownership: 'pane' },
    { reason: 'main repository', worktree_name: 'named', is_main_repo: true, worktree_ownership: 'pane' },
    { reason: 'external worktree', worktree_name: 'named', is_main_repo: false, worktree_ownership: 'external' },
  ] as const)('skips cleanup waiting for $reason', async ({ reason: _reason, ...ownership }) => {
    db.createSession({
      id: 'archive-pane', name: 'Archive', initial_prompt: '', worktree_path: directory,
      project_id: db.getSession('pane')!.project_id, tool_type: 'none', ...ownership,
    });
    const archiveRegistry = new PaneCommandRegistry();
    // SAFETY: RunPane handlers do not access the Electron IPC argument.
    registerRunpaneHandlers({} as never, services, archiveRegistry);
    archiveRegistry.register('sessions:delete', async () => ({ success: true }));
    vi.spyOn(manager, 'getProjectContext').mockReturnValue(null);
    vi.useFakeTimers();
    const pending = archiveRegistry.invoke('runpane:panes:archive', [{ paneId: 'archive-pane', force: true }]);
    const result = Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still waiting'), 10))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ ok: true, archived: true, worktreeCleanup: 'not-applicable', safetyCheck: { performed: false } });
    await vi.runAllTimersAsync();
  });
});
