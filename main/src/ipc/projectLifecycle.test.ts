import type { IpcMain } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { scriptExecutionTracker } from '../services/scriptExecutionTracker';
import type { AppServices } from './types';
import { registerProjectHandlers } from './project';

afterEach(() => {
  scriptExecutionTracker.stop('session', 'pane');
  scriptExecutionTracker.stop('project', 1);
});

it.each(['session', 'project'] as const)('stops the %s logs process before deleting its worktree', async type => {
  const project = { id: 1, name: 'Repo', path: '/isolated/repo' };
  const session = { id: 'pane', project_id: 1, worktree_name: 'feature', worktree_path: '/isolated/worktree' };
  const runningPanels = new Set(['logs']);
  let removedWhileRunning: boolean | undefined;
  // SAFETY: The fixture provides each repository and process boundary used by projects:delete.
  const services = {
    databaseService: {
      getProject: () => project,
      getAllSessionsIncludingArchived: () => [session],
      getAllSessions: () => [session],
      deleteProject: () => true,
    },
    sessionManager: {
      hasTerminalSession: () => false,
      getProjectContextByProjectId: () => ({ project }),
      invalidateProjectContext: () => {},
    },
    worktreeManager: {
      removeWorktree: async () => { removedWhileRunning = runningPanels.has('logs'); },
    },
  } as AppServices;
  // SAFETY: This registry test only needs IpcMain.handle for channel binding.
  const ipc = { handle: vi.fn() } as IpcMain;
  const registry = new PaneCommandRegistry();
  registerProjectHandlers(ipc, services, registry, {
    getPanelsForSession: async () => [{ id: 'logs', type: 'logs' }],
    stopScript: async panelId => { runningPanels.delete(panelId); },
  });
  scriptExecutionTracker.start(type, type === 'session' ? 'pane' : 1, 'pane');
  await expect(registry.invoke('projects:delete', ['1'])).resolves.toMatchObject({ success: true });
  expect(removedWhileRunning).toBe(false);
});
