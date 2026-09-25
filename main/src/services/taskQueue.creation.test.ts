import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database';
import type { Project } from '../database/models';
import { withLock } from '../utils/mutex';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import type { Session } from '../types/session';
import type { SessionManager } from './sessionManager';
import { TaskQueue } from './taskQueue';
import { WorktreeManager } from './worktreeManager';
import { worktreePoolManager } from './worktreePoolManager';
import { panelManager } from './panelManager';
import { worktreeFileSyncService } from './worktreeFileSyncService';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';

const send = vi.fn();

function partialMock<T>(value: Partial<T>): T {
  // SAFETY: Fixtures supply every collaborator used by the no-agent creation flow.
  return value as T;
}

let tempDir: string;
let database: DatabaseService;
let project: Project;
let runner: CommandRunner;
let queue: TaskQueue;
let queueOptions: ConstructorParameters<typeof TaskQueue>[0];

beforeEach(async () => {
  send.mockClear();
  vi.spyOn(panelManager, 'ensureExplorerPanel').mockResolvedValue();
  vi.spyOn(panelManager, 'ensureDiffPanel').mockResolvedValue();
  vi.spyOn(panelManager, 'getPanelsForSession').mockReturnValue([]);
  vi.spyOn(worktreePoolManager, 'claimReserve').mockResolvedValue(null);
  vi.spyOn(worktreePoolManager, 'createReserve').mockResolvedValue();
  vi.spyOn(worktreeFileSyncService, 'syncWorktree').mockResolvedValue({ failures: [], installCommand: null });
  setPaneRuntime(partialMock({ eventSink: { send }, getConfigManager: () => partialMock({ getWorktreeFileSyncEntries: () => [] }) }));
  tempDir = mkdtempSync(path.join(tmpdir(), 'pane-creation-'));
  const repoPath = path.join(tempDir, 'repo');
  mkdirSync(repoPath);
  database = new DatabaseService(path.join(tempDir, 'sessions.db'));
  database.initialize();
  project = database.createProject('Repo', repoPath);
  runner = new CommandRunner(project);
  await runner.execFile('git', ['init', '-b', 'main'], repoPath);
  await runner.execFile('git', ['-c', 'user.name=Pane Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial'], repoPath);
  const sessionManager = partialMock<SessionManager>({
    db: database,
    getProjectById: () => project,
    getProjectContextByProjectId: () => partialMock({ pathResolver: new PathResolver(project), commandRunner: runner }),
    createSession: async (name, worktreePath, prompt, worktreeName, _permissionMode, projectId) => {
      const id = randomUUID();
      database.createSession({ id, name, initial_prompt: prompt, worktree_name: worktreeName, worktree_path: worktreePath, project_id: projectId });
      return partialMock<Session>({ id, name, worktreePath });
    },
    emitSessionCreated: vi.fn(),
    updateSession: vi.fn(),
  });
  queueOptions = {
    sessionManager,
    worktreeManager: new WorktreeManager(),
    claudeCodeManager: partialMock({}),
    gitDiffManager: partialMock({}),
    executionTracker: partialMock({}),
    worktreeNameGenerator: partialMock({}),
    useSimpleQueue: true,
  };
  queue = new TaskQueue(queueOptions);
});

afterEach(async () => {
  await queue?.close();
  vi.restoreAllMocks();
  resetPaneRuntimeForTests();
  database?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function createPane(name = 'Feature', isMainRepo = false, taskQueue = queue) {
  const result = await taskQueue.createSessionAndWait({
    projectId: project.id, worktreeTemplate: name, prompt: '', toolType: 'none', baseBranch: 'main', isMainRepo,
  });
  return database.getSession(result.sessionId)!;
}

describe('pane creation name reuse', () => {
  it('reuses an archived display name without taking its worktree identity or commits', async () => {
    const original = await createPane();
    await runner.execFile('git', ['-c', 'user.name=Pane Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Archived work'], original.worktree_path);
    const oldHead = (await runner.execFile('git', ['rev-parse', 'feature'], project.path)).stdout;
    database.archiveSession(original.id);
    await runner.execFile('git', ['worktree', 'remove', original.worktree_path], project.path);

    const created = await createPane();

    expect(created.name).toBe('Feature');
    expect(created.worktree_name).toBe('feature-1');
    expect((await runner.execFile('git', ['rev-parse', 'feature'], project.path)).stdout).toBe(oldHead);
    expect((await runner.execFile('git', ['rev-parse', 'HEAD'], created.worktree_path)).stdout)
      .toBe((await runner.execFile('git', ['rev-parse', 'main'], project.path)).stdout);
    expect(database.getSession(original.id)?.archived).toBeTruthy();
  });

  it('creates a fresh pane when a deleted pane branch is checked out elsewhere', async () => {
    const original = await createPane();
    const externalPath = path.join(tempDir, 'kept-work');
    await runner.execFile('git', ['worktree', 'move', original.worktree_path, externalPath], project.path);
    database.archiveSession(original.id);
    database.deleteArchivedSessionPermanently(original.id);
    writeFileSync(path.join(externalPath, 'keep.txt'), 'Do not touch');

    const created = await createPane();

    expect(created.name).toBe('Feature');
    expect(created.worktree_name).toBe('feature-1');
    expect(readFileSync(path.join(externalPath, 'keep.txt'), 'utf8')).toBe('Do not touch');
  });

  it('does not reuse leftover branches after permanent deletion, including branch namespaces', async () => {
    await runner.execFile('git', ['branch', 'feature'], project.path);
    await runner.execFile('git', ['tag', 'feature'], project.path);
    await runner.execFile('git', ['branch', 'feature-1/topic'], project.path);
    const created = await createPane();
    expect(created.name).toBe('Feature');
    expect(created.worktree_name).toBe('feature-2');
  });

  it('respects an absolute worktree folder and preserves existing files', async () => {
    project.worktree_folder = path.join(tempDir, 'custom-worktrees');
    const existingPath = path.join(project.worktree_folder, 'feature');
    mkdirSync(existingPath, { recursive: true });
    writeFileSync(path.join(existingPath, 'keep.txt'), 'Do not touch');

    const created = await createPane();

    expect(created.name).toBe('Feature');
    expect(created.worktree_path).toBe(path.join(project.worktree_folder, 'feature-1'));
    expect(readFileSync(path.join(existingPath, 'keep.txt'), 'utf8')).toBe('Do not touch');
  });

  it('suffixes active display names while preserving separate worktrees', async () => {
    // Two queues exercise overlapping creates even on Linux's single-worker queue.
    const secondQueue = new TaskQueue(queueOptions);
    try {
      const [first, second] = await Promise.all([createPane(), createPane('Feature', false, secondQueue)]);
      expect([first.name, second.name]).toEqual(['Feature', 'Feature 1']);
      expect(first.worktree_path).not.toBe(second.worktree_path);
    } finally {
      await secondQueue.close();
    }
  });

  it('waits beyond the default mutex timeout for a preceding checkout', async () => {
    let releaseCheckout!: () => void;
    let reservationHeld!: () => void;
    const held = new Promise<void>((resolve) => { reservationHeld = resolve; });
    const checkout = withLock(`session-create-${project.path}`, async () => {
      reservationHeld();
      await new Promise<void>((resolve) => { releaseCheckout = resolve; });
    });
    await held;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const pending = createPane();
    const result = pending.then(value => ({ value }), error => ({ error }));
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      clock.mockReturnValue(now + 60_000);
      await new Promise(resolve => setTimeout(resolve, 30));
    } finally {
      clock.mockRestore();
      releaseCheckout();
      await checkout;
    }
    expect(await result).toMatchObject({ value: { name: 'Feature' } });
    expect(send).not.toHaveBeenCalledWith('session:creation-failed', expect.anything());
  });

  it('reports post-persistence failures on the existing pane as initialization errors', async () => {
    vi.spyOn(panelManager, 'ensureExplorerPanel').mockRejectedValueOnce(new Error('Panel setup failed'));
    await expect(createPane()).rejects.toThrow('Panel setup failed');
    expect(database.checkActiveSessionNameExists('Feature', project.id)).toBe(true);
    expect(queueOptions.sessionManager.updateSession).toHaveBeenCalledWith(expect.any(String), {
      status: 'error', error: 'Panel setup failed', statusMessage: 'Failed to initialize pane: Panel setup failed',
    });
    expect(queueOptions.sessionManager.emitSessionCreated).toHaveBeenCalledOnce();
    expect(queueOptions.sessionManager.emitSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Feature', status: 'error', statusMessage: 'Failed to initialize pane: Panel setup failed' }),
      { activateOnCreate: true, createDefaultTerminalOnCreate: false },
    );
    expect(send).not.toHaveBeenCalledWith('session:creation-failed', expect.anything());
  });

  it('does not re-announce a pane when initialization fails after its creation event', async () => {
    vi.spyOn(queueOptions.sessionManager, 'updateSession').mockImplementationOnce(() => { throw new Error('Status update failed'); });
    await expect(createPane()).rejects.toThrow('Status update failed');
    expect(queueOptions.sessionManager.emitSessionCreated).toHaveBeenCalledOnce();
    expect(queueOptions.sessionManager.updateSession).toHaveBeenLastCalledWith(expect.any(String), {
      status: 'error', error: 'Status update failed', statusMessage: 'Failed to initialize pane: Status update failed',
    });
    expect(send).not.toHaveBeenCalledWith('session:creation-failed', expect.anything());
  });

  it('reports the created session id while setup is still running', async () => {
    let finishBuild: (result: { success: boolean }) => void = () => {};
    project.build_script = 'npm install';
    Object.assign(queueOptions.sessionManager, {
      updateSessionStatus: vi.fn(),
      addSessionOutput: vi.fn(async () => {}),
      runBuildScript: vi.fn(() => new Promise(resolve => { finishBuild = resolve; })),
    });
    let reportSessionId: (sessionId: string) => void = () => {};
    const reported = new Promise<string>(resolve => { reportSessionId = resolve; });

    const pending = queue.createSessionAndWait({
      projectId: project.id, worktreeTemplate: 'Feature', prompt: '', toolType: 'none', baseBranch: 'main',
    }, { onSessionCreated: reportSessionId });
    const reportedId = await reported;

    expect(database.getSession(reportedId)?.name).toBe('Feature');
    await vi.waitFor(() => expect(queueOptions.sessionManager.runBuildScript).toHaveBeenCalledOnce());
    finishBuild({ success: true });
    expect((await pending).sessionId).toBe(reportedId);
  });

  it('reuses archived names for panes in the project directory without reserving a branch', async () => {
    const original = await createPane('Feature', true);
    database.archiveSession(original.id);
    const created = await createPane('Feature', true);
    expect(created.name).toBe('Feature');
    expect(created.worktree_name).toBe('');
    expect(created.worktree_path).toBe(project.path);
  });

  it('emits a visible creation failure when Git rejects a queued job', async () => {
    const request = {
      projectId: project.id, worktreeTemplate: 'Feature', prompt: '', toolType: 'none' as const, baseBranch: 'missing-branch',
    };
    await expect(queue.createSessionAndWait(request)).rejects.toThrow("Base branch 'missing-branch' does not exist");
    expect(send).toHaveBeenCalledWith('session:creation-failed', {
      name: 'Feature', error: "Failed to create worktree: Base branch 'missing-branch' does not exist",
    });
  });
});
