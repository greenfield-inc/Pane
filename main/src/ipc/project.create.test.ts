import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';

const mocks = vi.hoisted(() => ({
  launchDefaultAgentOnce: vi.fn(),
  ensureProjectAgentContext: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The handler's explicit launch-service boundary is mocked to pin flag and error behavior.
vi.mock('../services/workspaceEntry', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/workspaceEntry')>();
  return { ...actual, launchDefaultAgentOnce: mocks.launchDefaultAgentOnce };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Agent-context publication is unrelated external work in this handler test.
vi.mock('../services/agentContextManager', () => ({
  ensureProjectAgentContext: mocks.ensureProjectAgentContext,
}));

import { registerProjectHandlers } from './project';

function createRegistry() {
  let nextId = 1;
  const getSession = vi.fn();
  const databaseService = {
    createProject: vi.fn((name: string, repoPath: string) => ({
      id: nextId++,
      name,
      path: repoPath,
      active: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })),
    getProject: vi.fn((id: number) => ({
      id,
      name: 'Created repo',
      path: process.cwd(),
      active: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })),
    getAllProjects: vi.fn(() => []),
    createRunCommand: vi.fn(),
  };
  // SAFETY: This fixture supplies every AppServices member exercised by projects:create.
  const services = {
    databaseService,
    sessionManager: { getOrCreateMainRepoSessionAnnounced: getSession },
    worktreeManager: { getProjectMainBranch: vi.fn(async () => 'main') },
    configManager: { getConfig: vi.fn(() => ({ defaultOrchestratorAgent: 'codex', agentContext: { managedAgentsMd: false } })) },
    analyticsManager: { track: vi.fn() },
  } as AppServices;
  const registry = new PaneCommandRegistry();
  // SAFETY: registerProjectHandlers only calls the IpcMain.handle surface in this test.
  registerProjectHandlers({ handle: vi.fn() } as never, services, registry);
  return { registry, services, getSession };
}

const request = { name: 'Created repo', path: process.cwd() };

describe('projects:create default agent boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureProjectAgentContext.mockResolvedValue(undefined);
    mocks.launchDefaultAgentOnce.mockResolvedValue({
      status: 'launched',
      agentType: 'codex',
      agentTitle: 'Codex',
      initialCommand: 'codex --yolo',
      sessionId: 'main-session',
      panelId: 'agent-panel',
    });
  });

  it('honours the true flag through the daemon registry and returns the result', async () => {
    const { registry } = createRegistry();
    const result = await registry.invoke('projects:create', [{
      ...request,
      launchDefaultAgent: true,
      disclosedAgent: 'codex',
    }]);
    expect(mocks.launchDefaultAgentOnce).toHaveBeenCalledWith(expect.anything(), 1, { disclosedAgent: 'codex' });
    expect(result).toMatchObject({ success: true, data: { defaultAgentLaunch: { status: 'launched' } } });
  });

  it.each([undefined, false])('does not launch when the flag is %s', async launchDefaultAgent => {
    const { registry } = createRegistry();
    const createRequest = { ...request, launchDefaultAgent };
    if (launchDefaultAgent === undefined) delete createRequest.launchDefaultAgent;
    const result = await registry.invoke('projects:create', [createRequest]);
    expect(mocks.launchDefaultAgentOnce).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
    // SAFETY: projects:create success responses own a concrete data object.
    expect((result as { data: { defaultAgentLaunch?: unknown } }).data).not.toHaveProperty('defaultAgentLaunch');
  });

  it('uses the real launch service to reject a flag without a disclosed agent', async () => {
    const workspaceEntry = await vi.importActual<typeof import('../services/workspaceEntry')>('../services/workspaceEntry');
    mocks.launchDefaultAgentOnce.mockImplementationOnce(workspaceEntry.launchDefaultAgentOnce);
    const { registry, getSession } = createRegistry();

    const result = await registry.invoke('projects:create', [{ ...request, launchDefaultAgent: true }]);

    expect(result).toMatchObject({
      success: true,
      data: { defaultAgentLaunch: { status: 'skipped', reason: 'disclosure-mismatch' } },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('keeps the project when launch throws and returns a failed launch result', async () => {
    mocks.launchDefaultAgentOnce.mockRejectedValue(new Error('launch exploded'));
    const { registry } = createRegistry();
    const result = await registry.invoke('projects:create', [{
      ...request,
      launchDefaultAgent: true,
      disclosedAgent: 'codex',
    }]);
    expect(result).toMatchObject({
      success: true,
      data: { defaultAgentLaunch: { status: 'failed', reason: 'launch-error', message: 'launch exploded' } },
    });
  });
});
