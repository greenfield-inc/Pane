import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../ipc/types';

const mocks = vi.hoisted(() => ({
  createPanel: vi.fn(),
  deletePanel: vi.fn(),
  getPanel: vi.fn(),
  removePanelFromMemory: vi.fn(),
  getPanelsForSession: vi.fn(),
  setActivePanel: vi.fn(),
  initializeTerminal: vi.fn(),
  getTerminalSnapshot: vi.fn(),
  isTerminalInitialized: vi.fn(),
  destroyTerminal: vi.fn(),
  runAgentDoctor: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The production service intentionally imports these documented module singletons; the plan requires faithful singleton doubles.
vi.mock('./panelManager', () => ({
  panelManager: {
    createPanel: mocks.createPanel,
    deletePanel: mocks.deletePanel,
    getPanel: mocks.getPanel,
    removePanelFromMemory: mocks.removePanelFromMemory,
    getPanelsForSession: mocks.getPanelsForSession,
    setActivePanel: mocks.setActivePanel,
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The production service intentionally imports these documented module singletons; the plan requires faithful singleton doubles.
vi.mock('./terminalPanelManager', () => ({
  terminalPanelManager: {
    initializeTerminal: mocks.initializeTerminal,
    getTerminalSnapshot: mocks.getTerminalSnapshot,
    isTerminalInitialized: mocks.isTerminalInitialized,
    destroyTerminal: mocks.destroyTerminal,
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Doctor outcomes are the service boundary under test, including each validation failure.
vi.mock('./agents/agentDoctor', () => ({ runAgentDoctor: mocks.runAgentDoctor }));

import { forgetProjectLaunchState, launchDefaultAgentOnce } from './workspaceEntry';

let projectId = 100;
const panelRecords = new Map<string, { id: string }>();

function createServices(options: {
  agent?: string;
  receipt?: string;
  updateProject?: ReturnType<typeof vi.fn>;
  getSession?: ReturnType<typeof vi.fn>;
} = {}) {
  projectId += 1;
  const updateProject = options.updateProject ?? vi.fn(() => ({ id: projectId }));
  const getSession = options.getSession ?? vi.fn(async () => ({
    id: `session-${projectId}`,
    worktreePath: `/repo/${projectId}`,
  }));
  const deletePanel = vi.fn();
  // SAFETY: This fixture supplies every AppServices member exercised by workspaceEntry.
  const services = {
    databaseService: {
      getProject: vi.fn(() => ({
        id: projectId,
        name: 'Repo',
        path: '/repo',
        active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        default_agent_launched_at: options.receipt,
      })),
      updateProject,
      deletePanel,
    },
    configManager: { getConfig: vi.fn(() => ({ defaultOrchestratorAgent: options.agent ?? 'codex' })) },
    sessionManager: {
      getOrCreateMainRepoSessionAnnounced: getSession,
      getProjectContext: vi.fn(() => ({ commandRunner: { wslContext: null } })),
      getProjectContextByProjectId: vi.fn(),
      getSessionsForProject: vi.fn(() => []),
    },
  } as AppServices;
  return { services, id: projectId, updateProject, getSession, deletePanel };
}

function launchDisclosedCodex(services: AppServices, id: number) {
  return launchDefaultAgentOnce(services, id, { disclosedAgent: 'codex' });
}

beforeEach(() => {
  vi.useRealTimers();
  panelRecords.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createPanel.mockImplementation(async request => {
    const panelId = request.id ?? `panel-${request.sessionId}`;
    const panel = {
      id: panelId,
      sessionId: request.sessionId,
      type: 'terminal',
      title: request.title,
      state: { isActive: true, customState: request.initialState },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z', position: 0 },
    };
    panelRecords.set(panel.id, panel);
    return panel;
  });
  mocks.deletePanel.mockImplementation(async panelId => { panelRecords.delete(panelId); });
  mocks.getPanel.mockImplementation(panelId => panelRecords.get(panelId));
  mocks.removePanelFromMemory.mockImplementation(panelId => { panelRecords.delete(panelId); });
  mocks.getPanelsForSession.mockImplementation(sessionId => [{ id: `explorer-${sessionId}`, type: 'explorer' }]);
  mocks.initializeTerminal.mockResolvedValue(undefined);
  mocks.getTerminalSnapshot.mockReturnValue({ isCliReady: true, initialCommandSent: true });
  mocks.isTerminalInitialized.mockReturnValue(true);
  mocks.runAgentDoctor.mockResolvedValue({ available: true, checks: [] });
});

describe('launchDefaultAgentOnce', () => {
  it.each([
    ['claude', 'claude --dangerously-skip-permissions'],
    ['codex', 'codex --yolo'],
    ['cursor', 'cursor-agent --force --trust'],
  ] as const)('launches the %s preset with only trusted initial state', async (agent, command) => {
    const { services, id } = createServices({ agent });

    const result = await launchDefaultAgentOnce(services, id, { disclosedAgent: agent });

    expect(result).toMatchObject({ status: 'launched', agentType: agent, initialCommand: command });
    expect(mocks.createPanel).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: `session-${id}`,
      type: 'terminal',
      title: expect.any(String),
      initialState: { initialCommand: command, agentType: agent, isCliPanel: true },
    });
    expect(services.sessionManager.getOrCreateMainRepoSessionAnnounced).toHaveBeenCalledWith(id, {
      createDefaultTerminalOnCreate: false,
    });
    expect(services.sessionManager.getOrCreateMainRepoSessionAnnounced.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runAgentDoctor.mock.invocationCallOrder[0]);
  });

  it.each([undefined, 'invalid'] as const)('skips an absent or invalid default', async agent => {
    const { services, id, updateProject, getSession } = createServices({ agent });
    if (agent === undefined) {
      vi.mocked(services.configManager.getConfig).mockReturnValue({ defaultOrchestratorAgent: undefined });
    }
    await expect(launchDefaultAgentOnce(services, id)).resolves.toEqual({ status: 'skipped', reason: 'no-default' });
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('skips when the disclosed agent differs from the resolved launch preset', async () => {
    const { services, id, updateProject, getSession } = createServices({ agent: 'codex' });

    await expect(launchDefaultAgentOnce(services, id, { disclosedAgent: 'claude' })).resolves.toEqual({
      status: 'skipped',
      reason: 'disclosure-mismatch',
    });

    expect(getSession).not.toHaveBeenCalled();
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('skips a requested automatic launch when the disclosed agent is absent', async () => {
    const { services, id, updateProject, getSession } = createServices({ agent: 'codex' });

    await expect(launchDefaultAgentOnce(services, id)).resolves.toEqual({
      status: 'skipped',
      reason: 'disclosure-mismatch',
    });

    expect(getSession).not.toHaveBeenCalled();
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('launches when the disclosed agent matches the resolved launch preset', async () => {
    const { services, id } = createServices({ agent: 'codex' });

    await expect(launchDefaultAgentOnce(services, id, { disclosedAgent: 'codex' })).resolves.toMatchObject({
      status: 'launched',
      agentType: 'codex',
    });

    expect(services.sessionManager.getOrCreateMainRepoSessionAnnounced).toHaveBeenCalledOnce();
    expect(mocks.createPanel).toHaveBeenCalledOnce();
  });

  it('skips a project with a durable receipt', async () => {
    const { services, id, getSession } = createServices({ receipt: '2026-01-01T00:00:00.000Z' });
    await expect(launchDefaultAgentOnce(services, id)).resolves.toEqual({ status: 'skipped', reason: 'already-launched' });
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('clears the in-flight promise after a synchronous skip', async () => {
    const { services, id } = createServices({ receipt: '2026-01-01T00:00:00.000Z' });
    const first = launchDefaultAgentOnce(services, id);
    await first;
    const replay = launchDefaultAgentOnce(services, id);
    expect(replay).not.toBe(first);
    await expect(replay).resolves.toEqual({ status: 'skipped', reason: 'already-launched' });
  });

  it.each(['platform', 'repo-context', 'executable'])('returns validation failure for %s', async check => {
    mocks.runAgentDoctor.mockResolvedValue({ available: false, checks: [{ name: check, ok: false, message: `${check} failed` }] });
    const { services, id, updateProject, getSession } = createServices();
    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({
      status: 'failed', reason: 'validation-failed', message: `${check} failed`,
    });
    expect(getSession).toHaveBeenCalledWith(id, { createDefaultTerminalOnCreate: false });
    expect(getSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.runAgentDoctor.mock.invocationCallOrder[0]);
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.setActivePanel).toHaveBeenCalledWith(`session-${id}`, `explorer-session-${id}`);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('cancels during doctor validation after announcing the shell-suppressed session', async () => {
    let resolveDoctor: (() => void) | undefined;
    mocks.runAgentDoctor.mockImplementationOnce(() => new Promise(resolve => {
      resolveDoctor = () => resolve({ available: true, checks: [] });
    }));
    const { services, id, getSession, updateProject } = createServices();
    const launch = launchDisclosedCodex(services, id);
    await vi.waitFor(() => expect(resolveDoctor).toBeTypeOf('function'));

    forgetProjectLaunchState(id);

    await expect(launch).resolves.toMatchObject({
      status: 'failed',
      reason: 'launch-error',
      message: 'Project was deleted before Codex started.',
    });
    expect(getSession).toHaveBeenCalledWith(id, { createDefaultTerminalOnCreate: false });
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.setActivePanel).toHaveBeenCalledWith(`session-${id}`, `explorer-session-${id}`);
    expect(updateProject).not.toHaveBeenCalled();
    resolveDoctor?.();
  });

  it('cleans up a preallocated panel when create persists and then rejects', async () => {
    mocks.isTerminalInitialized.mockReturnValue(false);
    mocks.createPanel.mockImplementationOnce(async request => {
      if (!request.id) throw new Error('missing preallocated panel id');
      panelRecords.set(request.id, { id: request.id });
      throw new Error('event sink failed after insert');
    });
    const { services, id, updateProject } = createServices();

    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({
      status: 'failed',
      message: 'event sink failed after insert',
    });

    const allocatedPanelId = mocks.createPanel.mock.calls[0]?.[0].id;
    expect(allocatedPanelId).toEqual(expect.any(String));
    expect(mocks.deletePanel).toHaveBeenCalledWith(allocatedPanelId);
    expect(mocks.getPanel(allocatedPanelId)).toBeUndefined();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('cleans up a panel when terminal initialization throws', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    const { services, id, updateProject } = createServices();
    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({ status: 'failed', message: 'spawn failed' });
    expect(mocks.destroyTerminal).toHaveBeenCalledOnce();
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(mocks.setActivePanel).toHaveBeenCalledWith(`session-${id}`, `explorer-session-${id}`);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('does not destroy a terminal that never initialized', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    mocks.isTerminalInitialized.mockReturnValue(false);
    const { services, id } = createServices();
    await launchDisclosedCodex(services, id);
    expect(mocks.destroyTerminal).not.toHaveBeenCalled();
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
  });

  it('retries panel deletion when the first delete rejects', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    mocks.deletePanel
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockImplementationOnce(async panelId => { panelRecords.delete(panelId); });
    const { services, id } = createServices();

    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({ status: 'failed' });

    expect(mocks.deletePanel).toHaveBeenCalledTimes(2);
    const allocatedPanelId = mocks.createPanel.mock.calls[0]?.[0].id;
    expect(mocks.getPanel(allocatedPanelId)).toBeUndefined();
  });

  it('reports a stale panel when every cleanup layer leaves it behind', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    mocks.deletePanel.mockRejectedValue(new Error('delete failed'));
    mocks.removePanelFromMemory.mockImplementation(() => undefined);
    const { services, id, deletePanel } = createServices();

    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('stale panel remained'),
    });

    expect(mocks.deletePanel).toHaveBeenCalledTimes(2);
    const allocatedPanelId = mocks.createPanel.mock.calls[0]?.[0].id;
    expect(deletePanel).toHaveBeenCalledWith(allocatedPanelId);
  });

  it('cleans up when the PTY exits before readiness', async () => {
    mocks.getTerminalSnapshot.mockReturnValue(null);
    const { services, id, updateProject } = createServices();
    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('exited') });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('times out, cleans up, and writes no receipt', async () => {
    vi.useFakeTimers();
    mocks.getTerminalSnapshot.mockReturnValue({ isCliReady: false });
    const { services, id, updateProject } = createServices();
    const promise = launchDisclosedCodex(services, id);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(promise).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('ready in time') });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('does not record a receipt for CLI-ready state before command submission', async () => {
    vi.useFakeTimers();
    mocks.getTerminalSnapshot.mockReturnValue({ isCliReady: true, initialCommandSent: false });
    const { services, id, updateProject } = createServices();
    const promise = launchDisclosedCodex(services, id);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(promise).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('ready in time') });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('bounds terminal initialization with the overall launch deadline', async () => {
    vi.useFakeTimers();
    mocks.initializeTerminal.mockReturnValue(new Promise<void>(() => undefined));
    mocks.isTerminalInitialized.mockReturnValue(false);
    const { services, id, updateProject } = createServices();
    const promise = launchDisclosedCodex(services, id);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.initializeTerminal).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(45_000);

    await expect(promise).resolves.toMatchObject({
      status: 'failed',
      message: 'Codex did not start within 45 s.',
    });
    expect(mocks.destroyTerminal).not.toHaveBeenCalled();
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(mocks.setActivePanel).toHaveBeenCalledWith(`session-${id}`, `explorer-session-${id}`);
    expect(updateProject).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroys a terminal that registers after the overall launch deadline', async () => {
    vi.useFakeTimers();
    let resolveInitialization: (() => void) | undefined;
    let initialized = false;
    mocks.initializeTerminal.mockReturnValue(new Promise<void>(resolve => { resolveInitialization = resolve; }));
    mocks.isTerminalInitialized.mockImplementation(() => initialized);
    const { services, id, updateProject } = createServices();
    const promise = launchDisclosedCodex(services, id);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(45_000);
    await expect(promise).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.destroyTerminal).not.toHaveBeenCalled();
    expect(mocks.deletePanel).toHaveBeenCalledOnce();

    initialized = true;
    resolveInitialization?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.destroyTerminal).toHaveBeenCalledWith(mocks.createPanel.mock.calls[0]?.[0].id);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('keeps a cleanup probe failure inside the memoised failed result', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    mocks.isTerminalInitialized.mockReturnValue(false);
    mocks.getPanel.mockImplementation(() => { throw new Error('database read failed'); });
    const { services, id } = createServices();

    const first = await launchDisclosedCodex(services, id);
    const replay = await launchDisclosedCodex(services, id);

    expect(first).toMatchObject({ status: 'failed', reason: 'launch-error' });
    expect(replay).toBe(first);
  });

  it('memoises a synthesized failure when the attempt catch path rejects', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    mocks.isTerminalInitialized.mockImplementation(() => { throw new Error('cleanup probe failed'); });
    const consoleError = vi.spyOn(console, 'error')
      .mockImplementationOnce(() => { throw new Error('cleanup handler failed'); });
    const { services, id } = createServices();
    try {
      const first = await launchDisclosedCodex(services, id);
      const replay = await launchDisclosedCodex(services, id);

      expect(first).toMatchObject({
        status: 'failed',
        reason: 'launch-error',
        message: 'cleanup handler failed',
      });
      expect(replay).toBe(first);
      expect(mocks.createPanel).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('cleans up when the receipt write fails after readiness', async () => {
    const updateProject = vi.fn(() => { throw new Error('receipt failed'); });
    const { services, id } = createServices({ updateProject });
    await expect(launchDisclosedCodex(services, id)).resolves.toMatchObject({ status: 'failed', message: 'receipt failed' });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
  });

  it.each(['doctor', 'session'])('maps a thrown %s precheck to failed without creating a panel', async source => {
    const fixture = createServices();
    if (source === 'doctor') mocks.runAgentDoctor.mockRejectedValue(new Error('doctor failed'));
    else fixture.getSession.mockRejectedValue(new Error('session failed'));
    await expect(launchDisclosedCodex(fixture.services, fixture.id)).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.createPanel).not.toHaveBeenCalled();
  });

  it('coalesces concurrent success and writes the receipt after readiness', async () => {
    let release: (() => void) | undefined;
    mocks.initializeTerminal.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const { services, id, updateProject } = createServices();
    const first = launchDisclosedCodex(services, id);
    const second = launchDisclosedCodex(services, id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(mocks.createPanel).toHaveBeenCalledOnce();
    expect(updateProject).toHaveBeenCalledOnce();
    expect(mocks.getTerminalSnapshot.mock.invocationCallOrder[0]).toBeLessThan(updateProject.mock.invocationCallOrder[0]);
  });

  it('coalesces failure and replays the same failed object sequentially', async () => {
    let release: (() => void) | undefined;
    mocks.initializeTerminal.mockImplementation(() => new Promise<void>((_resolve, reject) => { release = () => reject(new Error('failed')); }));
    const { services, id } = createServices();
    const first = launchDisclosedCodex(services, id);
    const second = launchDisclosedCodex(services, id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const replay = await launchDisclosedCodex(services, id);
    expect(firstResult).toBe(secondResult);
    expect(replay).toBe(firstResult);
    expect(mocks.createPanel).toHaveBeenCalledOnce();
  });

  it('cancels initialization and permits a fresh attempt after forgetting launch state', async () => {
    let resolveInitialization: (() => void) | undefined;
    mocks.initializeTerminal.mockImplementationOnce(() => new Promise(resolve => {
      resolveInitialization = resolve;
    }));
    mocks.isTerminalInitialized.mockReturnValue(false);
    const { services, id, updateProject } = createServices();

    const first = launchDisclosedCodex(services, id);
    await vi.waitFor(() => expect(resolveInitialization).toBeTypeOf('function'));
    forgetProjectLaunchState(id);

    const firstResult = await first;
    expect(firstResult).toMatchObject({
      status: 'failed',
      reason: 'launch-error',
      message: 'Project was deleted before Codex started.',
    });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();

    const second = launchDisclosedCodex(services, id);
    const secondResult = await second;
    resolveInitialization?.();
    await Promise.resolve();
    const replay = await launchDisclosedCodex(services, id);

    expect(first).not.toBe(second);
    expect(secondResult).toMatchObject({ status: 'launched' });
    expect(replay).toBe(secondResult);
    expect(mocks.createPanel).toHaveBeenCalledTimes(2);
    expect(updateProject).toHaveBeenCalledOnce();
  });

  it('is imported by project IPC only', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const imports = fs.readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .map(file => ({ file, posixPath: file.split(path.sep).join(path.posix.sep) }))
      .filter(({ posixPath }) => posixPath.endsWith('.ts') && !posixPath.endsWith('.test.ts'))
      .filter(({ file }) => fs.readFileSync(path.join(sourceRoot, file), 'utf8').includes('services/workspaceEntry'))
      .map(({ posixPath }) => posixPath);
    expect(imports).toEqual(['ipc/project.ts']);
  });
});
