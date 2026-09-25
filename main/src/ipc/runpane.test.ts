import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { Project } from '../database/models';
import type { Session } from '../types/session';
import type { AppServices } from './types';
import type { CreatePanelRequest, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import type { RunpaneToolSpec } from '../../../shared/types/runpaneOrchestration';

import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { databaseService as panelDatabase } from '../services/database';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { usageManager } from '../services/usage/usageManager';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import { registerRunpaneHandlers } from './runpane';
import type { TaskQueue } from '../services/taskQueue';

vi.spyOn(panelManager, 'createPanel');
vi.spyOn(panelManager, 'getPanel');
vi.spyOn(panelManager, 'getPanelsForSession');
vi.spyOn(panelManager, 'updatePanel');
vi.spyOn(panelManager, 'setActivePanel');
vi.spyOn(panelManager, 'ensureExplorerPanel');
vi.spyOn(panelManager, 'ensureDiffPanel');
vi.spyOn(terminalPanelManager, 'initializeTerminal');
vi.spyOn(terminalPanelManager, 'isTerminalInitialized');
vi.spyOn(terminalPanelManager, 'getTerminalSnapshot');
vi.spyOn(terminalPanelManager, 'waitForTerminalState');
vi.spyOn(terminalPanelManager, 'getCleanTerminalScrollback');
vi.spyOn(terminalPanelManager, 'writeToTerminal');
vi.spyOn(terminalPanelManager, 'getLastOutputAt');
vi.spyOn(terminalPanelManager, 'getOutputGeneration');
vi.spyOn(terminalPanelManager, 'getInputScreenText');
vi.spyOn(terminalPanelManager, 'deliverPendingInitialInput');
vi.spyOn(terminalPanelManager, 'getAgentStatus');
vi.spyOn(panelDatabase, 'getPanelBuffers');
vi.spyOn(usageManager, 'getPaneCosts');

const project: Project = {
  id: 1,
  name: 'Pane',
  path: '/repo/pane',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const session: Session = {
  id: 'session-1',
  name: 'issue-252',
  prompt: '',
  worktreePath: '/repo/pane-worktrees/issue-252',
  status: 'stopped',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  output: [],
  jsonMessages: [],
  projectId: project.id,
};

const zeroUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  messageCount: 0,
  estimatedCostUsd: 0,
  costIncomplete: false,
  cacheSavingsUsd: 0,
};

const paneCostOne = {
  ...zeroUsageTotals,
  paneId: session.id,
  paneName: session.name,
  worktreePath: session.worktreePath,
  repoId: project.id,
  archived: false,
  createdAtMs: session.createdAt.getTime(),
  inputTokens: 100,
  totalTokens: 100,
  messageCount: 1,
  estimatedCostUsd: 0.003,
  uncachedCostUsd: 0.003,
  uncachedInputTokens: 100,
  cacheHitRate: 0,
  byModel: [{
    ...zeroUsageTotals,
    model: 'claude-sonnet-5',
    provider: 'claude' as const,
    inputTokens: 100,
    totalTokens: 100,
    messageCount: 1,
    estimatedCostUsd: 0.003,
  }],
};

const paneCostTwo = {
  ...zeroUsageTotals,
  paneId: 'session-2',
  paneName: 'Other repo',
  worktreePath: '/repo/other-worktrees/task',
  repoId: 2,
  archived: true,
  createdAtMs: Date.parse('2026-01-02T00:00:00.000Z'),
  uncachedCostUsd: 0,
  uncachedInputTokens: 0,
  cacheHitRate: 0,
  byModel: [],
};

const terminalPanel: ToolPanel = {
  id: 'panel-1',
  sessionId: session.id,
  type: 'terminal',
  title: 'Codex',
  state: {
    isActive: true,
    customState: {
      agentType: 'codex',
      isCliPanel: true,
    },
  },
  metadata: {
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:01:00.000Z',
    position: 0,
  },
};

function terminalSnapshot(
  text: string,
  activityStatus: 'active' | 'idle',
  agentType: 'claude' | 'codex' = 'codex',
  lastActivityTime = '2026-01-01T00:02:00.000Z',
) {
  return {
    initialized: true,
    scrollbackBuffer: text,
    screenText: text,
    alternateScreenBuffer: '',
    isAlternateScreen: false,
    activityStatus,
    lastActivityTime,
    currentCommand: agentType,
    isCliPanel: true,
    isCliReady: true,
    agentType,
  } as const;
}

function createServices(overrides: Partial<AppServices> = {}): AppServices {
  // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
  return {
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    app: {
      getVersion: vi.fn(() => '2.3.8'),
      isPackaged: false,
    } as AppServices['app'],
    getMainWindow: () => null,
    databaseService: {
      getAllProjects: vi.fn(() => [project]),
      createProject: vi.fn((name: string, repoPath: string): Project => ({
        ...project,
        id: 2,
        name,
        path: repoPath,
        active: false,
      })),
    },
    configManager: {
      getConfig: vi.fn(() => ({
        agentContext: {
          managedAgentsMd: true,
        },
      })),
    },
    sessionManager: {
      getAllSessions: vi.fn(() => [session]),
      getSessionsForProject: vi.fn(() => [session]),
      getSession: vi.fn(() => session),
      getProjectForSession: vi.fn(() => project),
      getPanelOutputs: vi.fn(() => [{
        sessionId: session.id,
        panelId: terminalPanel.id,
        type: 'stdout',
        data: 'ready\n',
        timestamp: new Date('2026-01-01T00:02:00.000Z'),
      }]),
      getProjectContext: vi.fn(() => ({
        commandRunner: {
          wslContext: null,
        },
      })),
      getProjectContextByProjectId: vi.fn(() => ({
        commandRunner: {
          wslContext: null,
          execAsync: vi.fn(async (command: string) => {
            if (command.includes('--version')) {
              return { stdout: 'codex 0.141.0\n', stderr: '' };
            }
            return { stdout: '/usr/local/bin/codex\n', stderr: '' };
          }),
        },
      })),
    },
    taskQueue: {
      createSessionAndWait: vi.fn(async () => ({ sessionId: session.id })),
    },
    analyticsManager: {
      track: vi.fn(),
      hashSessionId: vi.fn((id: string) => `hash-${id}`),
    },
    spotlightManager: {},
    worktreeManager: {
      getUpstream: vi.fn(async () => null),
      getSessionComparisonBranch: vi.fn(async () => 'main'),
    },
    gitStatusManager: {
      getGitStatus: vi.fn(async () => ({
        state: 'clean',
        hasUncommittedChanges: false,
        hasUntrackedFiles: false,
        ahead: 0,
        behind: 0,
        totalCommits: 0,
      })),
    },
    ...overrides,
  } as AppServices;
}

const tempDirs: string[] = [];

function createTempGitRepo(name = 'repo'): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-test-'));
  tempDirs.push(parent);
  const repoPath = path.join(parent, name);
  fs.mkdirSync(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Pane Test'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'pane-test@example.invalid'], { cwd: repoPath, stdio: 'ignore' });
  return repoPath;
}

function createRegistry(services = createServices()): PaneCommandRegistry {
  const registry = new PaneCommandRegistry();
  // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
  registerRunpaneHandlers({} as never, services, registry);
  return registry;
}

function registerSessionsDeleteStub(
  registry: PaneCommandRegistry,
  services: AppServices,
  options: {
    onArchive?: () => Promise<void> | void;
    result?: { success: boolean; error?: string };
  } = {},
): ReturnType<typeof vi.fn> {
  const handler = vi.fn(async (sessionId: string) => {
    if (options.result) {
      return options.result;
    }
    if (services.archiveProgressManager) {
      services.archiveProgressManager.addTask(sessionId, 'issue-252', 'issue-252-worktree', 'Pane', async () => {
        await options.onArchive?.();
      });
    } else {
      setImmediate(() => options.onArchive?.());
    }
    return { success: true };
  });
  registry.register('sessions:delete', handler);
  return handler;
}

describe('runpane IPC handlers', () => {
  beforeEach(() => {
    session.isFavorite = undefined;
    session.favoritePinnedAt = undefined;
    vi.mocked(panelManager.createPanel).mockReset();
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.getPanelsForSession).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.mocked(panelManager.setActivePanel).mockReset();
    vi.mocked(panelManager.ensureExplorerPanel).mockReset().mockResolvedValue(undefined);
    vi.mocked(panelManager.ensureDiffPanel).mockReset().mockResolvedValue(undefined);
    vi.mocked(terminalPanelManager.initializeTerminal).mockReset();
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReset();
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReset();
    vi.mocked(terminalPanelManager.getCleanTerminalScrollback).mockReset();
    vi.mocked(panelDatabase.getPanelBuffers).mockReset().mockReturnValue(null);
    vi.mocked(terminalPanelManager.writeToTerminal).mockReset();
    vi.mocked(terminalPanelManager.getLastOutputAt).mockReset();
    vi.mocked(terminalPanelManager.getOutputGeneration).mockReset();
    vi.mocked(terminalPanelManager.getInputScreenText).mockReset();
    vi.mocked(terminalPanelManager.deliverPendingInitialInput).mockReset();
    vi.mocked(terminalPanelManager.getAgentStatus).mockReset();
    vi.mocked(terminalPanelManager.getOutputGeneration).mockReturnValue(0);
    vi.mocked(terminalPanelManager.getAgentStatus).mockReturnValue('idle');
    vi.mocked(usageManager.getPaneCosts).mockReturnValue({
      fromMs: Date.parse('2025-12-01T00:00:00.000Z'),
      toMs: Date.parse('2026-01-03T00:00:00.000Z'),
      pricingAsOf: 'bundled · 2026-08-26',
      byPane: {
        panes: [paneCostOne, paneCostTwo],
        unattributed: {
          ...zeroUsageTotals,
          uncachedCostUsd: 0,
          uncachedInputTokens: 0,
          cacheHitRate: 0,
          byModel: [],
        },
      },
      totals: paneCostOne,
    });

    vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) =>
      panelId === terminalPanel.id ? terminalPanel : undefined
    );
    vi.mocked(panelManager.getPanelsForSession).mockImplementation((sessionId: string) =>
      sessionId === session.id ? [terminalPanel] : []
    );
    vi.mocked(panelManager.setActivePanel).mockResolvedValue();
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(null);
    vi.mocked(terminalPanelManager.getCleanTerminalScrollback).mockResolvedValue(null);
  });

  describe('runpane:panes:adopt', () => {
    function adoptionServices(repoPath: string, worktreePath: string, duplicate = false): AppServices {
      const adoptionProject = { ...project, path: repoPath };
      const commandRunner = new CommandRunner(adoptionProject);
      // SAFETY: These test doubles provide the exact service members exercised by adoption.
      return createServices({
        databaseService: {
          ...createServices().databaseService,
          getAllProjects: vi.fn(() => [adoptionProject]),
          getAllSessionsIncludingArchived: vi.fn(() => duplicate
            ? [{ id: 'existing', name: 'Existing', worktree_path: worktreePath }]
            : []),
          deleteArchivedSessionPermanently: vi.fn(() => true),
        // SAFETY: This fixture implements the database methods used by the handler.
        } as never,
        sessionManager: {
          ...createServices().sessionManager,
          getProjectContextByProjectId: vi.fn(() => ({
            project: adoptionProject,
            pathResolver: new PathResolver(adoptionProject),
            commandRunner,
          })),
          createSession: vi.fn(async () => ({ ...session, worktreePath, worktreeOwnership: 'external' })),
          updateSession: vi.fn(async () => undefined),
          getSession: vi.fn(() => ({ ...session, status: 'stopped', worktreePath, worktreeOwnership: 'external' })),
          emitSessionCreated: vi.fn(),
          archiveSession: vi.fn(async () => undefined),
        // SAFETY: This fixture implements the session-manager methods used by the handler.
        } as never,
        worktreeManager: {
          ...createServices().worktreeManager,
          listWorktrees: vi.fn(async () => [{ path: worktreePath, branch: 'feature' }]),
        // SAFETY: This fixture implements the worktree-manager method used by the handler.
        } as never,
      });
    }

    it('resolves symlinks and previews a registered worktree without mutation', async () => {
      const repoPath = createTempGitRepo('adopt-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'adopt-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'feature', worktreePath], { cwd: repoPath, stdio: 'ignore' });
      const symlinkPath = path.join(path.dirname(repoPath), 'adopt-link');
      fs.symlinkSync(worktreePath, symlinkPath, process.platform === 'win32' ? 'junction' : 'dir');
      const services = adoptionServices(repoPath, worktreePath);

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: symlinkPath, name: 'Adopted', tool: { agent: 'codex' } }],
        dryRun: true,
      }]);

      expect(result).toMatchObject({ ok: true, items: [{ ok: true, worktreePath: fs.realpathSync.native(worktreePath) }] });
      expect(services.sessionManager.createSession).not.toHaveBeenCalled();
      expect(panelManager.createPanel).not.toHaveBeenCalled();
    });

    it('refuses paths outside the selected repo and duplicate canonical paths', async () => {
      const repoPath = createTempGitRepo('guard-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const otherPath = createTempGitRepo('other-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: otherPath, stdio: 'ignore' });
      const baseRequest = { repo: { id: project.id }, panes: [{ path: otherPath, name: 'Other', tool: { agent: 'codex' } }], dryRun: true };

      const wrongRepo = await createRegistry(adoptionServices(repoPath, path.join(repoPath, 'expected')))
        .invoke('runpane:panes:adopt', [baseRequest]);
      expect(wrongRepo).toMatchObject({ ok: false, items: [{ error: { message: expect.stringContaining('not a git worktree') } }] });

      const duplicateAlias = path.join(path.dirname(otherPath), 'other-alias');
      fs.symlinkSync(otherPath, duplicateAlias, process.platform === 'win32' ? 'junction' : 'dir');
      const duplicateServices = adoptionServices(otherPath, otherPath, true);
      vi.mocked(duplicateServices.databaseService.getAllSessionsIncludingArchived).mockReturnValue([
        // SAFETY: This minimal persisted-session fixture supplies the fields used by duplicate validation.
        { id: 'existing', name: 'Existing', worktree_path: duplicateAlias } as never,
      ]);
      const duplicate = await createRegistry(duplicateServices)
        .invoke('runpane:panes:adopt', [baseRequest]);
      expect(duplicate).toMatchObject({ ok: false, items: [{ error: { message: expect.stringContaining('already registered') } }] });
    });

    it('emits the stopped pane, creates one configured terminal, and stages resume input', async () => {
      const repoPath = createTempGitRepo('create-adopt-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'create-adopt-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'create-adopt', worktreePath], { cwd: repoPath, stdio: 'ignore' });
      const services = adoptionServices(repoPath, worktreePath);
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Adopted', tool: { agent: 'codex' }, resume: 'thread-1' }],
      }]);

      expect(result).toMatchObject({ ok: true, items: [{ ok: true, sessionId: session.id }] });
      expect(panelManager.createPanel).toHaveBeenCalledTimes(1);
      expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
        initialState: expect.objectContaining({ agentSessionId: 'thread-1', initialCommand: undefined }),
      }));
      expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(
        terminalPanel.id,
        expect.stringMatching(/^codex resume --yolo ["']thread-1["']$/u),
      );
      expect(services.sessionManager.emitSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'stopped' }),
        expect.objectContaining({ createDefaultTerminalOnCreate: false }),
      );
    });

    it('rolls back the pane record when terminal setup fails', async () => {
      const repoPath = createTempGitRepo('rollback-adopt-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'rollback-adopt-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'rollback-adopt', worktreePath], { cwd: repoPath, stdio: 'ignore' });
      const services = adoptionServices(repoPath, worktreePath);
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockRejectedValue(new Error('PTY failed'));

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Adopted', tool: { agent: 'codex' } }],
      }]);

      expect(result).toMatchObject({ ok: false, items: [{ ok: false, sessionId: undefined }] });
      expect(services.sessionManager.archiveSession).toHaveBeenCalledWith(session.id);
      expect(services.databaseService.deleteArchivedSessionPermanently).toHaveBeenCalledWith(session.id);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('reports top-level runpane doctor health', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:doctor');

    expect(result).toMatchObject({
      ok: true,
      app: {
        version: '2.3.8',
        isPackaged: false,
        platform: process.platform,
      },
      repos: {
        count: 1,
        active: {
          id: project.id,
          name: project.name,
          path: project.path,
          active: true,
          sessionCount: 1,
        },
      },
      agentContext: {
        recommendedFirstCommands: expect.arrayContaining([
          'runpane doctor --json',
          'runpane agent-context --json',
        ]),
      },
    });
    // SAFETY: The doctor result shape is asserted immediately above before its channels are inspected.
    const daemon = (result as { daemon: { channels: string[] } }).daemon;
    expect(daemon.channels).toContain('runpane:doctor');
    expect(daemon.channels).toContain('runpane:panes:rename');
    expect(daemon.channels).toContain('runpane:panes:focus');
  });

  it('lists saved Pane repositories with session counts', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:repos:list');

    expect(result).toMatchObject({
      ok: true,
      repos: [{
        id: 1,
        name: 'Pane',
        path: '/repo/pane',
        active: true,
        sessionCount: 1,
      }],
    });
  });

  it('returns a workspace baseline for panes and CLI panels', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:workspace:state');

    expect(result).toMatchObject({
      ok: true,
      generation: 0,
      entries: [
        {
          kind: 'pane.created', paneId: session.id, baseline: true,
          panels: [{ panelId: terminalPanel.id, title: terminalPanel.title, agentType: 'codex', agentState: 'idle' }],
        },
        { kind: 'agent.ready', paneId: session.id, panelId: terminalPanel.id, panelTitle: terminalPanel.title, baseline: true },
      ],
    });
  });

  it('waits for filtered workspace journal entries after an explicit generation', async () => {
    const workspaceJournal = new WorkspaceJournal();
    const registry = createRegistry(createServices({ workspaceJournal }));
    workspaceJournal.append({
      kind: 'agent.ready',
      paneId: session.id,
      paneName: session.name,
      panelId: terminalPanel.id,
      source: 'agent',
      from: 'working',
      to: 'idle',
    });

    const result = await registry.invoke('runpane:workspace:wait', [{
      since: 0,
      timeoutMs: 0,
      kinds: ['agent.ready'],
    }]);

    expect(result).toMatchObject({
      ok: true,
      generation: 1,
      timedOut: false,
      entries: [{ kind: 'agent.ready', gen: 1, paneId: session.id }],
    });
  });

  it('emits session-scoped, re-firing idle events without advancing the journal cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot('› ship it', 'idle', 'codex', '2026-01-01T11:49:00.000Z'),
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-idle-test-'));
    tempDirs.push(directory);
    const workspaceJournal = new WorkspaceJournal();
    const workspaceCursorStore = new WorkspaceCursorStore(path.join(directory, 'workspace-cursors.json'));
    const registry = createRegistry(createServices({ workspaceJournal, workspaceCursorStore }));

    const first = await registry.invoke('runpane:workspace:wait', [{
      as: 'fresh',
      timeoutMs: 0,
      idleAfterMs: 600_000,
      includeHeldInputPresence: true,
    }]);
    const immediate = await registry.invoke('runpane:workspace:wait', [{
      as: 'fresh',
      timeoutMs: 0,
      idleAfterMs: 600_000,
    }]);

    expect(first).toMatchObject({
      generation: 0,
      reset: { reason: 'first-use' },
      timedOut: false,
      entries: [{
        kind: 'agent.idle',
        paneId: session.id,
        panelId: terminalPanel.id,
        agentType: 'codex',
        idleCount: 1,
        heldInputPresent: true,
      }],
    });
    expect(first).not.toMatchObject({ entries: [{ heldInput: expect.anything() }] });
    expect(immediate).toMatchObject({ generation: 0, entries: [], timedOut: true });

    vi.setSystemTime(new Date('2026-01-01T12:09:00.000Z'));
    const refired = await registry.invoke('runpane:workspace:wait', [{
      as: 'fresh',
      timeoutMs: 0,
      idleAfterMs: 600_000,
    }]);
    expect(refired).toMatchObject({
      generation: 0,
      timedOut: false,
      entries: [{ kind: 'agent.idle', idleCount: 2, idleMs: 1_200_000 }],
    });
    expect(refired).not.toMatchObject({ entries: [{ heldInputPresent: expect.anything() }] });

    const explicitRegistry = createRegistry(createServices({ workspaceJournal: new WorkspaceJournal() }));
    const explicit = await explicitRegistry.invoke('runpane:workspace:wait', [{
      since: 0,
      timeoutMs: 0,
      idleAfterMs: 600_000,
    }]);
    expect(explicit.entries).toContainEqual(expect.objectContaining({ kind: 'agent.idle', idleCount: 2 }));
    expect(explicit.entries[0]).not.toHaveProperty('heldInputPresent');
    const advancedWindow = await explicitRegistry.invoke('runpane:workspace:wait', [{
      since: 0,
      timeoutMs: 0,
      idleAfterMs: 600_000,
      idleWindowStartMs: Date.now(),
    }]);
    expect(advancedWindow.entries).toEqual([]);
  });

  it('keeps idle disabled for old clients and applies workspace filters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot('›', 'idle', 'codex', '2026-01-01T11:49:00.000Z'),
    );
    const registry = createRegistry(createServices({ workspaceJournal: new WorkspaceJournal() }));

    const omitted = await registry.invoke('runpane:workspace:wait', [{ since: 0, timeoutMs: 0 }]);
    const zero = await registry.invoke('runpane:workspace:wait', [{ since: 0, timeoutMs: 0, idleAfterMs: 0 }]);
    const wrongKind = await registry.invoke('runpane:workspace:wait', [{
      since: 0, timeoutMs: 0, idleAfterMs: 600_000, kinds: ['agent.ready'],
    }]);
    const excluded = await registry.invoke('runpane:workspace:wait', [{
      since: 0, timeoutMs: 0, idleAfterMs: 600_000, excludePaneIds: [session.id], agentsOnly: true,
    }]);
    expect(omitted.entries).toEqual([]);
    expect(zero.entries).toEqual([]);
    expect(wrongKind.entries).toEqual([]);
    expect(excluded.entries).toEqual([]);

    vi.mocked(terminalPanelManager.getAgentStatus).mockReturnValue('working');
    const busy = await registry.invoke('runpane:workspace:wait', [{
      since: 0, timeoutMs: 0, idleAfterMs: 600_000, kinds: ['agent.idle'], agentsOnly: true,
    }]);
    expect(busy.entries).toEqual([]);
  });

  it('retains due idle entries across epoch and cursor-truncated resets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot('›', 'idle', 'codex', '2026-01-01T11:49:00.000Z'),
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-idle-reset-test-'));
    tempDirs.push(directory);

    const epochJournal = new WorkspaceJournal();
    const epochCursors = new WorkspaceCursorStore(path.join(directory, 'epoch-cursors.json'));
    epochCursors.create('epoch-consumer', 0, 'old-epoch');
    const epochRegistry = createRegistry(createServices({
      workspaceJournal: epochJournal,
      workspaceCursorStore: epochCursors,
    }));
    const epoch = await epochRegistry.invoke('runpane:workspace:wait', [{
      as: 'epoch-consumer', timeoutMs: 0, idleAfterMs: 600_000,
    }]);
    expect(epoch).toMatchObject({ reset: { reason: 'epoch-changed' } });
    expect(epoch.entries).toContainEqual(expect.objectContaining({ kind: 'agent.idle', idleCount: 1 }));

    const truncatedJournal = new WorkspaceJournal({ capacity: 2 });
    for (const paneId of ['one', 'two', 'three']) {
      truncatedJournal.append({ kind: 'pane.created', paneId, paneName: paneId, source: 'session' });
    }
    const truncatedRegistry = createRegistry(createServices({ workspaceJournal: truncatedJournal }));
    const truncated = await truncatedRegistry.invoke('runpane:workspace:wait', [{
      since: 0, timeoutMs: 0, idleAfterMs: 600_000,
    }]);
    expect(truncated).toMatchObject({ reset: { reason: 'cursor-truncated' }, dropped: 1 });
    expect(truncated.entries).toContainEqual(expect.objectContaining({ kind: 'agent.idle', idleCount: 1 }));
  });

  describe('workspace wait cadence', () => {
    const readyEntry = {
      kind: 'agent.ready' as const,
      paneId: session.id,
      paneName: session.name,
      panelId: terminalPanel.id,
      agentType: 'codex',
      source: 'agent' as const,
      from: 'working' as const,
      to: 'idle' as const,
    };
    const busyEntry = { ...readyEntry, kind: 'agent.busy' as const, from: 'idle' as const, to: 'working' as const };
    const cadenceRequest = { as: 'cadence', timeoutMs: 0, idleAfterMs: 0, kinds: ['agent.ready'], settleMs: 60_000 };

    function cadenceRegistry(options: { capacity?: number } = {}) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cadence-test-'));
      tempDirs.push(directory);
      const workspaceJournal = new WorkspaceJournal(options);
      const workspaceCursorStore = new WorkspaceCursorStore(path.join(directory, 'workspace-cursors.json'));
      const registry = createRegistry(createServices({ workspaceJournal, workspaceCursorStore }));
      return { workspaceJournal, workspaceCursorStore, registry };
    }

    it('keeps a pending READY across a timed-out request and delivers it once settled', async () => {
      const { workspaceJournal, registry } = cadenceRegistry();
      await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      workspaceJournal.append(readyEntry);

      const held = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(held).toMatchObject({ entries: [], timedOut: true });

      vi.setSystemTime(new Date('2026-01-01T12:01:01.000Z'));
      const settled = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(settled.entries).toEqual([expect.objectContaining({ kind: 'agent.ready', gen: 1, settledMs: 61_000 })]);
      expect(await registry.invoke('runpane:workspace:wait', [cadenceRequest])).toMatchObject({ entries: [] });
    });

    it('resumes a reused instance from its read cursor so held entries are delivered exactly once', async () => {
      const { workspaceJournal, workspaceCursorStore, registry } = cadenceRegistry();
      await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      workspaceJournal.append(readyEntry);
      vi.setSystemTime(new Date('2026-01-01T12:00:30.000Z'));
      workspaceJournal.append({ ...readyEntry, panelId: 'panel-other' });
      expect((await registry.invoke('runpane:workspace:wait', [cadenceRequest])).entries).toEqual([]);
      const cursor = workspaceCursorStore.get('cadence');
      expect(cursor?.pendingGen ?? cursor?.gen).toBe(0);

      vi.setSystemTime(new Date('2026-01-01T12:01:01.000Z'));
      const first = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(first.entries.map((entry: { gen: number }) => entry.gen)).toEqual([1]);
      expect(first.generation).toBe(2);
      vi.setSystemTime(new Date('2026-01-01T12:01:31.000Z'));
      const second = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(second.entries.map((entry: { gen: number }) => entry.gen)).toEqual([2]);
      expect((await registry.invoke('runpane:workspace:wait', [cadenceRequest])).entries).toEqual([]);
    });

    it('drains every page before flushing so a later BUSY still cancels an older READY', async () => {
      const { workspaceJournal, registry } = cadenceRegistry();
      await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      workspaceJournal.append(readyEntry);
      vi.setSystemTime(new Date('2026-01-01T12:00:01.000Z'));
      workspaceJournal.append(busyEntry);

      vi.setSystemTime(new Date('2026-01-01T12:02:00.000Z'));
      const result = await registry.invoke('runpane:workspace:wait', [{ ...cadenceRequest, limit: 1 }]);
      expect(result).toMatchObject({ entries: [], generation: 2 });
      vi.setSystemTime(new Date('2026-01-01T12:05:00.000Z'));
      expect(await registry.invoke('runpane:workspace:wait', [{ ...cadenceRequest, limit: 1 }])).toMatchObject({ entries: [] });
    });

    it('never moves the durable cursor past a held READY', async () => {
      const { workspaceJournal, workspaceCursorStore, registry } = cadenceRegistry();
      await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      workspaceJournal.append({ ...readyEntry, panelId: 'panel-other', paneId: 'session-other', paneName: 'other' });
      workspaceJournal.append(readyEntry);
      workspaceJournal.append({ kind: 'pane.created', paneId: 'session-new', paneName: 'new', source: 'session' });

      const held = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(held.entries).toEqual([]);
      const cursor = workspaceCursorStore.get('cadence');
      expect(cursor?.pendingGen ?? cursor?.gen).toBe(0);

      const raw = await registry.invoke('runpane:workspace:wait', [{ as: 'cadence', timeoutMs: 0, idleAfterMs: 0, kinds: ['agent.ready'] }]);
      expect(raw.entries.map((entry: { gen: number }) => entry.gen)).toEqual([1, 2]);
    });

    it('discards held entries when the consumer changes its filter', async () => {
      const { workspaceJournal, registry } = cadenceRegistry();
      const scoped = { ...cadenceRequest, paneIds: [session.id] };
      await registry.invoke('runpane:workspace:wait', [scoped]);
      workspaceJournal.append(readyEntry);
      expect((await registry.invoke('runpane:workspace:wait', [scoped])).entries).toEqual([]);

      vi.setSystemTime(new Date('2026-01-01T12:02:00.000Z'));
      const rescoped = await registry.invoke('runpane:workspace:wait', [{ ...cadenceRequest, paneIds: ['session-other'] }]);
      expect(rescoped.entries).toEqual([]);
      vi.setSystemTime(new Date('2026-01-01T12:04:00.000Z'));
      expect((await registry.invoke('runpane:workspace:wait', [{ ...cadenceRequest, paneIds: ['session-other'] }])).entries).toEqual([]);
    });

    it('discards held entries when the consumer changes its idle schedule', async () => {
      const { workspaceJournal, registry } = cadenceRegistry();
      await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      workspaceJournal.append(readyEntry);
      expect((await registry.invoke('runpane:workspace:wait', [cadenceRequest])).entries).toEqual([]);

      vi.setSystemTime(new Date('2026-01-01T12:02:00.000Z'));
      const rescheduled = { ...cadenceRequest, idleBackoff: true };
      // The rebuilt cadence re-reads the held READY from the capped cursor and settles it afresh.
      const first = await registry.invoke('runpane:workspace:wait', [rescheduled]);
      expect(first.entries.map((entry: { kind: string; gen: number }) => [entry.kind, entry.gen])).toEqual([['agent.ready', 1]]);
    });

    it('discards the cadence on a cursor-truncated reset', async () => {
      const { workspaceJournal, registry } = cadenceRegistry({ capacity: 2 });
      await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      workspaceJournal.append(readyEntry);
      expect((await registry.invoke('runpane:workspace:wait', [cadenceRequest])).entries).toEqual([]);

      for (const paneId of ['one', 'two', 'three']) {
        workspaceJournal.append({ kind: 'pane.created', paneId, paneName: paneId, source: 'session' });
      }
      const truncated = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(truncated).toMatchObject({ reset: { reason: 'cursor-truncated' } });

      vi.setSystemTime(new Date('2026-01-01T12:02:00.000Z'));
      const after = await registry.invoke('runpane:workspace:wait', [cadenceRequest]);
      expect(after.entries).toEqual([]);
      expect(after.reset).toBeUndefined();
    });
  });

  it('announces an evicted named workspace cursor as unknown', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cursor-test-'));
    tempDirs.push(directory);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const workspaceJournal = new WorkspaceJournal();
    const workspaceCursorStore = new WorkspaceCursorStore(
      path.join(directory, 'workspace-cursors.json'),
      () => now,
    );
    workspaceCursorStore.create('monitor', 0, workspaceJournal.epoch);
    now += 31 * 24 * 60 * 60 * 1000;
    const registry = createRegistry(createServices({ workspaceJournal, workspaceCursorStore }));

    const result = await registry.invoke('runpane:workspace:wait', [{ as: 'monitor', timeoutMs: 0 }]);

    expect(result).toMatchObject({
      ok: true,
      reset: { reason: 'unknown-consumer' },
    });
    expect(result.entries).toContainEqual(
      expect.objectContaining({ kind: 'pane.created', baseline: true }),
    );
  });

  it('emits zero data events for a new --from now cursor on a populated workspace', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cursor-test-'));
    tempDirs.push(directory);
    const workspaceJournal = new WorkspaceJournal();
    const workspaceCursorStore = new WorkspaceCursorStore(
      path.join(directory, 'workspace-cursors.json'),
    );
    const sessions = Array.from({ length: 60 }, (_, i) => ({
      ...session,
      id: `session-${i}`,
      name: `pane-${i}`,
    }));
    const panels = sessions.map((s, i) => ({
      ...terminalPanel,
      id: `panel-${i}`,
      sessionId: s.id,
    }));
    const services = createServices({ workspaceJournal, workspaceCursorStore });
    vi.mocked(services.sessionManager.getAllSessions).mockReturnValue(sessions);
    vi.mocked(services.sessionManager.getSessionsForProject).mockReturnValue(sessions);
    vi.mocked(panelManager.getPanelsForSession).mockImplementation((sessionId: string) => {
      const panel = panels.find(p => p.sessionId === sessionId);
      return panel ? [panel] : [];
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:workspace:wait', [{
      as: 'from-now-test',
      from: 'now',
      timeoutMs: 0,
    }]);

    expect(result).toMatchObject({
      ok: true,
      reset: { reason: 'first-use' },
      entries: [],
    });
  });

  it('emits baseline entries for a new --from earliest cursor', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cursor-test-'));
    tempDirs.push(directory);
    const workspaceJournal = new WorkspaceJournal();
    const workspaceCursorStore = new WorkspaceCursorStore(
      path.join(directory, 'workspace-cursors.json'),
    );
    const registry = createRegistry(createServices({ workspaceJournal, workspaceCursorStore }));

    const result = await registry.invoke('runpane:workspace:wait', [{
      as: 'earliest-test',
      from: 'earliest',
      timeoutMs: 0,
    }]);

    expect(result).toMatchObject({
      ok: true,
      reset: { reason: 'first-use' },
    });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries).toContainEqual(
      expect.objectContaining({ kind: 'pane.created', baseline: true }),
    );
  });

  it('emits zero data events for a new cursor with default from (implicit now)', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cursor-test-'));
    tempDirs.push(directory);
    const workspaceJournal = new WorkspaceJournal();
    const workspaceCursorStore = new WorkspaceCursorStore(
      path.join(directory, 'workspace-cursors.json'),
    );
    const registry = createRegistry(createServices({ workspaceJournal, workspaceCursorStore }));

    const result = await registry.invoke('runpane:workspace:wait', [{
      as: 'default-from-test',
      timeoutMs: 0,
    }]);

    expect(result).toMatchObject({
      ok: true,
      reset: { reason: 'first-use' },
      entries: [],
    });
  });

  it('advances a truncated named cursor when its filter excludes retained entries', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cursor-test-'));
    tempDirs.push(directory);
    const workspaceJournal = new WorkspaceJournal({ capacity: 2 });
    const workspaceCursorStore = new WorkspaceCursorStore(
      path.join(directory, 'workspace-cursors.json'),
    );
    workspaceCursorStore.create('monitor', 0, workspaceJournal.epoch);
    const registry = createRegistry(createServices({ workspaceJournal, workspaceCursorStore }));
    for (const paneId of ['one', 'two', 'three']) {
      workspaceJournal.append({ kind: 'pane.created', paneId, paneName: paneId, source: 'session' });
    }

    const truncated = await registry.invoke('runpane:workspace:wait', [{
      as: 'monitor',
      kinds: ['panel.exited'],
      timeoutMs: 0,
    }]);
    const resumed = await registry.invoke('runpane:workspace:wait', [{
      as: 'monitor',
      kinds: ['panel.exited'],
      timeoutMs: 0,
    }]);

    expect(truncated).toMatchObject({
      generation: 3,
      entries: [],
      timedOut: true,
      dropped: 1,
      reset: { reason: 'cursor-truncated' },
    });
    expect(resumed).toMatchObject({ generation: 3, entries: [], timedOut: true });
    expect(resumed.dropped).toBeUndefined();
    expect(resumed.reset).toBeUndefined();
  });

  it('dry-runs adding an existing git repository without saving it', async () => {
    const repoPath = createTempGitRepo('pane-addon');
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        getAllProjects: vi.fn(() => []),
        createProject: vi.fn(),
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSessionsForProject: vi.fn(() => []),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:repos:add', [{
      path: repoPath,
      dryRun: true,
    }]);

    expect(result).toMatchObject({
      ok: true,
      created: false,
      dryRun: true,
      preview: {
        name: 'pane-addon',
        path: repoPath,
        alreadyExists: false,
        wouldCreate: true,
      },
    });
    expect(services.databaseService.createProject).not.toHaveBeenCalled();
  });

  it('adds an existing git repository idempotently', async () => {
    const repoPath = createTempGitRepo();
    const savedProject: Project = {
      ...project,
      id: 3,
      name: 'New Repo',
      path: repoPath,
      active: false,
    };
    const projects: Project[] = [];
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        getAllProjects: vi.fn(() => projects),
        createProject: vi.fn((name: string, savedPath: string): Project => {
          const created = { ...savedProject, name, path: savedPath };
          projects.push(created);
          return created;
        }),
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSessionsForProject: vi.fn(() => []),
      } as never,
    });
    const registry = createRegistry(services);

    const created = await registry.invoke('runpane:repos:add', [{
      path: repoPath,
      name: 'Registered Repo',
    }]);
    const existing = await registry.invoke('runpane:repos:add', [{
      path: repoPath,
    }]);

    expect(created).toMatchObject({
      ok: true,
      created: true,
      repo: {
        id: 3,
        name: 'Registered Repo',
        path: repoPath,
        active: false,
        sessionCount: 0,
      },
    });
    expect(existing).toMatchObject({
      ok: true,
      created: false,
      repo: {
        id: 3,
        name: 'Registered Repo',
        path: repoPath,
      },
    });
    expect(services.databaseService.createProject).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(repoPath, 'AGENTS.md'), 'utf8')).toContain('runpane agent-context');
  });

  it('rejects repo add for a non-git directory', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-test-'));
    tempDirs.push(parent);
    const registry = createRegistry(createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        getAllProjects: vi.fn(() => []),
        createProject: vi.fn(),
      } as never,
    }));

    await expect(registry.invoke('runpane:repos:add', [{
      path: parent,
      dryRun: true,
    }])).rejects.toThrow('Repo path must be an existing git repository');
  });

  it('dry-runs pane creation with contract-backed agent templates', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      dryRun: true,
      panes: [{
        name: 'issue-252',
        tool: {
          agent: 'codex',
          initialInput: 'Kick off discussion',
        },
      }],
    }]);

    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        name: 'issue-252',
        tool: {
          title: RUNPANE_CONTRACT.agentTemplates.codex.title,
          command: RUNPANE_CONTRACT.agentTemplates.codex.command,
          agent: 'codex',
        },
      }],
    });
    expect(services.taskQueue?.createSessionAndWait).not.toHaveBeenCalled();
  });

  it('lists panes scoped to a repository with panel counts', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:list', [{
      repo: 'active',
    }]);

    expect(result).toMatchObject({
      ok: true,
      repo: {
        id: project.id,
        name: project.name,
      },
      panes: [{
        id: session.id,
        paneId: session.id,
        name: session.name,
        status: session.status,
        worktreePath: session.worktreePath,
        repoId: project.id,
        repoName: project.name,
        panelCount: 1,
        pinned: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    expect(panelManager.getPanelsForSession).toHaveBeenCalledWith(session.id);
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panes:list',
        status: 'success',
        repo_id: project.id,
        result_count: 1,
      }),
    );
  });

  it('reports pane costs with totals and analytics in the unscoped form', async () => {
    const services = createServices();
    const registry = createRegistry(services);
    const result = await registry.invoke('runpane:panes:cost', [{}]);

    expect(result).toMatchObject({
      ok: true,
      panes: [paneCostOne, paneCostTwo],
      unattributed: expect.any(Object),
      totals: expect.any(Object),
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({ action: 'panes:cost', status: 'success', result_count: 2 }),
    );
  });

  it('returns only the requested pane without workspace totals', async () => {
    const registry = createRegistry();
    const result = await registry.invoke('runpane:panes:cost', [{ paneId: session.id }]);

    expect(result).toMatchObject({ ok: true, panes: [paneCostOne] });
    expect(result).not.toHaveProperty('unattributed');
    expect(result).not.toHaveProperty('totals');
  });

  it('zero-fills a known pane outside the report window', async () => {
    const outside = {
      ...session,
      id: 'outside',
      name: 'Outside',
      archived: 1,
      worktree_path: session.worktreePath,
      project_id: session.projectId,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const services = createServices({
      // SAFETY: This fixture preserves the default service shape and overrides only the tested lookup.
      databaseService: {
        ...createServices().databaseService,
        getSession: vi.fn(() => outside),
      } as AppServices['databaseService'],
    });
    const result = await createRegistry(services).invoke('runpane:panes:cost', [{ paneId: outside.id }]);

    expect(result).toMatchObject({
      panes: [{ paneId: outside.id, paneName: outside.name, archived: true, totalTokens: 0, byModel: [] }],
    });
  });

  it('treats a zone-less SQLite created_at as UTC in the fallback pane result', async () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const outside = {
        ...session,
        id: 'outside-sqlite-time',
        name: 'Outside SQLite time',
        archived: true,
        worktree_path: session.worktreePath,
        project_id: session.projectId,
        created_at: '2026-08-27 12:00:00',
      };
      const services = createServices({
        // SAFETY: This fixture preserves the default service shape and overrides only the tested lookup.
        databaseService: {
          ...createServices().databaseService,
          getSession: vi.fn(() => outside),
        } as AppServices['databaseService'],
      });

      const result = await createRegistry(services).invoke('runpane:panes:cost', [{ paneId: outside.id }]);

      expect(result).toMatchObject({
        panes: [{
          paneId: outside.id,
          createdAtMs: Date.UTC(2026, 7, 27, 12, 0, 0),
        }],
      });
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it('rejects an unknown pane id', async () => {
    const services = createServices({
      // SAFETY: This fixture preserves the default service shape and overrides only the tested lookup.
      databaseService: {
        ...createServices().databaseService,
        getSession: vi.fn(() => undefined),
      } as AppServices['databaseService'],
    });

    await expect(createRegistry(services).invoke('runpane:panes:cost', [{ paneId: 'missing' }]))
      .rejects.toThrow('No Pane pane found with id missing');
  });

  it('scopes pane costs to a repository and omits workspace totals', async () => {
    const result = await createRegistry().invoke('runpane:panes:cost', [{ repo: 'active' }]);

    expect(result).toMatchObject({ ok: true, panes: [paneCostOne] });
    expect(result).not.toHaveProperty('unattributed');
    expect(result).not.toHaveProperty('totals');
  });

  it('lists panels for a pane', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:list', [{
      paneId: session.id,
    }]);

    expect(result).toMatchObject({
      ok: true,
      paneId: session.id,
      panels: [{
        id: terminalPanel.id,
        panelId: terminalPanel.id,
        paneId: session.id,
        type: 'terminal',
        title: 'Codex',
        active: true,
        initialized: true,
        agentType: 'codex',
        isCliPanel: true,
        position: 0,
      }],
    });
    expect(terminalPanelManager.isTerminalInitialized).toHaveBeenCalledWith(terminalPanel.id);
  });

  it('creates a background terminal panel inside an existing pane', async () => {
    const reviewerPanel: ToolPanel = {
      id: 'panel-reviewer',
      sessionId: session.id,
      type: 'terminal',
      title: 'Claude Code',
      state: {
        isActive: false,
        customState: {
          agentType: 'claude',
          isCliPanel: true,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:03:00.000Z',
        lastActiveAt: '2026-01-01T00:03:00.000Z',
        position: 1,
      },
    };
    vi.mocked(panelManager.createPanel).mockResolvedValue(reviewerPanel);

    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:create', [{
      paneId: session.id,
      tool: {
        agent: 'claude',
        initialInput: '/review',
      },
      source: 'agent',
      noFocus: true,
    }]);

    expect(panelManager.createPanel).toHaveBeenCalledWith({
      sessionId: session.id,
      type: 'terminal',
      title: RUNPANE_CONTRACT.agentTemplates.claude.title,
      initialState: {
        initialCommand: RUNPANE_CONTRACT.agentTemplates.claude.command,
        initialInput: '/review',
        initialInputMode: 'argument',
        initialInputSubmitStrategy: 'enter',
        agentType: 'claude',
        isCliPanel: true,
      },
      activate: false,
    });
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      reviewerPanel,
      session.worktreePath,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      paneId: session.id,
      panelId: reviewerPanel.id,
      active: false,
      nextCommand: `runpane panels output --panel ${reviewerPanel.id} --limit 200 --json`,
    });
  });

  it('reads panel output as records and concatenated text', async () => {
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getPanelOutputs: vi.fn(() => [{
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'hello\n',
          timestamp: new Date('2026-01-01T00:02:00.000Z'),
        }, {
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'json',
          data: { type: 'system', message: 'ok' },
          timestamp: new Date('2026-01-01T00:03:00.000Z'),
        }]),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(services.sessionManager.getPanelOutputs).toHaveBeenCalledWith(terminalPanel.id, 3);
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      limit: 2,
      returnedCount: 2,
      hasMore: false,
      outputs: [{
        type: 'stdout',
        data: 'hello\n',
        timestamp: '2026-01-01T00:02:00.000Z',
      }, {
        type: 'json',
        data: { type: 'system', message: 'ok' },
        timestamp: '2026-01-01T00:03:00.000Z',
      }],
      text: 'hello\n{"type":"system","message":"ok"}\n',
    });
  });

  it('reads live terminal scrollback before persisted output records', async () => {
    vi.mocked(terminalPanelManager.getCleanTerminalScrollback).mockResolvedValue('first\nsecond\nthird\n');
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(services.sessionManager.getPanelOutputs).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      limit: 2,
      returnedCount: 1,
      hasMore: true,
      outputs: [{
        type: 'stdout',
        data: 'third\n',
        timestamp: '2026-01-01T00:01:00.000Z',
      }],
      text: 'third\n',
    });
  });

  it('strips terminal control sequences from persisted scrollback output', async () => {
    vi.mocked(panelDatabase.getPanelBuffers).mockReturnValue({
      scrollback: '\x1b[31mred\x1b[0m\n[?25h[?2004hprompt$ [?2004lecho next\nnext[?25l[?25h\n',
      serialized: null,
      alternate: null,
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 200,
    }]);

    expect(result).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      text: 'red\nprompt$ echo next\nnext\n',
      outputs: [{
        type: 'stdout',
        data: 'red\nprompt$ echo next\nnext\n',
      }],
    });
  });

  it('reads persisted terminal scrollback when the terminal is not live', async () => {
    // Persisted bytes live in panel_buffers, never in the panel state.
    vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) =>
      panelId === terminalPanel.id ? terminalPanel : undefined
    );
    vi.mocked(panelDatabase.getPanelBuffers).mockImplementation((panelId: string) =>
      panelId === terminalPanel.id
        ? { scrollback: 'persisted one\npersisted two\n', serialized: null, alternate: null }
        : null
    );
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 10,
    }]);

    expect(services.sessionManager.getPanelOutputs).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      text: 'persisted one\npersisted two\n',
    });
  });

  it('falls back to persisted output records when terminal scrollback is unavailable', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(services.sessionManager.getPanelOutputs).toHaveBeenCalledWith(terminalPanel.id, 3);
    expect(result).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      text: 'ready\n',
    });
  });

  it('defaults panel output reads to the latest 200 records', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
    }]);

    expect(services.sessionManager.getPanelOutputs).toHaveBeenCalledWith(terminalPanel.id, 201);
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      limit: 200,
      returnedCount: 1,
      hasMore: false,
    });
  });

  it('marks panel output as having more history when the internal fetch finds an extra record', async () => {
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getPanelOutputs: vi.fn(() => [{
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'old\n',
          timestamp: new Date('2026-01-01T00:01:00.000Z'),
        }, {
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'middle\n',
          timestamp: new Date('2026-01-01T00:02:00.000Z'),
        }, {
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'latest\n',
          timestamp: new Date('2026-01-01T00:03:00.000Z'),
        }]),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(result).toMatchObject({
      ok: true,
      limit: 2,
      returnedCount: 2,
      hasMore: true,
      outputs: [{
        type: 'stdout',
        data: 'middle\n',
      }, {
        type: 'stdout',
        data: 'latest\n',
      }],
      text: 'middle\nlatest\n',
    });
  });

  it('sends input to an initialized terminal panel without logging input text', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:input', [{
      panelId: terminalPanel.id,
      input: 'echo hi\r',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, 'echo hi\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 8,
      nextCommand: `runpane panels output --panel ${terminalPanel.id} --limit 200 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:input',
        status: 'success',
        pane_id_hash: `hash-${session.id}`,
        panel_id_hash: `hash-${terminalPanel.id}`,
        input_bytes: 8,
      }),
    );
    expect(services.analyticsManager?.track).not.toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        input: 'echo hi\r',
      }),
    );
  });

  it('submits text with a terminal Enter and returns validation guidance', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'echo hello\n',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, 'echo hello\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 11,
      enter: 'cr',
      nextCommand: `runpane panels wait --panel ${terminalPanel.id} --for ready --timeout-ms 30000 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:submit',
        status: 'success',
        input_bytes: 11,
      }),
    );
    expect(services.analyticsManager?.track).not.toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        input: 'echo hello\n',
      }),
    );
  });

  it('stages text before submitting an idle Codex composer', async () => {
    vi.useFakeTimers();
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('› Ask Codex to do anything\n', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› Continue the existing task\n', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('Working\n', 'active'));
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Continue the existing task\n',
    }]);

    await vi.advanceTimersByTimeAsync(600);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(
      1,
      terminalPanel.id,
      'Continue the existing task',
    );
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(
      2,
      terminalPanel.id,
      '\x1b[13;5u\r',
    );
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      sequenceName: 'codex-ctrl-enter-cr',
      verifiedSubmitted: true,
    });
  });

  it('stages text before submitting a Claude composer', async () => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot(`${rule}\n❯ \n${rule}\n`, 'active', 'claude'))
      .mockReturnValueOnce(terminalSnapshot(`${rule}\n❯ Read and follow brief.md\n${rule}\n`, 'idle', 'claude'))
      .mockReturnValueOnce(terminalSnapshot(`${rule}\n❯ Read and follow brief.md\n${rule}\n`, 'idle', 'claude'))
      .mockReturnValue(terminalSnapshot(`❯ Read and follow brief.md\n✻ Working\n${rule}\n❯ \n${rule}\n`, 'active', 'claude'));
    vi.mocked(terminalPanelManager.getOutputGeneration).mockReturnValueOnce(0).mockReturnValue(1);
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Read and follow brief.md\n',
    }]);

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, 'Read and follow brief.md');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, terminalPanel.id, '\r');
    expect(result).toMatchObject({
      ok: true,
      sequenceName: 'enter-cr',
      verifiedSubmitted: true,
    });
  });

  it('does not take a Claude redraw frame as proof that the prompt was submitted', async () => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    let staged = false;
    let enters = 0;
    let redrawShown = false;
    vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
      if (data === '\r') enters += 1;
      else staged = true;
    });
    vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => {
      if (!staged) return terminalSnapshot(`${rule}\n❯\n${rule}\n`, 'active', 'claude');
      if (enters === 1 && !redrawShown) {
        redrawShown = true;
        return terminalSnapshot('Claude Code v2.1.281\n', 'active', 'claude');
      }
      return terminalSnapshot(`${rule}\n❯ Read and follow brief.md\n${rule}\n`, 'idle', 'claude');
    });
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Read and follow brief.md',
    }]);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pendingResult;

    expect(redrawShown).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      verifiedSubmitted: false,
      blocked: { kind: 'agent-prompt' },
    });
  });

  it('fails when Claude holds the text in its composer after Enter even if the echo never showed before it', async () => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    let enters = 0;
    vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
      if (data === '\r') enters += 1;
    });
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => (
      enters === 0
        ? terminalSnapshot(`${rule}\n❯\n${rule}\n`, 'active', 'claude')
        : terminalSnapshot(`${rule}\n❯ Read and follow brief.md\n${rule}\n`, 'idle', 'claude')
    ));
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Read and follow brief.md',
    }]);

    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pendingResult;

    expect(enters).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      verifiedSubmitted: false,
      blocked: { kind: 'agent-prompt' },
    });
  });

  it('waits for a starting Claude to draw its composer and echo the text before pressing Enter', async () => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    let staged = false;
    let enters = 0;
    let startupPolls = 0;
    let echoPolls = 0;
    let echoPollsBeforeEnter = -1;
    vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
      if (data === '\r') {
        enters += 1;
        echoPollsBeforeEnter = echoPolls;
      } else {
        staged = true;
      }
    });
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => {
      if (startupPolls < 5) {
        startupPolls += 1;
        return terminalSnapshot('Claude Code v2.1.281\n', 'active', 'claude');
      }
      if (!staged) return terminalSnapshot(`${rule}\n❯\n${rule}\n`, 'active', 'claude');
      if (echoPolls < 3) {
        echoPolls += 1;
        return terminalSnapshot(`${rule}\n❯\n${rule}\n`, 'active', 'claude');
      }
      if (enters === 0) return terminalSnapshot(`${rule}\n❯ Read and follow brief.md\n${rule}\n`, 'idle', 'claude');
      return terminalSnapshot(`❯ Read and follow brief.md\n✻ Working\n${rule}\n❯\n${rule}\n`, 'active', 'claude');
    });
    // Claude can be silent for seconds before its first frame.
    vi.mocked(terminalPanelManager.getLastOutputAt).mockReturnValue(new Date(Date.now() - 60_000).toISOString());
    vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => echoPolls);
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Read and follow brief.md',
    }]);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, 'Read and follow brief.md');
    expect(startupPolls).toBe(5);
    expect(echoPollsBeforeEnter).toBe(3);
    expect(result).toMatchObject({ ok: true, verifiedSubmitted: true });
  });

  it('sends a plain submit when a quiet Claude screen shows no composer', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      ...terminalSnapshot('Do you want to proceed?\n ❯ 1. Yes\n   2. No\n', 'idle', 'claude'),
      isAlternateScreen: true,
      alternateScreenBuffer: 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n',
    });
    vi.mocked(terminalPanelManager.getLastOutputAt).mockReturnValue(new Date(Date.now() - 60_000).toISOString());
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: '1',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(1);
    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '1\r');
    expect(result).toMatchObject({ ok: true, verifiedSubmitted: false });
  });

  it('waits for the staged text itself, not an older draft, before pressing Enter on Claude', async () => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    let staged = false;
    let generation = 0;
    let generationAtEnter = -1;
    vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
      if (data === '\r') generationAtEnter = generation;
      else staged = true;
    });
    vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => generation);
    let pollsAfterStage = 0;
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => {
      if (!staged) return terminalSnapshot(`${rule}\n❯ old draft\n${rule}\n`, 'idle', 'claude');
      pollsAfterStage += 1;
      if (pollsAfterStage === 4) generation = 1;
      if (generationAtEnter >= 0) return terminalSnapshot(`✻ Working\n${rule}\n❯\n${rule}\n`, 'active', 'claude');
      return terminalSnapshot(`${rule}\n❯ old draft${generation ? ' Continue' : ''}\n${rule}\n`, 'idle', 'claude');
    });
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: ' Continue',
    }]);

    await vi.advanceTimersByTimeAsync(2_000);
    await pendingResult;

    expect(generationAtEnter).toBe(1);
  });

  it('does not report success when submitted text remains in an idle Codex composer', async () => {
    vi.useFakeTimers();
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('› Ask Codex to do anything\n', 'idle'))
      .mockReturnValue(terminalSnapshot('› Continue the existing task\n', 'idle'));
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Continue the existing task',
    }]);

    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pendingResult;

    expect(result).toMatchObject({
      ok: false,
      sequenceName: 'codex-ctrl-enter-cr',
      verifiedSubmitted: false,
      blocked: {
        kind: 'agent-prompt',
        suggestedCommand: `runpane panels screen --panel ${terminalPanel.id} --limit 80 --json`,
      },
    });
  });

  it('submits a Codex composer with the effective Ctrl+Enter sequence and verifies composer cleared', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: '[Pasted Content 1024 chars]\nCtrl+Enter to submit\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'idle',
        lastActivityTime: '2026-01-01T00:02:00.000Z',
        currentCommand: 'codex',
        isCliPanel: true,
        isCliReady: true,
        agentType: 'codex',
      })
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: 'working on task\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'active',
        lastActivityTime: '2026-01-01T00:02:01.000Z',
        currentCommand: 'codex',
        isCliPanel: true,
        isCliReady: false,
        agentType: 'codex',
      });
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:submit-composer', [{
      panelId: terminalPanel.id,
      strategy: 'auto',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '\x1b[13;5u\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 8,
      strategy: 'codex-ctrl-enter',
      sequenceName: 'codex-ctrl-enter-cr',
      verifiedSubmitted: true,
      nextCommand: `runpane panels wait --panel ${terminalPanel.id} --for ready --timeout-ms 30000 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:submit-composer',
        status: 'success',
        input_bytes: 8,
      }),
    );
  });

  it('blocks submit-composer when the Codex pasted-content composer remains visible', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: '[Pasted Content 1024 chars]\nCtrl+Enter to submit\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:submit-composer', [{
      panelId: terminalPanel.id,
      strategy: 'auto',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '\x1b[13;5u\r');
    expect(result).toMatchObject({
      ok: false,
      panelId: terminalPanel.id,
      inputBytes: 8,
      strategy: 'codex-ctrl-enter',
      sequenceName: 'codex-ctrl-enter-cr',
      verifiedSubmitted: false,
      blocked: {
        kind: 'agent-prompt',
        suggestedCommand: `runpane panels screen --panel ${terminalPanel.id} --limit 80 --json`,
      },
    });
  });

  it('reads compact panel screen state from live alternate-screen output', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'old\n',
      alternateScreenBuffer: '\x1b[Hstale cursor-addressed bytes',
      screenText: 'one\ntwo\nthree',
      isAlternateScreen: true,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:screen', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      source: 'alternateScreen',
      limit: 2,
      returnedLineCount: 2,
      hasMore: true,
      text: 'two\nthree',
      state: {
        initialized: true,
        activityStatus: 'idle',
        isCliReady: true,
        agentType: 'codex',
      },
      composer: {
        isPresent: false,
        hasUndeliveredText: false,
      },
    });
  });

  it.each([
    ['› Continue the existing task\n  gpt-5.6 high\n', true],
    ['› [Pasted Content 2048 chars]\n  Ctrl+Enter to submit\n', true],
    ['› Ask Codex to do anything\n  gpt-5.6 high\n', false],
    ['previous output\n›\n  gpt-5.6 high\n', false],
  ])('reports whether the Codex composer has undelivered text', async (text, expected) => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot(text, 'idle'),
    );
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:screen', [{
      panelId: terminalPanel.id,
    }]);

    expect(result).toMatchObject({
      composer: {
        isPresent: true,
        hasUndeliveredText: expected,
      },
    });
  });

  it.each([
    ['held prompt', `⏺ Done\n${'─'.repeat(40)}\n❯ Read and follow brief.md\n${'─'.repeat(40)}\n  ⏵⏵ bypass permissions on\n`, true, true],
    ['held paste', `${'─'.repeat(40)}\n❯ [Pasted text #1 +10 lines]\n${'─'.repeat(40)}\n`, true, true],
    ['held second line', `${'─'.repeat(40)}\n❯ Read the brief\n  then report back\n${'─'.repeat(40)}\n`, true, true],
    ['empty composer', `${'─'.repeat(40)}\n❯\n${'─'.repeat(40)}\n`, true, false],
    ['menu choice', 'Quick safety check\n ❯ No, exit\n   Yes, I trust this folder\n', false, false],
  ])('reports whether the Claude composer has undelivered text: %s', async (_name, text, isPresent, hasUndeliveredText) => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot(text, 'idle', 'claude'),
    );
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:screen', [{
      panelId: terminalPanel.id,
    }]);

    expect(result).toMatchObject({ composer: { isPresent, hasUndeliveredText } });
  });

  it('does not count a dim Claude placeholder suggestion as undelivered text', async () => {
    const rule = '─'.repeat(40);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot(`${rule}\n❯ Try "fix lint errors"\n${rule}\n`, 'idle', 'claude'),
    );
    vi.mocked(terminalPanelManager.getInputScreenText).mockReturnValue(`${rule}\n❯\n${rule}`);
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:screen', [{
      panelId: terminalPanel.id,
    }]);

    expect(result).toMatchObject({
      text: expect.stringContaining('Try "fix lint errors"'),
      composer: { isPresent: true, hasUndeliveredText: false },
    });
  });

  it('waits for ready terminal state with bounded screen output', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'agent ready\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      timeoutMs: 10,
    }]);

    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      condition: 'ready',
      matched: true,
      timedOut: false,
      screen: {
        source: 'scrollback',
        text: 'agent ready\n',
      },
      nextCommand: `runpane panels screen --panel ${terminalPanel.id} --limit 80 --json`,
    });
  });

  it('does not treat persisted terminal state as live wait readiness', async () => {
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(false);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(null);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      ...terminalPanel,
      state: {
        ...terminalPanel.state,
        customState: {
          ...terminalPanel.state.customState,
          isInitialized: true,
          isCliReady: true,
        },
      },
    });
    vi.mocked(panelDatabase.getPanelBuffers).mockReturnValue({ scrollback: 'persisted ready\n', serialized: null, alternate: null });
    const registry = createRegistry();

    const ready = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      condition: 'ready',
      timeoutMs: 1,
      intervalMs: 1,
    }]);
    const initialized = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      condition: 'initialized',
      timeoutMs: 1,
      intervalMs: 1,
    }]);

    expect(ready).toMatchObject({
      ok: false,
      condition: 'ready',
      matched: false,
      timedOut: true,
      state: {
        initialized: false,
        isCliPanel: true,
      },
      screen: {
        source: 'persistedOutput',
        text: 'persisted ready\n',
      },
    });
    // SAFETY: The wait handler resolves to a result object whose `state` mirrors the panel snapshot exercised here.
    expect((ready as { state: { isCliReady?: unknown } }).state.isCliReady).toBeUndefined();
    expect(initialized).toMatchObject({
      ok: false,
      condition: 'initialized',
      matched: false,
      timedOut: true,
      state: {
        initialized: false,
      },
    });
  });

  it('reports Codex update prompts as blockers instead of ready', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'Update available! 0.136.0 -> 0.141.0\n2. Skip\nPress enter to continue\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      timeoutMs: 10,
    }]);

    expect(result).toMatchObject({
      ok: false,
      condition: 'ready',
      matched: false,
      timedOut: false,
      blocked: {
        kind: 'codex-update',
        suggestedCommand: `runpane panels submit --panel ${terminalPanel.id} --text "2" --yes --json`,
      },
    });
  });

  it('diagnoses built-in agents through the Pane project context', async () => {
    const lookupCommand = process.platform === 'win32' ? 'where codex' : 'command -v codex';
    const executablePath = process.platform === 'win32'
      ? 'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd'
      : '/home/user/.local/bin/codex';
    const execAsync = vi.fn(async (command: string) => {
      if (command === lookupCommand) {
        return { stdout: `${executablePath}\n`, stderr: '' };
      }
      if (command === 'codex --version') {
        return { stdout: 'codex 0.141.0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getProjectContextByProjectId: vi.fn(() => ({
          commandRunner: {
            wslContext: null,
            execAsync,
          },
        })),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:agents:doctor', [{
      agent: 'codex',
      repo: 'active',
    }]);

    expect(execAsync).toHaveBeenCalledWith(lookupCommand, project.path, expect.objectContaining({
      timeout: 5000,
      silent: true,
    }));
    expect(result).toMatchObject({
      ok: true,
      agent: 'codex',
      available: true,
      executablePath,
      version: 'codex 0.141.0',
      repo: {
        id: project.id,
        name: project.name,
      },
    });
  });

  // The ~/.local/bin fallback is POSIX-only; on a win32 host the doctor gates cursor out entirely.
  it.skipIf(process.platform === 'win32')('diagnoses cursor through the ~/.local/bin fallback when PATH misses it', async () => {
    const fallbackLookup = 'command -v "$HOME/.local/bin/cursor-agent"';
    const execAsync = vi.fn(async (command: string) => {
      if (command === 'command -v cursor-agent') {
        return { stdout: '', stderr: '' };
      }
      if (command === fallbackLookup) {
        return { stdout: '/home/user/.local/bin/cursor-agent\n', stderr: '' };
      }
      if (command === '"$HOME/.local/bin/cursor-agent" --version') {
        return { stdout: '2026.08.11-e8db854\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getProjectContextByProjectId: vi.fn(() => ({
          commandRunner: {
            wslContext: null,
            execAsync,
          },
        })),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:agents:doctor', [{
      agent: 'cursor',
      repo: 'active',
    }]);

    expect(execAsync).toHaveBeenCalledWith(fallbackLookup, project.path, expect.objectContaining({
      timeout: 5000,
      silent: true,
    }));
    expect(result).toMatchObject({
      ok: true,
      agent: 'cursor',
      available: true,
      executablePath: '/home/user/.local/bin/cursor-agent',
      version: '2026.08.11-e8db854',
    });
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    expect((result as { warnings?: string[] }).warnings?.some((w) => w.includes('PATH'))).toBe(true);
  });

  it('finds cursor installed inside a WSL repo environment', async () => {
    const execAsync = vi.fn(async (command: string) => command.includes('--version')
      ? { stdout: '2026.08.11-e8db854\n', stderr: '' }
      : { stdout: '/home/user/.local/bin/cursor-agent\n', stderr: '' });
    const base = createServices();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...base.databaseService,
        getAllProjects: vi.fn(() => [{ ...project, wsl_enabled: true, wsl_distribution: 'Ubuntu' }]),
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...base.sessionManager,
        getProjectContextByProjectId: vi.fn(() => ({
          commandRunner: {
            wslContext: null,
            execAsync,
          },
        })),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:agents:doctor', [{
      agent: 'cursor',
      repo: 'active',
    }]);

    expect(result).toMatchObject({
      ok: true,
      agent: 'cursor',
      environment: 'wsl',
      available: true,
      executablePath: '/home/user/.local/bin/cursor-agent',
      version: '2026.08.11-e8db854',
    });
    expect(execAsync).toHaveBeenCalledWith('command -v cursor-agent', project.path, expect.any(Object));
  });

  it('allows cursor pane creation for WSL repos', async () => {
    const wslProject = { ...project, wsl_enabled: true, wsl_distribution: 'Ubuntu' };
    const base = createServices();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...base.databaseService,
        getAllProjects: vi.fn(() => [wslProject]),
      } as never,
    });

    const result = await createRegistry(services).invoke('runpane:panes:create', [{
      repo: 'active',
      dryRun: true,
      panes: [{ name: 'cursor-wsl', tool: { agent: 'cursor' } }],
    }]);

    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        tool: {
          title: 'Cursor',
          command: 'cursor-agent --force --trust',
          agent: 'cursor',
        },
      }],
    });
    expect(services.taskQueue?.createSessionAndWait).not.toHaveBeenCalled();
  });

  it('allows cursor panel creation for WSL repos', async () => {
    const wslProject = { ...project, wsl_enabled: true, wsl_distribution: 'Ubuntu' };
    const base = createServices();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...base.sessionManager,
        getProjectForSession: vi.fn(() => wslProject),
        getProjectContext: vi.fn(() => ({
          commandRunner: {
            wslContext: {
              enabled: true,
              distribution: 'Ubuntu',
              linuxPath: session.worktreePath,
            },
          },
        })),
      } as never,
    });

    vi.mocked(panelManager.createPanel).mockResolvedValue({
      ...terminalPanel,
      title: 'Cursor',
      state: { isActive: false },
    });

    const result = await createRegistry(services).invoke('runpane:panels:create', [{
      paneId: session.id,
      tool: { agent: 'cursor' },
    }]);

    expect(result).toMatchObject({
      ok: true,
      paneId: session.id,
      panelId: terminalPanel.id,
      tool: {
        title: 'Cursor',
        command: 'cursor-agent --force --trust',
        agent: 'cursor',
      },
    });
    expect(panelManager.createPanel).toHaveBeenCalled();
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: terminalPanel.id }),
      session.worktreePath,
      expect.objectContaining({ enabled: true, distribution: 'Ubuntu' }),
    );
  });

  it('creates a session, terminal panel, and initial-input state', async () => {
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Codex',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);

    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      timeoutMs: 1234,
      panes: [{
        name: 'issue-252',
        worktreeName: 'issue-252-worktree',
        baseBranch: 'main',
        tool: {
          agent: 'codex',
          title: 'Issue 252',
          initialInput: '$discussion https://github.com/dcouple/Pane/issues/252',
        },
      }],
    }]);

    expect(services.taskQueue?.createSessionAndWait).toHaveBeenCalledWith({
      prompt: '',
      worktreeTemplate: 'issue-252-worktree',
      projectId: project.id,
      baseBranch: 'main',
      toolType: 'none',
      startPinned: true,
      activateOnCreate: false,
    }, expect.objectContaining({ timeoutMs: 1234 }));
    expect(panelManager.createPanel).toHaveBeenCalledWith({
      sessionId: session.id,
      type: 'terminal',
      title: 'Issue 252',
      initialState: {
        initialCommand: RUNPANE_CONTRACT.agentTemplates.codex.command,
        initialInput: '$discussion https://github.com/dcouple/Pane/issues/252',
        initialInputMode: 'argument',
        initialInputSubmitStrategy: 'enter',
        agentType: 'codex',
        isCliPanel: true,
      },
      activate: false,
    });
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'panel-1' }),
      session.worktreePath,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        sessionId: session.id,
        panelId: 'panel-1',
        worktreePath: session.worktreePath,
        active: false,
        focused: false,
        nextCommand: 'runpane panels output --panel panel-1 --limit 200 --json',
      }],
    });
  });

  it('creates a pinned pane without focusing it', async () => {
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      ...terminalPanel,
      state: { ...terminalPanel.state, isActive: false },
    });
    const databaseRow = {
      id: session.id,
      is_favorite: 0,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      favorite_pinned_at: null as string | null,
    };
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...createServices().databaseService,
        getSession: vi.fn(() => databaseRow),
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      taskQueue: {
        createSessionAndWait: vi.fn(async (request: { startPinned?: boolean }) => {
          databaseRow.is_favorite = request.startPinned ? 1 : 0;
          databaseRow.favorite_pinned_at = request.startPinned ? '2026-07-21 12:00:00' : null;
          session.isFavorite = request.startPinned;
          session.favoritePinnedAt = databaseRow.favorite_pinned_at ?? undefined;
          return { sessionId: session.id };
        }),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      noFocus: true,
      panes: [{
        name: 'pinned-background-pane',
        pinned: true,
        tool: { agent: 'codex' },
      }],
    }]);

    expect(services.taskQueue?.createSessionAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ startPinned: true, activateOnCreate: false }),
      expect.any(Object),
    );
    expect(result).toMatchObject({
      ok: true,
      items: [{ pinned: true, focused: false }],
    });
    expect(databaseRow.is_favorite).toBe(1);
    expect(databaseRow.favorite_pinned_at).not.toBeNull();
  });

  it('returns the created pane id when session setup times out after the session was created', async () => {
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      taskQueue: {
        createSessionAndWait: vi.fn(async (...[, options]: Parameters<TaskQueue['createSessionAndWait']>) => {
          options?.onSessionCreated?.('session-created-early');
          throw new Error('Timed out waiting for session creation job 7');
        }),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      panes: [{ name: 'slow-setup-pane', tool: { agent: 'claude' } }],
    }]);

    expect(result).toMatchObject({
      ok: false,
      items: [{
        ok: false,
        paneId: 'session-created-early',
        sessionId: 'session-created-early',
        error: { code: 'ERR_RUNPANE_PANE_CREATE_FAILED' },
      }],
    });
  });

  it('pins created panes by default and honours an explicit pinned false', async () => {
    const startPinnedCalls: (boolean | undefined)[] = [];
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      taskQueue: {
        createSessionAndWait: vi.fn(async (request: { startPinned?: boolean }) => {
          startPinnedCalls.push(request.startPinned);
          return { sessionId: session.id };
        }),
      } as never,
    });
    const registry = createRegistry(services);

    await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      panes: [{ name: 'default-pinned-pane', tool: { agent: 'codex' } }],
    }]);
    await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      panes: [{ name: 'opted-out-pane', pinned: false, tool: { agent: 'codex' } }],
    }]);

    expect(startPinnedCalls).toEqual([true, false]);
  });

  it('previews the default pinned state in a dry run', async () => {
    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      dryRun: true,
      panes: [
        { name: 'default-pinned-pane', tool: { agent: 'codex' } },
        { name: 'opted-out-pane', pinned: false, tool: { agent: 'codex' } },
      ],
    }]);

    expect(result).toMatchObject({
      ok: true,
      items: [{ pinned: true }, { pinned: false }],
    });
  });

  it('sets pinned state declaratively and idempotently', async () => {
    const databaseRow = {
      id: session.id,
      is_favorite: 0,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      favorite_pinned_at: null as string | null,
    };
    const setSessionFavorite = vi.fn((_id: string, pinned: boolean) => {
      databaseRow.is_favorite = pinned ? 1 : 0;
      databaseRow.favorite_pinned_at = pinned
        ? databaseRow.favorite_pinned_at ?? '2026-07-21 12:00:00'
        : null;
      return databaseRow;
    });
    const emit = vi.fn();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...createServices().databaseService,
        setSessionFavorite,
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        emit,
      } as never,
    });
    const registry = createRegistry(services);

    const firstPin = await registry.invoke('runpane:panes:pin', [{ paneId: session.id, pinned: true }]);
    const pinTimestamp = databaseRow.favorite_pinned_at;
    const secondPin = await registry.invoke('runpane:panes:pin', [{ paneId: session.id, pinned: true }]);
    const listedPinned = await registry.invoke('runpane:panes:list', [{ repo: 'active' }]);

    expect(firstPin).toEqual({
      ok: true,
      paneId: session.id,
      pinned: true,
      favoritePinnedAt: pinTimestamp,
      generation: 0,
    });
    expect(secondPin).toEqual(firstPin);
    expect(databaseRow.favorite_pinned_at).toBe(pinTimestamp);
    expect(listedPinned).toMatchObject({ panes: [{ paneId: session.id, pinned: true }] });

    const firstUnpin = await registry.invoke('runpane:panes:pin', [{ paneId: session.id, pinned: false }]);
    const secondUnpin = await registry.invoke('runpane:panes:pin', [{ paneId: session.id, pinned: false }]);

    expect(firstUnpin).toEqual({ ok: true, paneId: session.id, pinned: false, favoritePinnedAt: undefined, generation: 0 });
    expect(secondUnpin).toEqual(firstUnpin);
    expect(databaseRow).toMatchObject({ is_favorite: 0, favorite_pinned_at: null });
    expect(setSessionFavorite).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenLastCalledWith('session-updated', expect.objectContaining({
      id: session.id,
      isFavorite: false,
      favoritePinnedAt: undefined,
    }));
  });

  it('dry-runs pinned state changes without mutating or emitting', async () => {
    session.isFavorite = false;
    session.favoritePinnedAt = undefined;
    const databaseRow = {
      id: session.id,
      is_favorite: 0,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      favorite_pinned_at: null as string | null,
    };
    const setSessionFavorite = vi.fn((_id: string, pinned: boolean) => {
      databaseRow.is_favorite = pinned ? 1 : 0;
      databaseRow.favorite_pinned_at = pinned ? '2026-07-21 12:00:00' : null;
      return databaseRow;
    });
    const emit = vi.fn();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...createServices().databaseService,
        setSessionFavorite,
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        emit,
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:pin', [{
      paneId: session.id,
      pinned: true,
      dryRun: true,
    }]);

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      paneId: session.id,
      pinned: true,
      favoritePinnedAt: undefined,
    });
    expect(databaseRow).toMatchObject({ is_favorite: 0, favorite_pinned_at: null });
    expect(session.isFavorite).toBe(false);
    expect(setSessionFavorite).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects missing and non-boolean pinned state', async () => {
    const registry = createRegistry();

    await expect(registry.invoke('runpane:panes:pin', [{ paneId: session.id }]))
      .rejects.toThrow('pinned as a boolean');
    await expect(registry.invoke('runpane:panes:pin', [{ paneId: session.id, pinned: 'yes' }]))
      .rejects.toThrow('pinned as a boolean');
  });

  it('renames a pane, trims the name, emits an update, and returns the updated pane', async () => {
    const renamedSession = { ...session };
    const updateSession = vi.fn(() => ({ id: session.id, name: 'renamed pane' }));
    const emit = vi.fn();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...createServices().databaseService,
        updateSession,
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSession: vi.fn(() => renamedSession),
        emit,
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:rename', [{
      paneId: session.id,
      name: '  renamed pane  ',
    }]);

    expect(updateSession).toHaveBeenCalledWith(session.id, { name: 'renamed pane' });
    expect(renamedSession.name).toBe('renamed pane');
    expect(emit).toHaveBeenCalledWith('session-updated', renamedSession);
    expect(result).toMatchObject({
      ok: true,
      pane: { paneId: session.id, name: 'renamed pane' },
    });
  });

  it('dry-runs pane rename without persisting, mutating, or emitting', async () => {
    const originalSession = { ...session };
    const updateSession = vi.fn();
    const emit = vi.fn();
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...createServices().databaseService,
        updateSession,
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSession: vi.fn(() => originalSession),
        emit,
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:rename', [{
      paneId: session.id,
      name: 'preview name',
      dryRun: true,
    }]);

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      pane: { paneId: session.id, name: 'preview name' },
    });
    expect(originalSession.name).toBe(session.name);
    expect(updateSession).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects empty rename names and accepts names without a new length limit', async () => {
    const longName = 'x'.repeat(10_000);
    const renamedSession = { ...session };
    const updateSession = vi.fn(() => ({ id: session.id, name: longName }));
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      databaseService: {
        ...createServices().databaseService,
        updateSession,
      } as never,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSession: vi.fn(() => renamedSession),
        emit: vi.fn(),
      } as never,
    });
    const registry = createRegistry(services);

    await expect(registry.invoke('runpane:panes:rename', [{ paneId: session.id, name: '' }]))
      .rejects.toThrow('non-empty name');
    await expect(registry.invoke('runpane:panes:rename', [{ paneId: session.id, name: '   ' }]))
      .rejects.toThrow('non-empty name');

    const result = await registry.invoke('runpane:panes:rename', [{ paneId: session.id, name: longName }]);
    expect(result).toMatchObject({ pane: { name: longName } });
  });

  it('rejects rename for a pane id that does not exist', async () => {
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSession: vi.fn(() => undefined),
      } as never,
    });
    const registry = createRegistry(services);

    await expect(registry.invoke('runpane:panes:rename', [{ paneId: 'missing-pane', name: 'new name' }]))
      .rejects.toThrow('No Pane pane found with id missing-pane');
  });

  it('serializes multi-pane session creation before enqueueing the next pane', async () => {
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Codex',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);

    let activeCreates = 0;
    let maxActiveCreates = 0;
    const createSessionAndWait = vi.fn(async () => {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      await Promise.resolve();
      activeCreates -= 1;
      return { sessionId: session.id };
    });
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const services = createServices({
      taskQueue: {
        createSessionAndWait,
      },
    } as never);
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      concurrency: 3,
      panes: [{
        name: 'issue-one',
        tool: { agent: 'codex' },
      }, {
        name: 'issue-two',
        tool: { agent: 'codex' },
      }],
    }]);

    // SAFETY: The panes:create handler always resolves to a result object carrying an `ok` flag.
    expect((result as { ok: boolean }).ok).toBe(true);
    expect(createSessionAndWait).toHaveBeenCalledTimes(2);
    expect(maxActiveCreates).toBe(1);
  });

  it('creates panes with readiness validation when requested', async () => {
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Codex',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'ready\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });

    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      concurrency: 3,
      panes: [{
        name: 'issue-252',
        tool: {
          agent: 'codex',
        },
      }],
    }]);

    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        panelId: 'panel-1',
        readiness: {
          ok: true,
          condition: 'ready',
          matched: true,
          timedOut: false,
          state: {
            initialized: true,
            isCliReady: true,
          },
          nextCommand: 'runpane panels screen --panel panel-1 --limit 80 --json',
        },
        nextCommand: 'runpane panels screen --panel panel-1 --limit 80 --json',
      }],
    });
  });

  it('reports earned Claude argument delivery during wait-ready pane creation', async () => {
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const claudePanel = {
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Claude Code',
      state: {
        customState: {
          initialInputSentAt: '2026-01-01T00:02:00.000Z',
        },
      },
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never;
    vi.mocked(panelManager.createPanel).mockResolvedValue(claudePanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'claude ready\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'claude',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'claude',
    });

    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{
        name: 'issue-302',
        tool: {
          agent: 'claude',
          initialInput: 'Please start issue 302',
        },
      }],
    }]);

    expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
      initialState: expect.objectContaining({
        initialCommand: RUNPANE_CONTRACT.agentTemplates.claude.command,
        initialInput: 'Please start issue 302',
        initialInputMode: 'argument',
        initialInputSubmitStrategy: 'enter',
        agentType: 'claude',
      }),
    }));
    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        panelId: 'panel-1',
        initialInput: {
          delivered: true,
          submitted: true,
          strategy: 'argument',
          sequenceName: 'argument',
          verifiedSubmitted: true,
        },
      }],
    });
  });

  it('marks pane creation unsuccessful when Claude argument delivery is unverified', async () => {
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const claudePanel = {
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Claude Code',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never;
    vi.mocked(panelManager.createPanel).mockResolvedValue(claudePanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: '',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'claude',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'claude',
    });

    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{
        name: 'issue-302',
        tool: {
          agent: 'claude',
          initialInput: 'Please start issue 302',
        },
      }],
    }]);

    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      items: [{
        ok: false,
        panelId: 'panel-1',
        initialInput: {
          submitted: false,
          delivered: false,
          strategy: 'argument',
          sequenceName: 'argument',
          verifiedSubmitted: false,
        },
      }],
    });
  });

  it('retries a same-millisecond swallowed Codex slash command after output generation advances', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:59.000Z'));
    const codexPanel = {
      ...terminalPanel,
      state: { isActive: false, customState: { agentType: 'codex', isCliPanel: true } },
    };
    vi.mocked(panelManager.createPanel).mockResolvedValue(codexPanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(codexPanel);
    vi.mocked(terminalPanelManager.getOutputGeneration)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValue(2);
    vi.mocked(terminalPanelManager.getLastOutputAt).mockReturnValue('2026-01-01T00:01:59.300Z');
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('Working on TM-x\n›', 'active'));

    const resultPromise = createRegistry(createServices()).invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-358', tool: { agent: 'codex', initialInput: '/do TM-x' } }],
    }]);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
      initialState: expect.objectContaining({
        initialInput: '/do TM-x',
        initialInputSentAt: expect.any(String),
        initialInputSubmitStrategy: 'codex-ctrl-enter',
      }),
    }));
    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(3);
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, codexPanel.id, '/do TM-x');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, codexPanel.id, '\x1b[13;5u\r');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(3, codexPanel.id, '\x1b[13;5u\r');
    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        initialInput: {
          submitted: true,
          verifiedSubmitted: true,
          staged: false,
          attempts: 2,
        },
      }],
    });
  });

  it('does not retry on stale staged frames when no output arrives after submit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
    const codexPanel = { ...terminalPanel, state: { isActive: false, customState: { agentType: 'codex' } } };
    vi.mocked(panelManager.createPanel).mockResolvedValue(codexPanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(codexPanel);
    vi.mocked(terminalPanelManager.getLastOutputAt).mockReturnValue(undefined);
    vi.mocked(terminalPanelManager.getOutputGeneration).mockReturnValue(0);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot('› /do TM-x', 'idle', 'codex', '2026-01-01T00:01:59.000Z'),
    );

    const resultPromise = createRegistry(createServices()).invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-358', tool: { agent: 'codex', initialInput: '/do TM-x' } }],
    }]);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(2);
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, codexPanel.id, '/do TM-x');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, codexPanel.id, '\x1b[13;5u\r');
    expect(result).toMatchObject({
      ok: false,
      items: [{
        ok: false,
        initialInput: {
          submitted: false,
          verifiedSubmitted: false,
          staged: false,
          attempts: 1,
          blocked: { kind: 'submission_unverified' },
        },
      }],
    });
  });

  it('cancels retry when a staged frame transitions before confirmation', async () => {
    vi.useFakeTimers();
    const codexPanel = { ...terminalPanel, state: { isActive: false, customState: { agentType: 'codex' } } };
    vi.mocked(panelManager.createPanel).mockResolvedValue(codexPanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(codexPanel);
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('› /frobnicate x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /frobnicate x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /frobnicate x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /frobnicate x', 'idle'))
      .mockReturnValue(terminalSnapshot('You ran /frobnicate x\nWorking\n›', 'active'));

    const resultPromise = createRegistry(createServices()).invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-358', tool: { agent: 'codex', initialInput: '/frobnicate x' } }],
    }]);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(2);
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, codexPanel.id, '/frobnicate x');
    expect(result).toMatchObject({
      ok: false,
      items: [{
        initialInput: {
          submitted: false,
          verifiedSubmitted: false,
          staged: expect.any(Boolean),
          attempts: 1,
          blocked: { kind: 'submission_unverified' },
          nextCommand: `runpane panels screen --panel ${codexPanel.id} --limit 80 --json`,
        },
      }],
    });
  });

  it('returns a bounded blocker after three confirmed staged submit attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:59.000Z'));
    const codexPanel = { ...terminalPanel, state: { isActive: false, customState: { agentType: 'codex' } } };
    vi.mocked(panelManager.createPanel).mockResolvedValue(codexPanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(codexPanel);
    vi.mocked(terminalPanelManager.getOutputGeneration)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(3)
      .mockReturnValue(3);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() =>
      terminalSnapshot('› /do TM-x', 'idle', 'codex', new Date(Date.now() + 1).toISOString()),
    );
    const startedAt = Date.now();

    const resultPromise = createRegistry(createServices()).invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-358', tool: { agent: 'codex', initialInput: '/do TM-x' } }],
    }]);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(Date.now() - startedAt).toBeLessThanOrEqual(3 * (3_000 + 500));
    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      ok: false,
      items: [{
        ok: false,
        initialInput: {
          delivered: true,
          submitted: false,
          verifiedSubmitted: false,
          staged: true,
          attempts: 3,
          blocked: { kind: 'submission_unverified' },
          nextCommand: `runpane panels screen --panel ${codexPanel.id} --limit 80 --json`,
        },
      }],
    });
  });

  it('clears the composer premark when wait-ready times out before staging initial input', async () => {
    const createdPanel: ToolPanel = {
      ...terminalPanel,
      state: {
        isActive: false,
        customState: {
          agentType: 'codex',
          isCliPanel: true,
          initialInput: '/do TM-x',
          initialInputSentAt: '2026-01-01T00:02:00.000Z',
          initialInputSubmitStrategy: 'codex-ctrl-enter',
        },
      },
    };
    vi.mocked(panelManager.createPanel).mockImplementation(async (request) => ({
      ...createdPanel,
      state: {
        isActive: false,
        customState: {
          ...createdPanel.state.customState,
          ...request.initialState,
        },
      },
    }));
    vi.mocked(panelManager.getPanel).mockImplementation(() => ({
      ...createdPanel,
      state: {
        isActive: false,
        customState: {
          ...createdPanel.state.customState,
          initialInputSentAt: '2026-01-01T00:02:00.000Z',
        },
      },
    }));
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      ...terminalSnapshot('codex booting', 'idle'),
      isCliReady: false,
    });

    const result = await createRegistry(createServices()).invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-358', tool: { agent: 'codex', initialInput: '/do TM-x' } }],
    }]);

    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
    expect(terminalPanelManager.deliverPendingInitialInput).toHaveBeenCalledWith(createdPanel.id);
    expect(panelManager.updatePanel).toHaveBeenCalledWith(createdPanel.id, {
      state: expect.objectContaining({
        customState: expect.not.objectContaining({
          initialInputSentAt: expect.any(String),
        }),
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      items: [{
        ok: false,
        initialInput: {
          delivered: false,
          submitted: false,
          error: { message: 'Initial input was not sent because the terminal panel did not become ready.' },
          nextCommand: expect.stringContaining(`runpane panels wait --panel ${createdPanel.id}`),
        },
      }],
    });
  });

  it('never retries when the composer clears without activity', async () => {
    vi.useFakeTimers();
    const codexPanel = { ...terminalPanel, state: { isActive: false, customState: { agentType: 'codex' } } };
    vi.mocked(panelManager.createPanel).mockResolvedValue(codexPanel);
    vi.mocked(panelManager.getPanel).mockReturnValue(codexPanel);
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValueOnce(terminalSnapshot('› /do TM-x', 'idle'))
      .mockReturnValue(terminalSnapshot('›', 'idle'));

    const resultPromise = createRegistry(createServices()).invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-358', tool: { agent: 'codex', initialInput: '/do TM-x' } }],
    }]);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      items: [{ initialInput: { submitted: false, staged: false, attempts: 1 } }],
    });
  });

  it('routes every agent, readiness, and input case consistently', async () => {
    vi.useFakeTimers();
    const toolKinds = process.platform === 'win32'
      ? (['claude', 'codex', 'custom'] as const)
      : (['claude', 'codex', 'cursor', 'custom'] as const);
    const inputCases = [
      { name: 'slash', input: '/do TM-x' },
      { name: 'prose', input: 'Please implement this' },
      { name: 'multiline', input: 'First line\nSecond line' },
    ] as const;

    for (const toolKind of toolKinds) {
      for (const waitReady of [false, true]) {
        for (const inputCase of inputCases) {
          vi.mocked(panelManager.createPanel).mockReset();
          vi.mocked(panelManager.getPanel).mockReset();
          vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReset();
          vi.mocked(terminalPanelManager.writeToTerminal).mockReset();
          let createRequest: CreatePanelRequest | undefined;
          let createdPanel: ToolPanel | undefined;
          vi.mocked(panelManager.createPanel).mockImplementation(async (request) => {
            createRequest = request;
            // SAFETY: This mock stands in for a terminal panel, so initialState carries the terminal customState shape.
            const initialState = (request.initialState ?? {}) as TerminalPanelState;
            const customState: TerminalPanelState = { ...initialState };
            if (initialState.initialInputMode === 'argument') {
              customState.initialInputSentAt = '2026-01-01T00:02:00.000Z';
            }
            createdPanel = {
              id: 'panel-1',
              sessionId: session.id,
              type: 'terminal',
              title: request.title ?? '',
              state: {
                isActive: false,
                customState,
              },
              metadata: {
                createdAt: '2026-01-01T00:00:00.000Z',
                lastActiveAt: '2026-01-01T00:01:00.000Z',
                position: 0,
              },
            };
            return createdPanel;
          });
          vi.mocked(panelManager.getPanel).mockImplementation(() => createdPanel);
          let snapshotCalls = 0;
          vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => {
            snapshotCalls += 1;
            if (toolKind === 'custom') {
              return {
                ...terminalSnapshot('', 'idle'),
                isCliPanel: false,
                isCliReady: false,
                agentType: undefined,
                currentCommand: 'echo',
              };
            }
            if (toolKind === 'codex' && inputCase.name === 'slash' && snapshotCalls >= 4) {
              return terminalSnapshot('Working\n›', 'active');
            }
            // SAFETY: The `custom` kind is handled above, leaving only agent kinds the snapshot frames as claude/codex.
            return terminalSnapshot(
              toolKind === 'codex' && inputCase.name === 'slash' ? `› ${inputCase.input}` : 'ready',
              'idle',
              toolKind as 'claude' | 'codex',
            );
          });
          const tool: RunpaneToolSpec = toolKind === 'custom'
            ? { command: 'echo tool', initialInput: inputCase.input }
            : { agent: toolKind, initialInput: inputCase.input };

          const resultPromise = createRegistry(createServices()).invoke('runpane:panes:create', [{
            repo: { id: project.id },
            waitReady,
            readyTimeoutMs: 100,
            panes: [{ name: `${toolKind}-${inputCase.name}`, tool }],
          }]);
          await vi.runAllTimersAsync();
          // SAFETY: The panes:create handler resolves to a result object exposing the per-pane `items` array read below.
          const result = await resultPromise as { items: Array<{ ok?: boolean; initialInput?: unknown }> };
          // SAFETY: createPanel was invoked for a terminal panel, so the captured initialState is the terminal customState.
          const initialState = createRequest?.initialState as TerminalPanelState | undefined;
          const useArgument = toolKind === 'claude'
            || toolKind === 'cursor'
            || (toolKind === 'codex' && inputCase.name !== 'slash');
          const premarkedComposer = waitReady && toolKind === 'codex' && inputCase.name === 'slash';

          expect(initialState?.initialInputMode, `${toolKind}/${waitReady}/${inputCase.name} mode`).toBe(
            useArgument ? 'argument' : undefined,
          );
          expect(initialState?.initialInputSubmitStrategy, `${toolKind}/${waitReady}/${inputCase.name} strategy`).toBe(
            toolKind === 'codex' && inputCase.name === 'slash' ? 'codex-ctrl-enter' : 'enter',
          );
          expect(Boolean(initialState?.initialInputSentAt), `${toolKind}/${waitReady}/${inputCase.name} premark`).toBe(
            premarkedComposer,
          );
          expect(Boolean(result.items[0]?.initialInput), `${toolKind}/${waitReady}/${inputCase.name} result`).toBe(
            waitReady && toolKind !== 'custom',
          );
          if (waitReady && toolKind !== 'custom' && inputCase.name !== 'slash') {
            expect(result.items[0], `${toolKind}/${waitReady}/${inputCase.name} verified result`).toMatchObject({
              ok: true,
              initialInput: {
                verifiedSubmitted: true,
              },
            });
          }
        }
      }
    }
  });

  describe('runpane:panes:archive', () => {
    it('archives an externally owned pane without inspecting or removing its worktree', async () => {
      const externalSession: Session = { ...session, worktreeOwnership: 'external' };
      // SAFETY: This test double provides the exact SessionManager members exercised by archive.
      const services = createServices({
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => externalSession),
        // SAFETY: This fixture implements the session-manager method used by the handler.
        } as never,
      });
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const preview = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
        dryRun: true,
      }]);
      expect(preview).toMatchObject({
        ok: true,
        wouldArchive: true,
        safetyCheck: { performed: false },
      });
      expect(services.gitStatusManager.getGitStatus).not.toHaveBeenCalled();

      const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id }]);
      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        archived: true,
        worktreeCleanup: 'not-applicable',
      });
    });

    it('archives a clean pane and waits for worktree cleanup to complete', async () => {
      const repoPath = createTempGitRepo('clean-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });

      const cleanSession: Session = { ...session, worktreePath: repoPath };
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => cleanSession),
        } as never,
        archiveProgressManager: new ArchiveProgressManager(),
      } as never);
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        paneId: session.id,
        archived: true,
        forced: false,
        worktreeCleanup: 'completed',
        worktreePath: repoPath,
        safetyCheck: {
          performed: true,
          hasUncommittedChanges: false,
          hasUntrackedFiles: false,
        },
      });
    });

    it('rejects archiving a pane that is already archived', async () => {
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => ({ ...session, archived: true })),
        } as never,
      });
      const registry = createRegistry(services);
      registerSessionsDeleteStub(registry, services);

      await expect(registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }])).rejects.toThrow(/already archived/);
    });

    it('rejects archiving an unknown pane id', async () => {
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => undefined),
        } as never,
      });
      const registry = createRegistry(services);
      registerSessionsDeleteStub(registry, services);

      await expect(registry.invoke('runpane:panes:archive', [{
        paneId: 'no-such-pane',
      }])).rejects.toThrow(/No Pane pane found/);
    });

    it('refuses to archive a dirty pane without --force', async () => {
      const repoPath = createTempGitRepo('dirty-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'uncommitted change');

      const dirtySession: Session = { ...session, worktreePath: repoPath };
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => dirtySession),
        } as never,
      });
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(sessionsDelete).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        paneId: session.id,
        blocked: {
          code: 'uncommitted-changes',
          safetyCheck: {
            performed: true,
            hasUncommittedChanges: false,
            hasUntrackedFiles: true,
          },
        },
        nextCommand: `runpane panes archive --pane ${session.id} --force --yes --json`,
      });
    });

    it('archives a dirty pane when --force is passed', async () => {
      const repoPath = createTempGitRepo('dirty-force-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'initial');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add tracked file'], { cwd: repoPath, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'modified');

      const dirtySession: Session = { ...session, worktreePath: repoPath };
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => dirtySession),
        } as never,
        archiveProgressManager: new ArchiveProgressManager(),
      } as never);
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
        force: true,
      }]);

      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        forced: true,
        worktreeCleanup: 'completed',
        safetyCheck: {
          performed: true,
          hasUncommittedChanges: true,
        },
      });
    });

    it('refuses to archive a pane with commits unpushed to its remote upstream', async () => {
      const repoPath = createTempGitRepo('unpushed-repo');
      const remotePath = path.join(path.dirname(repoPath), 'unpushed-remote.git');
      execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'unpushed change'], { cwd: repoPath, stdio: 'ignore' });

      const unpushedSession: Session = { ...session, worktreePath: repoPath };
      const base = createServices();
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...base.sessionManager,
          getSession: vi.fn(() => unpushedSession),
          getProjectContext: vi.fn(() => ({
            commandRunner: new CommandRunner({ path: repoPath }),
          })),
        } as never,
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        worktreeManager: {
          getUpstream: vi.fn(async () => 'origin/main'),
        } as never,
      });
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(sessionsDelete).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        blocked: {
          code: 'unpushed-commits',
          safetyCheck: {
            performed: true,
            hasUpstream: true,
            upstream: 'origin/main',
            upstreamRefreshed: true,
            unpushedCommits: 1,
            unpushedCommitDetails: [{
              subject: 'unpushed change',
            }],
          },
        },
      });
      expect(result).toMatchObject({
        blocked: {
          safetyCheck: {
            unpushedCommitDetails: [{
              sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim(),
            }],
          },
        },
      });
    });

    it('refreshes a stale remote-tracking ref before deciding that pushed commits are unpushed', async () => {
      const repoPath = createTempGitRepo('stale-upstream-repo');
      const remotePath = path.join(path.dirname(repoPath), 'remote.git');
      execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'ignore' });
      const staleSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
      execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'already pushed'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['push'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', staleSha], { cwd: repoPath, stdio: 'ignore' });

      const staleSession: Session = { ...session, worktreePath: repoPath };
      const base = createServices();
      // SAFETY: This test fixture intentionally supplies only the service methods exercised by archive safety.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal session manager surface exercised by the unit.
        sessionManager: {
          ...base.sessionManager,
          getSession: vi.fn(() => staleSession),
          getProjectContext: vi.fn(() => ({
            commandRunner: new CommandRunner({ path: repoPath }),
          })),
        } as never,
        // SAFETY: This test fixture intentionally supplies the minimal worktree manager surface exercised by the unit.
        worktreeManager: {
          getUpstream: vi.fn(async () => 'origin/main'),
        } as never,
        archiveProgressManager: new ArchiveProgressManager(),
      } as never);
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id }]);

      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        archived: true,
        safetyCheck: {
          performed: true,
          hasUpstream: true,
          upstream: 'origin/main',
          upstreamRefreshed: true,
          unpushedCommits: 0,
          unpushedCommitDetails: [],
        },
      });
    });

    it('dry-runs archive safety without deleting the pane', async () => {
      const repoPath = createTempGitRepo('archive-dry-run-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'local work');
      const dryRunSession: Session = { ...session, worktreePath: repoPath };
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal session manager surface exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => dryRunSession),
        } as never,
      });
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
        dryRun: true,
      }]);

      expect(sessionsDelete).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: true,
        paneId: session.id,
        dryRun: true,
        wouldArchive: false,
        forced: false,
        blocked: {
          code: 'uncommitted-changes',
        },
        safetyCheck: {
          performed: true,
          hasUntrackedFiles: true,
          unpushedCommits: 0,
          unpushedCommitDetails: [],
        },
      });
    });

    it('archives a pane whose branch is merged and fully pushed (0 unpushed commits)', async () => {
      const repoPath = createTempGitRepo('merged-repo');
      const remotePath = path.join(path.dirname(repoPath), 'merged-remote.git');
      execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoPath, stdio: 'ignore' });

      const mergedSession: Session = { ...session, worktreePath: repoPath };
      const base = createServices();
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...base.sessionManager,
          getSession: vi.fn(() => mergedSession),
          getProjectContext: vi.fn(() => ({
            commandRunner: new CommandRunner({ path: repoPath }),
          })),
        } as never,
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        worktreeManager: {
          getUpstream: vi.fn(async () => 'origin/main'),
        } as never,
        archiveProgressManager: new ArchiveProgressManager(),
      } as never);
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        worktreeCleanup: 'completed',
        safetyCheck: {
          performed: true,
          hasUpstream: true,
          unpushedCommits: 0,
        },
      });
    });

    it('archives a main-repo pane immediately even if it is dirty, skipping the safety gate', async () => {
      const repoPath = createTempGitRepo('main-repo-dirty');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'uncommitted change');

      const mainRepoSession: Session = { ...session, worktreePath: repoPath, isMainRepo: true };
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => mainRepoSession),
        } as never,
      });
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        worktreeCleanup: 'not-applicable',
        safetyCheck: {
          performed: false,
        },
      });
    });

    it('fails safe with status-unknown when git status cannot be determined', async () => {
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        worktreeManager: {
          getUpstream: vi.fn(async () => {
            throw new Error('git command failed');
          }),
        } as never,
      });
      const registry = createRegistry(services);
      const sessionsDelete = registerSessionsDeleteStub(registry, services);

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(sessionsDelete).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        blocked: {
          code: 'status-unknown',
          safetyCheck: {
            performed: false,
          },
        },
      });
    });

    it('reports failed worktree cleanup when the archive-progress task fails', async () => {
      const repoPath = createTempGitRepo('cleanup-failure-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });

      const cleanSession: Session = { ...session, worktreePath: repoPath };
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => cleanSession),
        } as never,
        archiveProgressManager: new ArchiveProgressManager(),
      } as never);
      const registry = createRegistry(services);
      registerSessionsDeleteStub(registry, services, {
        onArchive: () => {
          throw new Error('worktree removal failed');
        },
      });

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(result).toMatchObject({
        ok: false,
        archived: true,
        worktreeCleanup: 'failed',
      });
    });

    it('polls for worktree removal when no archiveProgressManager is configured', async () => {
      const repoPath = createTempGitRepo('polling-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const pollingSession: Session = { ...session, worktreePath: repoPath };
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => pollingSession),
        } as never,
        archiveProgressManager: undefined,
      } as never);
      const registry = createRegistry(services);
      registerSessionsDeleteStub(registry, services, {
        onArchive: () => {
          fs.rmSync(repoPath, { recursive: true, force: true });
        },
      });

      const result = await registry.invoke('runpane:panes:archive', [{
        paneId: session.id,
      }]);

      expect(result).toMatchObject({
        ok: true,
        worktreeCleanup: 'completed',
      });
    });
  });

  describe('runpane:panes:focus', () => {
    function createMockWindow() {
      return {
        isMinimized: vi.fn(() => false),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: { send: vi.fn() },
      };
    }

    function createWindowServices(
      window: ReturnType<typeof createMockWindow>,
      overrides: Partial<AppServices> = {},
    ): AppServices {
      return createServices({
        ...overrides,
        // SAFETY: Focus tests exercise only the BrowserWindow methods supplied by this fixture.
        getMainWindow: () => window as never,
      });
    }

    it('raises the window, selects the pane, and emits the focus event', async () => {
      const window = createMockWindow();
      const services = createWindowServices(window);
      const registry = createRegistry(services);

      const result = await registry.invoke('runpane:panes:focus', [{
        paneId: session.id,
        source: 'user',
      }]);

      expect(window.isMinimized).toHaveBeenCalledTimes(1);
      expect(window.restore).not.toHaveBeenCalled();
      expect(window.show).toHaveBeenCalledTimes(1);
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).toHaveBeenCalledWith('pane:focus-requested', {
        paneId: session.id,
        panelId: undefined,
      });
      expect(result).toMatchObject({
        ok: true,
        paneId: session.id,
        focused: true,
      });
    });

    it('restores a minimized window and selects the given panel', async () => {
      const window = createMockWindow();
      window.isMinimized.mockReturnValue(true);
      const services = createWindowServices(window);
      const registry = createRegistry(services);

      const result = await registry.invoke('runpane:panes:focus', [{
        paneId: session.id,
        panelId: terminalPanel.id,
      }]);

      expect(window.restore).toHaveBeenCalledTimes(1);
      expect(panelManager.setActivePanel).toHaveBeenCalledWith(session.id, terminalPanel.id);
      expect(window.show).toHaveBeenCalledTimes(1);
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(window.webContents.send).toHaveBeenCalledWith('pane:focus-requested', {
        paneId: session.id,
        panelId: terminalPanel.id,
      });
      expect(result).toMatchObject({
        ok: true,
        paneId: session.id,
        panelId: terminalPanel.id,
        focused: true,
      });
    });

    it('refuses to focus an archived pane and never touches the window', async () => {
      const window = createMockWindow();
      const services = createWindowServices(window, {
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => ({ ...session, archived: true })),
        },
      });
      const registry = createRegistry(services);

      await expect(registry.invoke('runpane:panes:focus', [{
        paneId: session.id,
      }])).rejects.toThrow(/archived and cannot be focused/);

      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('rejects focusing an unknown pane id', async () => {
      const window = createMockWindow();
      const services = createWindowServices(window, {
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => undefined),
        },
      });
      const registry = createRegistry(services);

      await expect(registry.invoke('runpane:panes:focus', [{
        paneId: 'no-such-pane',
      }])).rejects.toThrow(/No Pane pane found/);

      expect(window.show).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('rejects a panel that does not belong to the focused pane', async () => {
      const window = createMockWindow();
      vi.mocked(panelManager.getPanel).mockReturnValue({
        ...terminalPanel,
        sessionId: 'other-session',
      });
      const services = createWindowServices(window);
      const registry = createRegistry(services);

      await expect(registry.invoke('runpane:panes:focus', [{
        paneId: session.id,
        panelId: terminalPanel.id,
      }])).rejects.toThrow(/does not belong to Pane/);

      expect(window.show).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
    });
  });
});
