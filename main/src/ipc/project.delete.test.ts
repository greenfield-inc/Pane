import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';

const mocks = vi.hoisted(() => ({
  forgetProjectLaunchState: vi.fn(),
  getRunningScript: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The deletion boundary must pin cancellation ordering around teardown and persistence.
vi.mock('../services/workspaceEntry', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/workspaceEntry')>();
  return { ...actual, forgetProjectLaunchState: mocks.forgetProjectLaunchState };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Running scripts are unrelated to launch-state cancellation ordering.
vi.mock('../services/scriptExecutionTracker', () => ({
  scriptExecutionTracker: { getRunningScript: mocks.getRunningScript },
}));

import { registerProjectHandlers } from './project';

function createRegistry(deleteResult: boolean) {
  const databaseService = {
    getProject: vi.fn(() => ({
      id: 42,
      name: 'Delete me',
      path: process.cwd(),
      active: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })),
    getAllSessionsIncludingArchived: vi.fn(() => []),
    getAllSessions: vi.fn(() => []),
    deleteProject: vi.fn(() => deleteResult),
  };
  const sessionManager = {
    getProjectContextByProjectId: vi.fn(() => undefined),
    invalidateProjectContext: vi.fn(),
  };
  // SAFETY: This fixture supplies every AppServices member exercised by projects:delete with no sessions.
  const services = {
    databaseService,
    sessionManager,
    worktreeManager: {},
  } as AppServices;
  const registry = new PaneCommandRegistry();
  // SAFETY: registerProjectHandlers only calls the IpcMain.handle surface in this test.
  registerProjectHandlers({ handle: vi.fn() } as never, services, registry);
  return { databaseService, registry };
}

describe('projects:delete launch cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRunningScript.mockReturnValue(null);
  });

  it.each([true, false])('forgets launch state before teardown and after deleteProject returns %s', async deleteResult => {
    const { databaseService, registry } = createRegistry(deleteResult);

    await expect(registry.invoke('projects:delete', ['42'])).resolves.toEqual({
      success: true,
      data: deleteResult,
    });

    expect(mocks.forgetProjectLaunchState).toHaveBeenNthCalledWith(1, 42);
    expect(mocks.forgetProjectLaunchState).toHaveBeenNthCalledWith(2, 42);
    expect(mocks.forgetProjectLaunchState.mock.invocationCallOrder[0])
      .toBeLessThan(databaseService.getAllSessionsIncludingArchived.mock.invocationCallOrder[0]);
    expect(databaseService.deleteProject.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.forgetProjectLaunchState.mock.invocationCallOrder[1]);
  });
});
