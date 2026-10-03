import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type { Project } from '../database/models';
import type { Session } from '../types/session';
import type { AppServices } from './types';
import type { CreatePanelRequest, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import type { RunpaneToolSpec } from '../../../shared/types/runpaneOrchestration';

import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { panelManager } from '../services/panelManager';
import { panelManager as terminalPanelStore } from '../test/setup';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { databaseService as panelDatabase } from '../services/database';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { removeWorktreeViaTrash, waitForPendingWorktreeTrash } from '../services/worktreeTrash';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { OrchestrationSessionManager } from '../services/orchestrationSessionManager';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { NamedLockService } from '../services/namedLockService';
import { NamedLockStore } from '../services/namedLockStore';
import { usageManager } from '../services/usage/usageManager';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import { agentTranscripts } from '../services/agentTranscript';
import { claudeProjectDirName } from '../services/agentTranscript/claude';
import { registerRunpaneHandlers } from './runpane';
import type { TaskQueue } from '../services/taskQueue';

// Transcript reads are real file I/O; these tests script what the transcript says.
const findUserTurnSince = vi.spyOn(agentTranscripts, 'findUserTurnSince');

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
vi.spyOn(terminalPanelManager, 'getGhostScreenText');
vi.spyOn(terminalPanelManager, 'deliverPendingInitialInput');
vi.spyOn(terminalPanelManager, 'getAgentStatus');
vi.spyOn(terminalPanelManager, 'getForegroundProcess');
vi.spyOn(terminalPanelManager, 'isBracketedPasteEnabled');
vi.spyOn(terminalPanelManager, 'launchShellReadsPromptFile');
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
    onArchive?: (sessionId: string) => Promise<void> | void;
    result?: { success: boolean; error?: string };
  } = {},
): ReturnType<typeof vi.fn> {
  const handler = vi.fn(async (sessionId: string, _options?: { removeExternalWorktree?: boolean }) => {
    if (options.result) {
      return options.result;
    }
    if (services.archiveProgressManager) {
      services.archiveProgressManager.addTask(sessionId, 'issue-252', 'issue-252-worktree', 'Pane', async () => {
        await options.onArchive?.(sessionId);
      });
    } else {
      setImmediate(() => options.onArchive?.(sessionId));
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
    vi.mocked(terminalPanelManager.getGhostScreenText).mockReset();
    vi.mocked(terminalPanelManager.deliverPendingInitialInput).mockReset();
    vi.mocked(terminalPanelManager.getAgentStatus).mockReset();
    vi.mocked(terminalPanelManager.getForegroundProcess).mockReset().mockReturnValue(undefined);
    vi.mocked(terminalPanelManager.isBracketedPasteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(terminalPanelManager.launchShellReadsPromptFile).mockReset().mockReturnValue(true);
    vi.mocked(terminalPanelManager.getOutputGeneration).mockReturnValue(0);
    vi.mocked(terminalPanelManager.getAgentStatus).mockReturnValue('idle');
    findUserTurnSince.mockReset().mockResolvedValue({ state: null });
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

    it.each([false, true])('adopts a pane with stored identity and launch=%s', async (launch) => {
      const repoPath = createTempGitRepo('create-adopt-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'create-adopt-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'create-adopt', worktreePath], { cwd: repoPath, stdio: 'ignore' });
      const services = adoptionServices(repoPath, worktreePath);
      const adoptedPanel = { ...terminalPanel, state: { ...terminalPanel.state, customState: { agentType: 'codex' as const, agentSessionId: 'thread-1' } } };
      vi.mocked(panelManager.createPanel).mockResolvedValue(adoptedPanel);
      vi.mocked(panelManager.getPanel).mockReturnValue(adoptedPanel);
      terminalPanelStore.getPanel.mockReturnValue(adoptedPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Adopted', tool: { agent: 'codex' }, resume: 'thread-1', launch }],
      }]);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, items: [{ ok: true, sessionId: session.id }] });
      expect(panelManager.createPanel).toHaveBeenCalledTimes(1);
      expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
        initialState: expect.objectContaining({ agentType: 'codex', agentSessionId: 'thread-1', initialCommand: launch ? 'codex --yolo' : undefined }),
      }));
      if (!launch) {
        expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, 'codex --yolo resume "thread-1"');
      }
      expect(services.sessionManager.emitSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'stopped' }),
        expect.objectContaining({ createDefaultTerminalOnCreate: false }),
      );
    });

    it('associates adopted panes with the calling Session and reports association failures', async () => {
      const repoPath = createTempGitRepo('associate-adopt-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'associate-adopt-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'associate-adopt', worktreePath], { cwd: repoPath, stdio: 'ignore' });
      const associate = vi.fn(async () => ({}));
      // SAFETY: The handler only calls associate on the Sessions manager.
      const services = { ...adoptionServices(repoPath, worktreePath), orchestrationSessionManager: { associate } as never };
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockImplementation(async () => {
        expect(associate).toHaveBeenCalledWith({ sessionId: 'orchestrator-1' }, { paneId: session.id });
      });
      const request = {
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Adopted', tool: { agent: 'codex' } }],
        associateSession: 'orchestrator-1',
      };

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [request]);

      expect(associate).toHaveBeenCalledWith({ sessionId: 'orchestrator-1' }, { paneId: session.id });
      expect(result).toMatchObject({ ok: true, items: [{ ok: true, association: { sessionId: 'orchestrator-1', ok: true } }] });

      associate.mockRejectedValueOnce(new Error('Pane is already associated with Session Other'));
      const failed = await createRegistry(services).invoke('runpane:panes:adopt', [request]);
      expect(failed).toMatchObject({
        ok: true,
        items: [{ ok: true, association: { ok: false, error: 'Pane is already associated with Session Other' } }],
      });
    });

    it('does not associate panes when no Session is given', async () => {
      const repoPath = createTempGitRepo('no-associate-adopt-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'no-associate-adopt-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'no-associate-adopt', worktreePath], { cwd: repoPath, stdio: 'ignore' });
      const associate = vi.fn(async () => ({}));
      // SAFETY: The handler only calls associate on the Sessions manager.
      const services = { ...adoptionServices(repoPath, worktreePath), orchestrationSessionManager: { associate } as never };
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Adopted', tool: { agent: 'codex' } }],
      }]);

      expect(associate).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, items: [expect.not.objectContaining({ association: expect.anything() })] });
    });

    function createAdoptWorktree(name: string) {
      const repoPath = createTempGitRepo(`${name}-repo`);
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), `${name}-worktree`);
      execFileSync('git', ['worktree', 'add', '-b', name, worktreePath], { cwd: repoPath, stdio: 'ignore' });
      return { repoPath, worktreePath };
    }

    it('launches an adopted agent with a prompt and reports its delivery like create', async () => {
      const { repoPath, worktreePath } = createAdoptWorktree('prompt-adopt');
      const services = adoptionServices(repoPath, worktreePath);
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const claudePanel = {
        ...terminalPanel,
        title: 'Claude Code',
        state: { isActive: false, customState: { agentType: 'claude', initialInputSentAt: '2026-01-01T00:02:00.000Z' } },
      } as ToolPanel;
      vi.mocked(panelManager.createPanel).mockResolvedValue(claudePanel);
      vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
        ...terminalSnapshot(`${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n`, 'idle', 'claude'),
      });

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        waitReady: true,
        readyTimeoutMs: 100,
        panes: [{
          path: worktreePath,
          name: 'Adopted',
          tool: { agent: 'claude', initialInput: 'Read and follow prompt.md' },
          launch: true,
        }],
      }]);

      expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
        initialState: expect.objectContaining({
          initialCommand: RUNPANE_CONTRACT.agentTemplates.claude.command,
          initialInput: 'Read and follow prompt.md',
          initialInputMode: 'argument',
          agentType: 'claude',
        }),
        activate: false,
      }));
      expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        items: [{
          ok: true,
          sessionId: session.id,
          panelId: claudePanel.id,
          readiness: { ok: true, condition: 'ready' },
          initialInput: { delivered: true, submitted: true, strategy: 'argument', verifiedSubmitted: true },
          nextCommand: expect.stringContaining(`--panel ${claudePanel.id}`),
        }],
      });
    });

    it('sends a resumed conversation its prompt through the composer', async () => {
      const { repoPath, worktreePath } = createAdoptWorktree('resume-prompt-adopt');
      const services = adoptionServices(repoPath, worktreePath);
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{
          path: worktreePath,
          name: 'Adopted',
          tool: { agent: 'codex', initialInput: 'Continue with step 2' },
          resume: 'thread-1',
          launch: true,
        }],
      }]);

      expect(result).toMatchObject({ ok: true, items: [{ ok: true }] });
      const initialState = vi.mocked(panelManager.createPanel).mock.calls[0][0].initialState;
      expect(initialState).toMatchObject({
        initialCommand: RUNPANE_CONTRACT.agentTemplates.codex.command,
        initialInput: 'Continue with step 2',
        initialInputSubmitStrategy: 'codex-ctrl-enter',
        agentSessionId: 'thread-1',
        hasClaudeSessionId: false,
      });
      expect(initialState).not.toHaveProperty('initialInputMode');
    });

    it('refuses an adopt prompt without launch instead of dropping it', async () => {
      const { repoPath, worktreePath } = createAdoptWorktree('unlaunched-prompt-adopt');
      const services = adoptionServices(repoPath, worktreePath);

      await expect(createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Adopted', tool: { agent: 'codex', initialInput: 'Do the thing' } }],
      }])).rejects.toThrow('has a prompt but no launch');
      expect(services.sessionManager.createSession).not.toHaveBeenCalled();
      expect(panelManager.createPanel).not.toHaveBeenCalled();
    });

    it('adopts a wrapper launch with its declared agent and runs the command unchanged', async () => {
      const { repoPath, worktreePath } = createAdoptWorktree('wrapper-adopt');
      const services = adoptionServices(repoPath, worktreePath);
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);

      const result = await createRegistry(services).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{
          path: worktreePath,
          name: 'Farm',
          tool: { command: 'agent-farm run free-range', agentType: 'claude' },
          launch: true,
        }],
      }]);

      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        items: [{ ok: true, tool: { command: 'agent-farm run free-range', agent: 'claude', title: 'Claude Code' } }],
      });
      expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
        initialState: expect.objectContaining({
          initialCommand: 'agent-farm run free-range',
          launchCommand: 'agent-farm run free-range',
          agentType: 'claude',
          agentDetection: 'declared',
          launchMode: 'wrapped',
          isCliPanel: true,
        }),
      }));
    });

    it('stages a wrapped adopt\'s long prompt in the composer and never rewrites the wrapper command', async () => {
      const { repoPath, worktreePath } = createAdoptWorktree('wrapper-prompt-adopt');
      const services = adoptionServices(repoPath, worktreePath);
      // Longer than the 512-character threshold and multi-line, as a --prompt-file brief is.
      const longPrompt = `Implement step one.\n${'Keep the wrapper command exactly as given. '.repeat(20).trim()}`;
      const rule = '─'.repeat(40);
      const claudeComposer = (content: string) => `${rule}\n❯ ${content}\n${rule}\n`;
      const adoptedPanel = (request: CreatePanelRequest): ToolPanel => ({
        ...terminalPanel,
        title: request.title ?? '',
        // SAFETY: The terminal panel mock keeps the terminal customState it was created with.
        state: { isActive: false, customState: { ...(request.initialState as TerminalPanelState) } },
      });
      vi.mocked(terminalPanelManager.initializeTerminal).mockResolvedValue(undefined);
      vi.mocked(terminalPanelManager.isBracketedPasteEnabled).mockReturnValue(true);
      vi.mocked(panelManager.createPanel).mockImplementation(async request => adoptedPanel(request));
      vi.mocked(panelManager.getPanel).mockImplementation(() => {
        const request = vi.mocked(panelManager.createPanel).mock.calls[0]?.[0];
        return request ? adoptedPanel(request) : undefined;
      });
      let staged = false;
      let enters = 0;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enters += 1;
        else staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        !staged ? claudeComposer('') : enters === 0 ? claudeComposer('[Pasted text #1 +1 lines]') : `✻ Working\n${claudeComposer('')}`,
        enters === 0 ? 'idle' : 'active',
        'claude',
      ));

      // Git validates the worktree on real I/O first; only then do fake timers drive the delivery waits.
      const realSetTimeout = globalThis.setTimeout;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      try {
        let settled = false;
        const pending = Promise.resolve(createRegistry(services).invoke('runpane:panes:adopt', [{
          repo: { id: project.id },
          waitReady: true,
          readyTimeoutMs: 100,
          panes: [{
            path: worktreePath,
            name: 'Farm',
            tool: { command: 'agent-farm run free-range', agentType: 'claude', initialInput: longPrompt },
            launch: true,
          }],
        }])).finally(() => { settled = true; });
        for (let step = 0; step < 400 && !settled; step++) {
          await new Promise(resolve => realSetTimeout(resolve, 5));
          await vi.advanceTimersByTimeAsync(250);
        }
        const result = await pending;

        // SAFETY: createPanel was invoked for a terminal panel, so initialState is the terminal customState.
        const initialState = vi.mocked(panelManager.createPanel).mock.calls[0]?.[0].initialState as TerminalPanelState;
        expect(initialState).toMatchObject({
          initialCommand: 'agent-farm run free-range',
          launchCommand: 'agent-farm run free-range',
          launchMode: 'wrapped',
          agentDetection: 'declared',
          agentType: 'claude',
          initialInput: longPrompt,
          initialInputSubmitStrategy: 'enter',
        });
        // Neither a launch argument nor a `$(cat <prompt file>)` word is added to the wrapper.
        expect(initialState.initialInputMode).toBeUndefined();
        expect(initialState.initialInputFile).toBeUndefined();
        expect(vi.mocked(terminalPanelManager.writeToTerminal).mock.calls).toEqual([
          [terminalPanel.id, `\x1b[200~${longPrompt}\x1b[201~`],
          [terminalPanel.id, '\r'],
        ]);
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: true,
          items: [{
            ok: true,
            tool: { command: 'agent-farm run free-range', agent: 'claude' },
            readiness: { ok: true },
            initialInput: { submitted: true, verifiedSubmitted: true, delivery: { state: expect.stringMatching(/^(taken|queued)$/) } },
          }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses --resume for a wrapper command', async () => {
      const repoPath = createTempGitRepo('wrapper-resume-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const worktreePath = path.join(path.dirname(repoPath), 'wrapper-resume-worktree');
      execFileSync('git', ['worktree', 'add', '-b', 'wrapper-resume', worktreePath], { cwd: repoPath, stdio: 'ignore' });

      const result = await createRegistry(adoptionServices(repoPath, worktreePath)).invoke('runpane:panes:adopt', [{
        repo: { id: project.id },
        panes: [{ path: worktreePath, name: 'Farm', tool: { command: 'agent-farm run x', agentType: 'claude' }, resume: 'abc' }],
        dryRun: true,
      }]);

      expect(result).toMatchObject({ ok: false, items: [{ ok: false, error: { message: expect.stringContaining('--resume needs a built-in agent') } }] });
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
    expect(daemon.channels).toContain('runpane:panels:open');
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

  describe('workspace wait --session', () => {
    const sessionRecord = { id: '__orchestration_session_s1__', name: 'Release' };
    const sessionKinds = ['agent.ready', 'agent.blocked', 'pane.gone', 'pane.associated', 'pane.detached'];
    const readyEntry = (paneId: string) => ({
      kind: 'agent.ready' as const,
      paneId,
      paneName: paneId,
      panelId: `${paneId}-panel`,
      agentType: 'claude',
      source: 'agent' as const,
      from: 'working' as const,
      to: 'idle' as const,
    });

    function sessionRegistry() {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-session-watch-test-'));
      tempDirs.push(directory);
      const members = new Map<string, readonly string[]>();
      const orchestrationSessionManager = {
        get: vi.fn(async (selector: { sessionId?: string }) => {
          if (selector.sessionId !== sessionRecord.id && selector.sessionId !== sessionRecord.name) {
            throw new Error(`Session ${selector.sessionId} not found`);
          }
          return sessionRecord;
        }),
        workspaceMembership: vi.fn((sessionId: string) => sessionId === sessionRecord.id
          ? { panes: members, ownPaneIds: new Set<string>(), ownPanelIds: new Set<string>() }
          : undefined),
      };
      const workspaceJournal = new WorkspaceJournal({
        resolveSessionMembership: sessionId => orchestrationSessionManager.workspaceMembership(sessionId),
      });
      const workspaceCursorStore = new WorkspaceCursorStore(path.join(directory, 'workspace-cursors.json'));
      const registry = createRegistry(createServices({
        workspaceJournal,
        workspaceCursorStore,
        // SAFETY: The fake implements the two Session manager members a Session-scoped wait uses.
        orchestrationSessionManager: orchestrationSessionManager as never,
      }));
      const membership = (kind: 'associated' | 'detached', paneId: string) => {
        if (kind === 'associated') members.set(paneId, []);
        else members.delete(paneId);
        workspaceJournal.send('orchestration-sessions:changed', {
          sessionId: sessionRecord.id,
          kind,
          sessionName: sessionRecord.name,
          paneIds: [paneId],
        });
      };
      return { workspaceJournal, workspaceCursorStore, registry, membership };
    }

    it('sees a Pane associated after arming and stops after detach, without re-arming', async () => {
      const { workspaceJournal, registry, membership } = sessionRegistry();
      const request = { as: 'session-s1', session: 'Release', timeoutMs: 0, kinds: sessionKinds };
      const armed = await registry.invoke('runpane:workspace:wait', [request]);
      expect(armed).toMatchObject({
        reset: { reason: 'first-use' },
        entries: [],
        session: sessionRecord,
        nextCommand: `runpane watch --as session-s1 --session ${sessionRecord.id}`,
      });

      workspaceJournal.append(readyEntry('outside'));
      membership('associated', 'worker');
      workspaceJournal.append(readyEntry('worker'));
      const joined = await registry.invoke('runpane:workspace:wait', [request]);
      expect(joined.entries.map((entry: { kind: string; paneId: string }) => [entry.kind, entry.paneId])).toEqual([
        ['pane.associated', 'worker'],
        ['agent.ready', 'worker'],
      ]);
      expect(joined.entries[0]).toMatchObject({ sessionId: sessionRecord.id, sessionName: 'Release' });

      membership('detached', 'worker');
      workspaceJournal.append(readyEntry('worker'));
      const left = await registry.invoke('runpane:workspace:wait', [request]);
      expect(left.entries.map((entry: { kind: string; paneId: string }) => [entry.kind, entry.paneId])).toEqual([
        ['pane.detached', 'worker'],
      ]);
    });

    it('keeps the cadence across membership changes and drops a detached Pane’s held READY', async () => {
      const { workspaceJournal, registry, membership } = sessionRegistry();
      const request = { as: 'session-s1', session: sessionRecord.id, timeoutMs: 0, idleAfterMs: 0, kinds: sessionKinds, settleMs: 60_000 };
      await registry.invoke('runpane:workspace:wait', [request]);
      membership('associated', 'worker');
      workspaceJournal.append(readyEntry('worker'));
      membership('associated', 'reviewer');
      workspaceJournal.append(readyEntry('reviewer'));
      const joined = await registry.invoke('runpane:workspace:wait', [request]);
      expect(joined.entries.map((entry: { kind: string; paneId: string }) => [entry.kind, entry.paneId])).toEqual([
        ['pane.associated', 'worker'],
        ['pane.associated', 'reviewer'],
      ]);

      // A third Pane joins while both READY lines settle; the same cadence instance keeps them.
      vi.setSystemTime(new Date('2026-01-01T12:00:30.000Z'));
      membership('associated', 'late');
      expect((await registry.invoke('runpane:workspace:wait', [request])).entries)
        .toEqual([expect.objectContaining({ kind: 'pane.associated', paneId: 'late' })]);

      membership('detached', 'reviewer');
      vi.setSystemTime(new Date('2026-01-01T12:01:01.000Z'));
      const settled = await registry.invoke('runpane:workspace:wait', [request]);
      expect(settled.entries.map((entry: { kind: string; paneId: string }) => [entry.kind, entry.paneId])).toEqual([
        ['pane.detached', 'reviewer'],
        ['agent.ready', 'worker'],
      ]);
    });

    it('marks baseline entries as replay after an epoch change and scopes them to the Session', async () => {
      const { workspaceCursorStore, registry, membership } = sessionRegistry();
      workspaceCursorStore.create('session-s1', 0, 'old-epoch');
      membership('associated', session.id);

      const result = await registry.invoke('runpane:workspace:wait', [{ as: 'session-s1', session: 'Release', timeoutMs: 0 }]);

      expect(result).toMatchObject({ reset: { reason: 'epoch-changed' }, session: sessionRecord });
      expect(result.entries).toContainEqual(expect.objectContaining({
        kind: 'agent.ready',
        paneId: session.id,
        baseline: true,
        replay: true,
        changedWhileAway: true,
      }));
      expect(result.entries.every((entry: { replay?: true }) => entry.replay === true)).toBe(true);

      membership('detached', session.id);
      workspaceCursorStore.create('session-s1', 0, 'older-epoch');
      const empty = await registry.invoke('runpane:workspace:wait', [{ as: 'session-s1', session: 'Release', timeoutMs: 0 }]);
      expect(empty.entries).toEqual([]);
    });

    it('delivers PR events to a Session watcher, with a conflict bypassing the minimum interval', async () => {
      const { workspaceJournal, registry, membership } = sessionRegistry();
      const prKinds = [...sessionKinds, 'pr.conflicted', 'pr.checks', 'pr.merged'];
      const request = { as: 'session-s1', session: 'Release', timeoutMs: 0, idleAfterMs: 0, kinds: prKinds, minIntervalMs: 600_000 };
      await registry.invoke('runpane:workspace:wait', [request]);
      membership('associated', 'worker');
      expect((await registry.invoke('runpane:workspace:wait', [request])).entries).toHaveLength(1);

      const pr = { number: 747, url: 'https://github.com/acme/app/pull/747', headOid: 'abc' };
      workspaceJournal.appendPaneEntry('worker', { kind: 'pr.merged', source: 'github', pr });
      expect((await registry.invoke('runpane:workspace:wait', [request])).entries).toEqual([]);
      workspaceJournal.appendPaneEntry('worker', { kind: 'pr.conflicted', source: 'github', pr });
      const urgent = await registry.invoke('runpane:workspace:wait', [request]);
      expect(urgent.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['pr.merged', 'pr.conflicted']);
      expect(urgent.entries[1]).toMatchObject({ paneId: 'worker', source: 'github', pr });

      // Without --session, PR kinds arrive only when listed.
      const listed = await registry.invoke('runpane:workspace:wait', [{ since: 0, timeoutMs: 0, kinds: ['pr.checks', 'pr.conflicted'] }]);
      expect(listed.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['pr.conflicted']);
      const unlisted = await registry.invoke('runpane:workspace:wait', [{ since: 0, timeoutMs: 0 }]);
      expect(unlisted.entries.some((entry: { kind: string }) => entry.kind.startsWith('pr.'))).toBe(false);
    });

    it('rejects --session with --pane and an unknown Session', async () => {
      const { registry } = sessionRegistry();
      await expect(registry.invoke('runpane:workspace:wait', [{ session: 'Release', paneIds: [session.id], timeoutMs: 0 }]))
        .rejects.toThrow('cannot include both session and paneIds');
      await expect(registry.invoke('runpane:workspace:wait', [{ session: 'Nope', timeoutMs: 0 }]))
        .rejects.toThrow('Session Nope not found');
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

  it('accepts named cursors up to 128 characters, such as session-<full session id>', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-cursor-test-'));
    tempDirs.push(directory);
    const cursorPath = path.join(directory, 'workspace-cursors.json');
    const registry = createRegistry(createServices({
      workspaceJournal: new WorkspaceJournal(),
      workspaceCursorStore: new WorkspaceCursorStore(cursorPath),
    }));
    const sessionCursor = 'session-__orchestration_session_1b4e28ba-2fa1-11d2-883f-0016d3cca427__';
    expect(sessionCursor).toHaveLength(70);
    const longest = `c${'x'.repeat(127)}`;

    for (const as of [sessionCursor, longest]) {
      await expect(registry.invoke('runpane:workspace:wait', [{ as, timeoutMs: 0 }]))
        .resolves.toMatchObject({ ok: true, reset: { reason: 'first-use' } });
    }
    const stored = new WorkspaceCursorStore(cursorPath);
    expect(stored.get(sessionCursor)).toBeDefined();
    expect(stored.get(longest)).toBeDefined();

    await expect(registry.invoke('runpane:workspace:wait', [{ as: `${longest}x`, timeoutMs: 0 }]))
      .rejects.toThrow('1-128 letters');
    await expect(registry.invoke('runpane:workspace:wait', [{ as: 'session/with-slash', timeoutMs: 0 }]))
      .rejects.toThrow('1-128 letters');
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
      expect.objectContaining({ kind: 'pane.created', baseline: true, replay: true }),
    );
    // A replayed agent.ready restates state; it is never READY.
    expect(result.entries).toContainEqual(
      expect.objectContaining({ kind: 'agent.ready', baseline: true, replay: true }),
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

  it('recognizes a WSL repo registered by the UI through either UNC spelling', async () => {
    const savedProject: Project = {
      ...project, path: '/home/user/repo', wsl_enabled: true, wsl_distribution: 'Ubuntu',
    };
    const services = createServices({
      // SAFETY: Repo lookup only reads these projects and never reaches persistence for an existing repo.
      databaseService: { getAllProjects: () => [savedProject] } as AppServices['databaseService'],
    });
    const registry = createRegistry(services);
    for (const path of ['\\\\wsl$\\Ubuntu\\home\\user\\repo', '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo']) {
      await expect(registry.invoke('runpane:repos:add', [{ path }])).resolves.toMatchObject({
        ok: true, created: false, repo: { path: '/home/user/repo', environment: 'wsl' },
      });
    }
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
        // The stored status is `stopped`; the live terminal makes it running.
        status: 'running',
        agentStatus: 'idle',
        agentState: 'ready',
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
        launchCommand: RUNPANE_CONTRACT.agentTemplates.claude.command,
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
    // The agent has exited: Pane's own shell is in the foreground.
    vi.mocked(terminalPanelManager.getForegroundProcess).mockReturnValue({ name: 'zsh', isShell: true });
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
      '\r',
    );
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      sequenceName: 'enter-cr',
      verifiedSubmitted: true,
    });
  });

  it('stages and queues text while Codex is working', async () => {
    vi.useFakeTimers();
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('• Working (tab to queue message)\n› Ask Codex to do anything\n', 'active'))
      .mockReturnValueOnce(terminalSnapshot('• Working (tab to queue message)\n› ping-busy\n', 'active'))
      .mockReturnValue(terminalSnapshot('• Working\n› Ask Codex to do anything\n', 'active'));
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'ping-busy' }]);
    await vi.advanceTimersByTimeAsync(600);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, 'ping-busy');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, terminalPanel.id, '\t');
    expect(result).toMatchObject({ ok: true, enter: 'tab', sequenceName: 'tab', verifiedSubmitted: true });
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

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pendingResult;

    expect(redrawShown).toBe(true);
    // The text stayed in the composer, so auto sent exactly one more Enter.
    expect(enters).toBe(2);
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

    // Drain the echo wait and both bounded submit checks, including the retry.
    await vi.runAllTimersAsync();
    const result = await pendingResult;

    expect(enters).toBe(2);
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
      sequenceName: 'enter-cr',
      verifiedSubmitted: false,
      blocked: {
        kind: 'agent-prompt',
        suggestedCommand: `runpane panels input --panel ${terminalPanel.id} --keys enter --yes --json`,
      },
    });
  });

  it('submits an idle Codex composer with Enter and verifies composer cleared', async () => {
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

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 1,
      strategy: 'enter',
      sequenceName: 'enter-cr',
      verifiedSubmitted: true,
      nextCommand: `runpane panels wait --panel ${terminalPanel.id} --for ready --timeout-ms 30000 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:submit-composer',
        status: 'success',
        input_bytes: 1,
      }),
    );
  });

  it('queues a working Codex composer with Tab and verifies it left the composer', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce(terminalSnapshot('• Working (tab to queue message)\n› follow-up\n', 'active'))
      .mockReturnValue(terminalSnapshot('• Working\n› Ask Codex to do anything\n', 'active'));
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:submit-composer', [{ panelId: terminalPanel.id, strategy: 'auto' }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '\t');
    expect(result).toMatchObject({ ok: true, strategy: 'tab', sequenceName: 'tab', verifiedSubmitted: true });
  });

  it('blocks submit-composer when the Codex pasted-content composer remains visible', async () => {
    vi.useFakeTimers();
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

    const pendingResult = registry.invoke('runpane:panels:submit-composer', [{
      panelId: terminalPanel.id,
      strategy: 'auto',
    }]);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, '\r');
    // The pasted content is still in the composer: one plain Enter, then report.
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, terminalPanel.id, '\r');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      panelId: terminalPanel.id,
      inputBytes: 2,
      strategy: 'enter',
      sequenceName: 'enter-cr',
      verifiedSubmitted: false,
      blocked: {
        kind: 'agent-prompt',
        suggestedCommand: `runpane panels input --panel ${terminalPanel.id} --keys enter --yes --json`,
      },
    });
  });

  it('refuses to type into a Codex panel with no composer on screen', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot('• Working (12s • esc to interrupt)\n', 'active'),
    );
    vi.mocked(terminalPanelManager.getForegroundProcess).mockReturnValue({ name: 'codex', isShell: false });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Continue\n',
    }]);

    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      inputBytes: 0,
      verifiedSubmitted: false,
      blocked: {
        kind: 'composer-unknown',
        suggestedCommand: `runpane panels screen --panel ${terminalPanel.id} --limit 80 --json`,
      },
    });
  });

  it('refuses to type into a Claude panel whose composer never appears', async () => {
    vi.useFakeTimers();
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(
      terminalSnapshot('Claude Code v2.1.283\nLoading…\n', 'active', 'claude'),
    );
    vi.mocked(terminalPanelManager.getLastOutputAt).mockImplementation(() => new Date().toISOString());
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'Read and follow brief.md',
    }]);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, blocked: { kind: 'composer-unknown' } });
  });

  it('keeps the plain write for a panel with no agent evidence', async () => {
    const shellPanel: ToolPanel = { ...terminalPanel, state: { ...terminalPanel.state, customState: { initialCommand: 'python3' } } };
    vi.mocked(panelManager.getPanel).mockReturnValue(shellPanel);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      ...terminalSnapshot('>>> ', 'idle'),
      isCliPanel: undefined,
      isCliReady: undefined,
      agentType: undefined,
    });
    vi.mocked(terminalPanelManager.getForegroundProcess).mockReturnValue({ name: 'python3', isShell: false });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:submit', [{
      panelId: shellPanel.id,
      input: 'print(1)',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(shellPanel.id, 'print(1)\r');
    expect(result).toMatchObject({ ok: true, verifiedSubmitted: false });
  });

  it.each([
    ['a detected wrapper agent', { agentType: 'claude', agentDetection: 'process', launchMode: 'wrapped', initialCommand: 'agent-farm run free-range', isCliPanel: true }, 'claude'],
    ['a wrapper whose screen shows Claude before detection confirms it', { initialCommand: 'agent-farm run free-range' }, undefined],
  ] as const)('stages text and presses Enter separately for %s', async (_label, customState, snapshotAgent) => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    const wrapperPanel: ToolPanel = { ...terminalPanel, title: 'Farm', state: { ...terminalPanel.state, customState: { ...customState } } };
    vi.mocked(panelManager.getPanel).mockReturnValue(wrapperPanel);
    let staged = false;
    let enters = 0;
    vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
      if (data === '\r') enters += 1;
      else staged = true;
    });
    vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => {
      const text = !staged
        ? `${rule}\n❯ \n${rule}\n`
        : enters === 0
          ? `${rule}\n❯ Read and follow brief.md\n${rule}\n`
          : `❯ Read and follow brief.md\n✻ Working\n${rule}\n❯ \n${rule}\n`;
      return {
        ...terminalSnapshot(text, enters === 0 ? 'idle' : 'active', 'claude'),
        agentType: snapshotAgent,
        isCliPanel: snapshotAgent ? true : undefined,
      };
    });
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit', [{
      panelId: wrapperPanel.id,
      input: 'Read and follow brief.md\n',
    }]);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, wrapperPanel.id, 'Read and follow brief.md');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, wrapperPanel.id, '\r');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, sequenceName: 'enter-cr', verifiedSubmitted: true });
  });

  it('sends one more Enter from submit-composer auto when the staged text is still visible', async () => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    let enters = 0;
    vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation(() => {
      enters += 1;
    });
    vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => enters);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
      enters < 2 ? `${rule}\n❯ Read and follow brief.md\n${rule}\n` : `✻ Working\n${rule}\n❯ \n${rule}\n`,
      'active',
      'claude',
    ));
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit-composer', [{ panelId: terminalPanel.id, strategy: 'auto' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(2);
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, terminalPanel.id, '\r');
    expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, inputBytes: 2 });
  });

  it.each(['auto', 'enter'] as const)('never sends a second Enter to an empty composer (strategy %s)', async (strategy) => {
    vi.useFakeTimers();
    const rule = '─'.repeat(40);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(terminalSnapshot(`${rule}\n❯ \n${rule}\n`, 'idle', 'claude'));
    const registry = createRegistry();

    const pendingResult = registry.invoke('runpane:panels:submit-composer', [{ panelId: terminalPanel.id, strategy }]);
    await vi.advanceTimersByTimeAsync(10_000);
    await pendingResult;

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledTimes(1);
  });

  it('reports an adopted pane as running while its terminal is live and rolls up agent state', async () => {
    const adopted: Session = { ...session, status: 'stopped', worktreeOwnership: 'external' };
    const services = createServices();
    vi.mocked(services.sessionManager.getSessionsForProject).mockReturnValue([adopted]);
    const registry = createRegistry(services);

    vi.mocked(terminalPanelManager.getAgentStatus).mockReturnValue('blocked');
    const live = await registry.invoke('runpane:panes:list', [{ repo: 'active' }]);
    expect(live).toMatchObject({ panes: [{ status: 'running', agentStatus: 'active', agentState: 'blocked', ownership: 'external' }] });

    vi.mocked(terminalPanelManager.getAgentStatus).mockReturnValue('working');
    const working = await registry.invoke('runpane:panes:list', [{ repo: 'active' }]);
    expect(working).toMatchObject({ panes: [{ status: 'running', agentState: 'working' }] });

    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(false);
    const stopped = await registry.invoke('runpane:panes:list', [{ repo: 'active' }]);
    expect(stopped).toMatchObject({ panes: [{ status: 'stopped', agentState: 'none' }] });
  });

  it('lists how Pane knows each panel\'s agent and its launch command', async () => {
    const wrapperPanel: ToolPanel = {
      ...terminalPanel,
      state: {
        ...terminalPanel.state,
        customState: { agentType: 'claude', agentDetection: 'screen', launchMode: 'wrapped', initialCommand: 'agent-farm run free-range', isCliPanel: true },
      },
    };
    const commandPanel: ToolPanel = {
      ...terminalPanel,
      id: 'panel-2',
      state: { ...terminalPanel.state, customState: { initialCommand: 'codex --yolo' } },
    };
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([wrapperPanel, commandPanel]);
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:list', [{ paneId: session.id }]);

    expect(result).toMatchObject({
      panels: [
        { panelId: 'panel-1', agentType: 'claude', agentDetection: 'screen', launchCommand: 'agent-farm run free-range', isCliPanel: true },
        { panelId: 'panel-2', agentType: 'codex', agentDetection: 'command', launchCommand: 'codex --yolo', isCliPanel: true },
      ],
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
      scrollbackBuffer: '› Ask Codex to do anything\n',
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
        text: '› Ask Codex to do anything\n',
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

  it('reports a trust prompt as blocked before the published agent status catches up', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(terminalSnapshot(
      'Folder access\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue · esc quit\n',
      'active',
    ));
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      condition: 'ready',
      timeoutMs: 10,
    }]);

    expect(result).toMatchObject({
      ok: false,
      condition: 'ready',
      matched: false,
      timedOut: false,
      blocked: { kind: 'agent-prompt' },
    });
  });

  it('does not report an agent ready before its composer is on screen', async () => {
    // Real Codex 0.156.1 boot frame, drawn about half a second before its trust prompt.
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(terminalSnapshot(
      '╭───────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.156.1)            │\n│                                       │\n│ model:     loading   /model to change │\n│ directory: loading                    │\n╰───────────────────────────────────────╯\n› Ask Codex to do anything\n',
      'active',
    ));
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      condition: 'ready',
      timeoutMs: 10,
      intervalMs: 5,
    }]);

    expect(result).toMatchObject({ ok: false, matched: false, timedOut: true });
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

    const associate = vi.fn(async () => ({}));
    // SAFETY: The handler only calls associate on the Sessions manager.
    const services = createServices({ orchestrationSessionManager: { associate } as never });
    vi.mocked(terminalPanelManager.initializeTerminal).mockImplementation(async () => {
      expect(associate).toHaveBeenCalledWith({ sessionId: 'orchestrator-1' }, { paneId: session.id });
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      timeoutMs: 1234,
      associateSession: 'orchestrator-1',
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
        launchCommand: RUNPANE_CONTRACT.agentTemplates.codex.command,
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
        association: { sessionId: 'orchestrator-1', ok: true },
        nextCommand: 'runpane panels output --panel panel-1 --limit 200 --json',
      }],
    });
  });

  describe('panes create --branch', () => {
    function branchServices(existingBranches: string[] = []): AppServices {
      const repoPath = createTempGitRepo('branch-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      execFileSync('git', ['branch', 'release/foo'], { cwd: repoPath, stdio: 'ignore' });
      for (const branch of existingBranches) {
        execFileSync('git', ['branch', branch], { cwd: repoPath, stdio: 'ignore' });
      }
      const branchProject = { ...project, path: repoPath };
      // SAFETY: This session-manager double implements the project-context lookup the create handler uses.
      return createServices({
        databaseService: { ...createServices().databaseService, getAllProjects: vi.fn(() => [branchProject]) },
        sessionManager: {
          ...createServices().sessionManager,
          getProjectContextByProjectId: vi.fn(() => ({ commandRunner: new CommandRunner(branchProject) })),
        } as never,
      });
    }

    it('passes the exact requested branch and base to pane creation', async () => {
      vi.mocked(panelManager.createPanel).mockResolvedValue(terminalPanel);
      const services = branchServices();

      const result = await createRegistry(services).invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [{ name: 'w5a', branch: 'agents/x', baseBranch: 'release/foo', tool: { agent: 'codex' } }],
      }]);

      expect(result).toMatchObject({ ok: true, items: [{ ok: true }] });
      expect(services.taskQueue?.createSessionAndWait).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeTemplate: 'w5a', branchName: 'agents/x', baseBranch: 'release/foo' }),
        expect.anything(),
      );
    });

    it('fails an existing or invalid branch before queueing, including in dry runs', async () => {
      const services = branchServices(['agents/taken']);
      const registry = createRegistry(services);

      const existing = await registry.invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [{ name: 'w5a', branch: 'agents/taken', tool: { agent: 'codex' } }],
      }]);
      const invalid = await registry.invoke('runpane:panes:create', [{
        repo: { id: project.id },
        dryRun: true,
        panes: [
          { name: 'ok', branch: 'agents/new', tool: { agent: 'codex' } },
          { name: 'bad', branch: 'agents/bad..name', tool: { agent: 'codex' } },
        ],
      }]);

      expect(existing).toMatchObject({
        ok: false,
        items: [{ ok: false, error: { message: expect.stringContaining("Branch 'agents/taken' already exists") } }],
      });
      expect(invalid).toMatchObject({
        ok: false,
        items: [{ ok: true, name: 'ok' }, { ok: false, name: 'bad', error: { message: expect.stringContaining('check-ref-format') } }],
      });
      expect(services.taskQueue?.createSessionAndWait).not.toHaveBeenCalled();
    });

    it('refuses the same branch twice in one request', async () => {
      await expect(createRegistry(branchServices()).invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [
          { name: 'a', branch: 'agents/x', tool: { agent: 'codex' } },
          { name: 'b', branch: 'agents/x', tool: { agent: 'codex' } },
        ],
      }])).rejects.toThrow("names branch 'agents/x' more than once");
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
    const emit = vi.fn();
    const renameSessionDisplayName = vi.fn((_id: string, name: string) => {
      renamedSession.name = name;
      emit('session-updated', renamedSession);
      return renamedSession;
    });
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSession: vi.fn(() => renamedSession),
        renameSessionDisplayName,
        emit,
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:rename', [{
      paneId: session.id,
      name: '  renamed pane  ',
    }]);

    expect(renameSessionDisplayName).toHaveBeenCalledWith(session.id, 'renamed pane');
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
    const renameSessionDisplayName = vi.fn((_id: string, name: string) => {
      renamedSession.name = name;
      return renamedSession;
    });
    const services = createServices({
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      sessionManager: {
        ...createServices().sessionManager,
        getSession: vi.fn(() => renamedSession),
        renameSessionDisplayName,
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
      scrollbackBuffer: '› Ask Codex to do anything\n',
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
      scrollbackBuffer: `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n`,
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
          delivery: { state: 'taken', evidence: 'argv' },
        },
      }],
    });

    // Once Claude has recorded the turn, the transcript is the evidence.
    findUserTurnSince.mockResolvedValue({ state: 'taken', file: '/t.jsonl' });
    const recorded = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{ name: 'issue-303', tool: { agent: 'claude', initialInput: 'Please start issue 302' } }],
    }]);
    expect(recorded).toMatchObject({ items: [{ initialInput: { delivery: { state: 'taken', evidence: 'transcript' } } }] });
    expect(findUserTurnSince).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', cwd: session.worktreePath }),
      Date.parse('2026-01-01T00:02:00.000Z'),
      'Please start issue 302',
    );
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
          delivery: { state: 'unknown', evidence: 'argv' },
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
          error: { message: 'The agent is not ready yet, so initial input is queued and sent once it is.' },
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
              toolKind === 'codex'
                ? `› ${inputCase.name === 'slash' ? inputCase.input : 'Ask Codex to do anything'}`
                : `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}`,
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

  describe('intact prompt delivery', () => {
    const rule = '─'.repeat(40);
    const claudeComposer = (content: string) => `${rule}\n❯ ${content}\n${rule}\n`;

    function createdTerminalPanel(request: CreatePanelRequest): ToolPanel {
      return {
        id: 'panel-1',
        sessionId: session.id,
        type: 'terminal',
        title: request.title ?? '',
        // SAFETY: The terminal panel mock keeps the terminal customState it was created with.
        state: { isActive: false, customState: { ...(request.initialState as TerminalPanelState) } },
        metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:01:00.000Z', position: 0 },
      };
    }

    function createdInitialState(): TerminalPanelState {
      // SAFETY: createPanel was invoked for a terminal panel, so initialState is the terminal customState.
      return vi.mocked(panelManager.createPanel).mock.calls[0]?.[0].initialState as TerminalPanelState;
    }

    it('pastes multi-line Claude text as one bracketed paste and presses Enter alone once the paste settles', async () => {
      vi.useFakeTimers();
      vi.mocked(terminalPanelManager.isBracketedPasteEnabled).mockReturnValue(true);
      let stagedAt = -1;
      let enterAt = -1;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enterAt = Date.now();
        else stagedAt = Date.now();
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (stagedAt < 0 ? 0 : enterAt < 0 ? 1 : 2));
      // Claude keeps drawing the paste for 600ms after it arrives.
      vi.mocked(terminalPanelManager.getLastOutputAt).mockImplementation(() => (stagedAt < 0 || enterAt >= 0
        ? undefined
        : new Date(Math.min(Date.now(), stagedAt + 600)).toISOString()));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        stagedAt < 0
          ? claudeComposer('')
          : enterAt < 0 ? claudeComposer('[Pasted text #1 +2 lines]') : `✻ Working\n${claudeComposer('')}`,
        enterAt < 0 ? 'idle' : 'active',
        'claude',
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{
        panelId: terminalPanel.id,
        input: 'First line\r\nSecond line\r\nThird line\r\n',
      }]);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      const paste = '\x1b[200~First line\nSecond line\nThird line\x1b[201~';
      expect(vi.mocked(terminalPanelManager.writeToTerminal).mock.calls).toEqual([
        [terminalPanel.id, paste],
        [terminalPanel.id, '\r'],
      ]);
      expect(enterAt - stagedAt).toBeGreaterThanOrEqual(600 + 300);
      expect(result).toMatchObject({
        ok: true,
        verifiedSubmitted: true,
        inputBytes: Buffer.byteLength(paste, 'utf8') + 1,
      });
    });

    it('pastes long single-line Codex text before the Codex submit sequence', async () => {
      vi.useFakeTimers();
      vi.mocked(terminalPanelManager.isBracketedPasteEnabled).mockReturnValue(true);
      const text = 'x'.repeat(600);
      let staged = false;
      let submitted = false;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') submitted = true;
        else staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (submitted ? 2 : staged ? 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => (submitted
        ? terminalSnapshot('Working\n›', 'active')
        : terminalSnapshot(staged ? '› [Pasted Content 600 chars]' : '› Ask Codex to do anything', 'idle')));

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: text }]);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(vi.mocked(terminalPanelManager.writeToTerminal).mock.calls).toEqual([
        [terminalPanel.id, `\x1b[200~${text}\x1b[201~`],
        [terminalPanel.id, '\r'],
      ]);
      expect(result).toMatchObject({ ok: true, sequenceName: 'enter-cr', verifiedSubmitted: true });
    });

    it('types short single-line text without a paste even when the agent accepts one', async () => {
      vi.useFakeTimers();
      vi.mocked(terminalPanelManager.isBracketedPasteEnabled).mockReturnValue(true);
      let staged = false;
      let enters = 0;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enters += 1;
        else staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        !staged ? claudeComposer('') : enters === 0 ? claudeComposer('Continue') : `✻ Working\n${claudeComposer('')}`,
        'idle',
        'claude',
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Continue\n' }]);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;

      expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, 'Continue');
      expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, terminalPanel.id, '\r');
    });

    it('stages text for a busy Claude and sends Enter on its own, which Claude queues', async () => {
      vi.useFakeTimers();
      let staged = false;
      let enters = 0;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enters += 1;
        else staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
      vi.mocked(terminalPanelManager.getLastOutputAt).mockImplementation(() => new Date().toISOString());
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        `✻ Running 3 subagents… (esc to interrupt)\n${claudeComposer(staged && enters === 0 ? 'Also check the tests' : '')}`,
        'active',
        'claude',
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{
        panelId: terminalPanel.id,
        input: 'Also check the tests',
      }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(vi.mocked(terminalPanelManager.writeToTerminal).mock.calls).toEqual([
        [terminalPanel.id, 'Also check the tests'],
        [terminalPanel.id, '\r'],
      ]);
      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true });
    });

    it('writes the prompt to a private file and submits a one-line pointer to it', async () => {
      vi.useFakeTimers();
      let staged = false;
      let enters = 0;
      let stagedText = '';
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enters += 1;
        else {
          staged = true;
          stagedText = data;
        }
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        !staged ? claudeComposer('') : enters === 0 ? claudeComposer(stagedText) : `✻ Working\n${claudeComposer('')}`,
        'idle',
        'claude',
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{
        panelId: terminalPanel.id,
        input: '!Line one\r\nLine two\r\n',
        asFilePointer: true,
      }]);
      // The prompt file is written with real I/O before anything is typed.
      await vi.waitFor(() => expect(terminalPanelManager.writeToTerminal).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_000);
      // SAFETY: The panels:submit handler resolves to a RunpanePanelSubmitResult.
      const result = await pending as { promptFile?: string; warnings?: unknown; ok: boolean };

      const promptFile = result.promptFile ?? '';
      expect(path.dirname(promptFile)).toBe(path.join(process.env.PANE_DIR ?? '', 'prompts', session.id));
      expect(fs.readFileSync(promptFile, 'utf8')).toBe('!Line one\nLine two\n');
      if (process.platform !== 'win32') {
        expect(fs.statSync(promptFile).mode & 0o777).toBe(0o600);
      }
      expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, `Read and follow ${promptFile}`);
      expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, terminalPanel.id, '\r');
      // The pointer line, not the file's `!`, is what Claude reads.
      expect(result.warnings).toBeUndefined();
      expect(result.ok).toBe(true);
    });

    it('warns without rewriting when Claude text starts with a character Claude gives a meaning', async () => {
      vi.useFakeTimers();
      let staged = false;
      let enters = 0;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enters += 1;
        else staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        !staged ? claudeComposer('') : enters === 0 ? claudeComposer('! git status') : `✻ Working\n${claudeComposer('')}`,
        'idle',
        'claude',
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: '! git status' }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, terminalPanel.id, '! git status');
      expect(result).toMatchObject({ warnings: [{ code: 'leading-bang-runs-shell' }] });
    });

    it('launches a long or multi-line create prompt from a private prompt file instead of typing it', async () => {
      vi.mocked(panelManager.createPanel).mockImplementation(async request => createdTerminalPanel(request));

      await createRegistry().invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [{ name: 'long', tool: { agent: 'claude', initialInput: 'Line one with !bang\r\nLine two\r\n' } }],
      }]);

      const state = createdInitialState();
      expect(state).toMatchObject({
        initialInput: 'Line one with !bang\nLine two',
        initialInputMode: 'argument',
        initialInputSubmitStrategy: 'enter',
      });
      expect(path.dirname(state.initialInputFile ?? '')).toBe(path.join(process.env.PANE_DIR ?? '', 'prompts', session.id));
      expect(fs.readFileSync(state.initialInputFile ?? '', 'utf8')).toBe('Line one with !bang\nLine two\n');
    });

    it('keeps a short single-line create prompt as a launch argument', async () => {
      vi.mocked(panelManager.createPanel).mockImplementation(async request => createdTerminalPanel(request));

      await createRegistry().invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [{ name: 'short', tool: { agent: 'claude', initialInput: 'Plan issue 42' } }],
      }]);

      expect(createdInitialState()).toMatchObject({ initialInput: 'Plan issue 42', initialInputMode: 'argument' });
      expect(createdInitialState().initialInputFile).toBeUndefined();
    });

    it.each([
      ['claude', 'enter'],
      ['codex', 'codex-ctrl-enter'],
    ] as const)('hands a long %s create prompt to the composer when the shell cannot read a prompt file', async (agent, strategy) => {
      vi.mocked(terminalPanelManager.launchShellReadsPromptFile).mockReturnValue(false);
      vi.mocked(panelManager.createPanel).mockImplementation(async request => createdTerminalPanel(request));

      await createRegistry().invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [{ name: 'pwsh', tool: { agent, initialInput: 'Line one\nLine two' } }],
      }]);

      const state = createdInitialState();
      expect(state.initialInputMode).toBeUndefined();
      expect(state.initialInputFile).toBeUndefined();
      expect(state).toMatchObject({ initialInput: 'Line one\nLine two', initialInputSubmitStrategy: strategy });
    });

    it('sends a create prompt as a pointer to its file with --as-file-pointer', async () => {
      vi.mocked(panelManager.createPanel).mockImplementation(async request => createdTerminalPanel(request));

      // SAFETY: The panes:create handler resolves to a RunpanePaneCreateResult.
      const result = await createRegistry().invoke('runpane:panes:create', [{
        repo: { id: project.id },
        panes: [{
          name: 'pointer',
          tool: { agent: 'codex', initialInput: 'Step one\nStep two', initialInputAsFilePointer: true },
        }],
      }]) as { items: Array<{ promptFile?: string }> };

      const promptFile = result.items[0]?.promptFile ?? '';
      expect(fs.readFileSync(promptFile, 'utf8')).toBe('Step one\nStep two\n');
      expect(createdInitialState()).toMatchObject({
        initialInput: `Read and follow ${promptFile}`,
        initialInputMode: 'argument',
      });
      expect(createdInitialState().initialInputFile).toBeUndefined();
    });

    it('stages a wrapped Claude\'s long create prompt as a paste and submits it with its own Enter', async () => {
      vi.useFakeTimers();
      vi.mocked(terminalPanelManager.isBracketedPasteEnabled).mockReturnValue(true);
      vi.mocked(panelManager.createPanel).mockImplementation(async request => createdTerminalPanel(request));
      vi.mocked(panelManager.getPanel).mockImplementation(() => {
        const request = vi.mocked(panelManager.createPanel).mock.calls[0]?.[0];
        return request ? createdTerminalPanel(request) : undefined;
      });
      let staged = false;
      let enters = 0;
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r') enters += 1;
        else staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (staged ? enters + 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        !staged ? claudeComposer('') : enters === 0 ? claudeComposer('[Pasted text #1 +1 lines]') : `✻ Working\n${claudeComposer('')}`,
        enters === 0 ? 'idle' : 'active',
        'claude',
      ));

      const pending = createRegistry().invoke('runpane:panes:create', [{
        repo: { id: project.id },
        waitReady: true,
        readyTimeoutMs: 100,
        panes: [{
          name: 'farm',
          tool: { command: 'agent-farm run free-range', agentType: 'claude', initialInput: 'Line one\nLine two' },
        }],
      }]);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;

      expect(createdInitialState()).toMatchObject({ launchMode: 'wrapped', initialInputSubmitStrategy: 'enter' });
      expect(createdInitialState().initialInputMode).toBeUndefined();
      expect(vi.mocked(terminalPanelManager.writeToTerminal).mock.calls).toEqual([
        ['panel-1', '\x1b[200~Line one\nLine two\x1b[201~'],
        ['panel-1', '\r'],
      ]);
      expect(result).toMatchObject({
        ok: true,
        items: [{ ok: true, initialInput: { submitted: true, verifiedSubmitted: true } }],
      });
    });
  });

  describe('worker reports', () => {
    const claudeWorker: ToolPanel = {
      ...terminalPanel,
      title: 'Claude',
      state: { isActive: true, customState: { agentType: 'claude', isCliPanel: true } },
    };
    let stored: ToolPanel;

    beforeEach(() => {
      stored = structuredClone(claudeWorker);
      vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) => (panelId === stored.id ? stored : undefined));
      vi.mocked(panelManager.getPanelsForSession).mockImplementation(() => [stored]);
      // The panel store merges state writes; keep the latest one, as it would be after a restart.
      vi.mocked(panelManager.updatePanel).mockImplementation(async (_panelId, updates) => {
        if (updates.state) stored = { ...stored, state: updates.state };
      });
    });

    it('stores the latest report in the panel custom state and journals an opt-in agent.report', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-27T18:00:00.000Z'));
      // SAFETY: Only recordAgentReport is reached by the report handler, and it is stubbed below.
      const orchestrationSessionManager = Object.create(OrchestrationSessionManager.prototype) as OrchestrationSessionManager;
      const recordAgentReport = vi.spyOn(orchestrationSessionManager, 'recordAgentReport').mockResolvedValue(['session-a']);
      // The registry builds its own journal, which names Panes through the session manager.
      const services = createServices({ orchestrationSessionManager });
      const registry = createRegistry(services);

      const result = await registry.invoke('runpane:report', [{
        paneId: session.id,
        panelId: terminalPanel.id,
        state: 'ready',
        pr: 747,
        head: 'FC5DCE9',
        summary: `Opened PR 747. ${'x'.repeat(3_000)}`,
        summaryPath: '/tmp/report.md',
      }]);
      vi.useRealTimers();

      const report = {
        state: 'ready', pr: 747, head: 'fc5dce9', summary: `Opened PR 747. ${'x'.repeat(3_000)}`, summaryPath: '/tmp/report.md',
        reportedAt: '2026-09-27T18:00:00.000Z',
      };
      expect(result).toEqual({ ok: true, generation: 0, paneId: session.id, panelId: terminalPanel.id, report, sessionIds: ['session-a'] });
      expect(stored.state.customState).toMatchObject({ agentType: 'claude', isCliPanel: true, agentReport: report });
      expect(recordAgentReport).toHaveBeenCalledWith(terminalPanel.id, report);

      // Consumers that do not list agent.report never receive it; released CLIs reject unknown kinds.
      expect((await registry.invoke('runpane:workspace:wait', [{ since: 0, timeoutMs: 0 }])).entries).toEqual([]);
      const optedIn = await registry.invoke('runpane:workspace:wait', [{ since: 0, timeoutMs: 0, kinds: ['agent.ready', 'agent.report'] }]);
      expect(optedIn.entries).toEqual([expect.objectContaining({
        kind: 'agent.report',
        paneId: session.id,
        paneName: session.name,
        panelId: terminalPanel.id,
        panelTitle: 'Claude',
        agentType: 'claude',
        source: 'agent',
        report: expect.objectContaining({ state: 'ready', pr: 747, head: 'fc5dce9', summaryPath: '/tmp/report.md', summaryTruncated: true }),
      })]);
      expect(optedIn.entries[0].report.summary).toHaveLength(2_000);

      // panels list and a later report read the stored one; a new report replaces it.
      const listed = await registry.invoke('runpane:panels:list', [{ paneId: session.id }]);
      expect(listed.panels[0].report).toEqual(report);
      await registry.invoke('runpane:report', [{ panelId: terminalPanel.id, state: 'blocked', question: 'Drop the old column?' }]);
      expect(stored.state.customState).toMatchObject({ agentReport: { state: 'blocked', question: 'Drop the old column?' } });
      expect(stored.state.customState).not.toHaveProperty('agentReport.pr');
    });

    it('refuses a blocked report without a question, a bad head, and a panel from another Pane', async () => {
      const registry = createRegistry();
      await expect(registry.invoke('runpane:report', [{ panelId: terminalPanel.id, state: 'blocked' }]))
        .rejects.toThrow('A blocked report needs a question');
      await expect(registry.invoke('runpane:report', [{ panelId: terminalPanel.id, state: 'ready', head: 'nothex!' }]))
        .rejects.toThrow('head must be a commit SHA');
      await expect(registry.invoke('runpane:report', [{ paneId: 'session-9', panelId: terminalPanel.id, state: 'done' }]))
        .rejects.toThrow(`Panel ${terminalPanel.id} belongs to Pane ${session.id}, not session-9.`);
      await expect(registry.invoke('runpane:report', [{ panelId: terminalPanel.id, state: 'waiting' }])).rejects.toThrow();
      expect(panelManager.updatePanel).not.toHaveBeenCalled();
    });

    describe('panels last-message', () => {
      let home: string;

      beforeEach(() => {
        home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-last-message-home-')));
        tempDirs.push(home);
        vi.stubEnv('HOME', home);
        vi.stubEnv('USERPROFILE', home);
        vi.stubEnv('CLAUDE_CONFIG_DIR', '');
      });

      afterEach(() => {
        vi.unstubAllEnvs();
      });

      /** A Claude transcript for the Pane's worktree, in the line shapes the PR5b reader fixtures use. */
      function writeClaudeTranscript(rows: object[]): void {
        const dir = path.join(home, '.claude', 'projects', claudeProjectDirName(session.worktreePath ?? ''));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'transcript.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      const assistant = (id: string, text: string, timestamp: string) => ({
        type: 'assistant',
        message: { id, role: 'assistant', content: [{ type: 'text', text }] },
        timestamp,
      });

      it('returns the last assistant reply from the transcript, keeping the end when it is long', async () => {
        writeClaudeTranscript([
          { type: 'user', message: { role: 'user', content: 'Fix the login redirect' }, timestamp: '2026-09-27T18:00:00.000Z' },
          assistant('msg-1', 'Working on it.', '2026-09-27T18:00:01.000Z'),
          assistant('msg-2', 'Opened PR #747 at fc5dce9.', '2026-09-27T18:05:00.000Z'),
          assistant('msg-2', 'Tests pass.', '2026-09-27T18:05:01.000Z'),
        ]);
        const registry = createRegistry();

        await expect(registry.invoke('runpane:panels:last-message', [{ panelId: terminalPanel.id }])).resolves.toEqual({
          ok: true,
          panelId: terminalPanel.id,
          paneId: session.id,
          agentType: 'claude',
          text: 'Opened PR #747 at fc5dce9.\nTests pass.',
          length: 38,
          limit: 20_000,
          truncated: false,
        });
        const short = await registry.invoke('runpane:panels:last-message', [{ panelId: terminalPanel.id, limit: 30 }]);
        expect(short).toMatchObject({ ok: true, truncated: true, length: 38, limit: 30 });
        expect(short.text).toBe('[earlier text truncated]\npass.');
      });

      it('reports transcript-unavailable, never the screen, without a transcript or for a shell panel', async () => {
        vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(terminalSnapshot('Opened PR #1 on screen', 'idle', 'claude'));
        const registry = createRegistry();

        const missing = await registry.invoke('runpane:panels:last-message', [{ panelId: terminalPanel.id }]);
        expect(missing).toMatchObject({ ok: false, reason: 'transcript-unavailable', panelId: terminalPanel.id, paneId: session.id });
        expect(missing.message).not.toContain('Opened PR #1');

        stored = { ...stored, state: { isActive: true, customState: {} } };
        vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(null);
        await expect(registry.invoke('runpane:panels:last-message', [{ panelId: terminalPanel.id }]))
          .resolves.toMatchObject({ ok: false, reason: 'transcript-unavailable' });
      });
    });
  });

  describe('delivery state', () => {
    const rule = '─'.repeat(40);
    const claudeComposer = (content: string) => `${rule}\n❯ ${content}\n${rule}\n`;
    const claudePanel: ToolPanel = {
      ...terminalPanel,
      title: 'Claude',
      state: { isActive: true, customState: { agentType: 'claude', isCliPanel: true, agentSessionId: '11111111-2222-4333-8444-555555555504' } },
    };

    beforeEach(() => {
      vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    });

    /** Script the screen by the writes seen so far: staged text, then Enters. */
    function scriptScreens(screen: (state: { staged: boolean; enters: number }) => string, agentType: 'claude' | 'codex' = 'claude', activity: 'active' | 'idle' = 'active') {
      const state = { staged: false, enters: 0 };
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\r' || data === '\x1b[13;5u\r') state.enters += 1;
        else state.staged = true;
      });
      vi.mocked(terminalPanelManager.getOutputGeneration).mockImplementation(() => (state.staged ? state.enters + 1 : 0));
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(screen(state), activity, agentType));
      return state;
    }

    it('reports a Claude turn the transcript shows taken, with the panel\'s transcript locator and text', async () => {
      vi.useFakeTimers();
      scriptScreens(({ staged, enters }) => claudeComposer(staged && enters === 0 ? 'Read and follow brief.md' : ''));
      findUserTurnSince.mockResolvedValue({ state: 'taken', file: '/t.jsonl', timestamp: '2026-01-01T00:03:00.000Z' });

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Read and follow brief.md' }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, delivery: { state: 'taken', evidence: 'transcript' } });
      expect(result).toMatchObject({ blocked: undefined });
      expect(findUserTurnSince).toHaveBeenCalledWith(
        {
          agent: 'claude',
          cwd: session.worktreePath,
          sessionId: '11111111-2222-4333-8444-555555555504',
          notBeforeMs: Date.parse('2026-01-01T00:00:00.000Z'),
        },
        expect.any(Number),
        'Read and follow brief.md',
      );
    });

    it('takes the transcript\'s word when Claude\'s screen never settles, and sends no second Enter', async () => {
      vi.useFakeTimers();
      // Claude is busy redrawing: the composer box keeps vanishing, so the
      // screen alone never shows it steadily empty (the old false "not delivered").
      let polls = 0;
      const state = scriptScreens(({ staged, enters }) => {
        if (!staged || enters === 0) return claudeComposer(staged ? 'Also check the tests' : '');
        polls += 1;
        return polls % 2 === 0 ? `✻ Running 3 subagents…\n${claudeComposer('')}` : '✻ Running 3 subagents…\n';
      });
      findUserTurnSince.mockImplementation(async () => (
        polls > 12 ? { state: 'taken', file: '/t.jsonl' } : { state: null, file: '/t.jsonl' }
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Also check the tests' }]);
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;

      expect(state.enters).toBe(1);
      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, delivery: { state: 'taken', evidence: 'transcript' } });
    });

    it('reports a message Claude queued while busy, from the transcript\'s queue entry', async () => {
      vi.useFakeTimers();
      scriptScreens(({ staged, enters }) => `✻ Working…\n${claudeComposer(staged && enters === 0 ? 'Reply with QUEUED' : '')}`);
      findUserTurnSince.mockResolvedValue({ state: 'queued', file: '/t.jsonl' });

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Reply with QUEUED' }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, delivery: { state: 'queued', evidence: 'transcript' } });
    });

    it('reports a message Claude queued from its queue hint when there is no transcript', async () => {
      vi.useFakeTimers();
      // Claude 2.1.283: the queued message sits above the box, the composer shows a (dim) hint.
      scriptScreens(({ staged, enters }) => (staged && enters > 0
        ? `✻ Working…\n❯ Reply with QUEUED\n  ctrl+x ctrl+s to send now\n${claudeComposer('Press up to edit queued messages')}`
        : `✻ Working…\n${claudeComposer(staged ? 'Reply with QUEUED' : '')}`));
      vi.mocked(terminalPanelManager.getInputScreenText).mockImplementation(() => undefined);

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Reply with QUEUED' }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, delivery: { state: 'queued', evidence: 'screen' } });
    });

    it('reports text still in the composer as in-composer, the only case with the composer hint', async () => {
      vi.useFakeTimers();
      scriptScreens(({ staged }) => claudeComposer(staged ? 'Read and follow brief.md' : ''), 'claude', 'idle');

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Read and follow brief.md' }]);
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        verifiedSubmitted: false,
        delivery: { state: 'in-composer', evidence: 'screen' },
        blocked: { kind: 'agent-prompt' },
      });
    });

    it('reports taken from the screen when the composer empties and no transcript is found', async () => {
      vi.useFakeTimers();
      scriptScreens(({ staged, enters }) => (enters > 0 ? `✻ Working\n${claudeComposer('')}` : claudeComposer(staged ? 'Ship it' : '')));

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Ship it' }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, delivery: { state: 'taken', evidence: 'screen' } });
    });

    it('does not read an earlier pasted turn above an emptied Codex composer as held text', async () => {
      vi.useFakeTimers();
      vi.mocked(panelManager.getPanel).mockReturnValue(terminalPanel);
      scriptScreens(({ enters }) => (enters === 0
        ? '› [Pasted Content 1200 chars] earlier\n• Done\n\n› run tests'
        : '› [Pasted Content 1200 chars] earlier\n• Done\n\n› run tests\n• Working (1s)\n\n› Ask Codex to do anything'), 'codex', 'idle');

      const pending = createRegistry().invoke('runpane:panels:submit-composer', [{ panelId: terminalPanel.id }]);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true, verifiedSubmitted: true, delivery: { state: 'taken', evidence: 'screen' } });
      expect(result).toMatchObject({ blocked: undefined });
      // submit-composer does not know the composer's text, so any turn since Enter counts.
      expect(findUserTurnSince).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', cwd: session.worktreePath }), expect.any(Number), undefined);
    });

    it.each([1, 2])('queues a busy Codex message with Tab, accepted on attempt %s', async attempts => {
      vi.useFakeTimers();
      vi.mocked(panelManager.getPanel).mockReturnValue(terminalPanel);
      const state = { staged: false, tabs: 0 };
      vi.mocked(terminalPanelManager.writeToTerminal).mockImplementation((_panelId, data) => {
        if (data === '\t') state.tabs += 1;
        else state.staged = true;
      });
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockImplementation(() => terminalSnapshot(
        state.tabs >= attempts
          ? '• Working (12s • esc to interrupt)\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ Also run the linter\n\n› Ask Codex to do anything'
          : `• Working (10s • esc to interrupt)\n\n› ${state.staged ? 'Also run the linter' : 'Ask Codex to do anything'}`,
        'active',
        'codex',
      ));

      const pending = createRegistry().invoke('runpane:panels:submit', [{ panelId: terminalPanel.id, input: 'Also run the linter' }]);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      const expected = [[terminalPanel.id, 'Also run the linter'], [terminalPanel.id, '\t']];
      if (attempts === 2) expected.push([terminalPanel.id, '\t']);
      expect(vi.mocked(terminalPanelManager.writeToTerminal).mock.calls).toEqual(expected);
      expect(result).toMatchObject({ ok: true, enter: 'tab', verifiedSubmitted: true, delivery: { state: 'queued', evidence: 'screen' } });
    });

    it('reports the composer\'s ghost text without counting it as held input', async () => {
      const screen = `${rule}\n❯ merge it\n${rule}\n  ? for shortcuts`;
      vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(terminalSnapshot(screen, 'idle', 'claude'));
      vi.mocked(terminalPanelManager.getInputScreenText).mockReturnValue(`${rule}\n❯\n${rule}\n  ? for shortcuts`);
      vi.mocked(terminalPanelManager.getGhostScreenText).mockReturnValue('\n  merge it\n\n');

      const result = await createRegistry().invoke('runpane:panels:screen', [{ panelId: terminalPanel.id }]);

      expect(result).toMatchObject({ text: screen, composer: { isPresent: true, hasUndeliveredText: false, ghostText: 'merge it' } });
    });
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
        safetyCheck: { performed: false, reason: 'external-worktree', worktreeWillRemain: true },
      });
      expect(services.gitStatusManager.getGitStatus).not.toHaveBeenCalled();

      const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id }]);
      expect(sessionsDelete).toHaveBeenCalledWith(session.id);
      expect(result).toMatchObject({
        ok: true,
        archived: true,
        worktreeCleanup: 'not-applicable',
        safetyCheck: { performed: false, reason: 'external-worktree', worktreeWillRemain: true },
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
          reason: 'main-repo',
          worktreeWillRemain: true,
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
            reason: 'git-error',
          },
        },
      });
      expect(result).not.toMatchObject({ blocked: { safetyCheck: { worktreeWillRemain: expect.anything() } } });
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

    it('reports completed with pending trash deletion as a successful archive while a large worktree is still deleting', async () => {
      const repoPath = createTempGitRepo('queued-cleanup-repo');
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
      const queuedSession: Session = { ...session, worktreePath: repoPath };
      const archiveProgressManager = new ArchiveProgressManager();
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      const services = createServices({
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        sessionManager: {
          ...createServices().sessionManager,
          getSession: vi.fn(() => queuedSession),
        } as never,
        archiveProgressManager,
      } as never);
      const registry = createRegistry(services);
      registerSessionsDeleteStub(registry, services, {
        onArchive: (sessionId) => archiveProgressManager.setTrashDeletion(sessionId, 'pending'),
      });

      const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id }]);

      expect(result).toMatchObject({ ok: true, archived: true, worktreeCleanup: 'completed', trashDeletion: 'pending' });
    });

    it('only emits worktreeCleanup values that released runpane CLIs can decode', async () => {
      // The enum shipped in runpane <= 2.4.133; its decoders reject anything else.
      const releasedWorktreeCleanup = ['completed', 'failed', 'timeout', 'not-applicable'];
      const successSchema = RUNPANE_CONTRACT.jsonSchemas.paneArchiveResult.oneOf[0];
      expect(successSchema.properties.worktreeCleanup.enum).toEqual(releasedWorktreeCleanup);

      const realSetTimeout = globalThis.setTimeout;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const emitted: unknown[] = [];
        const scenarios: Array<{
          external?: boolean;
          onArchive: (manager: ArchiveProgressManager, sessionId: string) => Promise<void> | void;
        }> = [
          { onArchive: () => undefined },
          { onArchive: (manager, sessionId) => manager.setTrashDeletion(sessionId, 'pending') },
          { onArchive: () => { throw new Error('removal failed'); } },
          // Removal still running when the 30s wait ends.
          { onArchive: () => new Promise<void>(() => undefined) },
          { external: true, onArchive: () => undefined },
        ];
        for (const scenario of scenarios) {
          const repoPath = createTempGitRepo('released-enum-repo');
          execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
          const pane: Session = { ...session, worktreePath: repoPath, worktreeOwnership: scenario.external ? 'external' : 'pane' };
          const archiveProgressManager = new ArchiveProgressManager();
          // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
          const services = createServices({
            // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
            sessionManager: {
              ...createServices().sessionManager,
              getSession: vi.fn(() => pane),
            } as never,
            archiveProgressManager,
          } as never);
          const registry = createRegistry(services);
          registerSessionsDeleteStub(registry, services, {
            onArchive: (sessionId) => scenario.onArchive(archiveProgressManager, sessionId),
          });

          let settled = false;
          const pending = Promise.resolve(registry.invoke('runpane:panes:archive', [{ paneId: session.id }]))
            .finally(() => { settled = true; });
          // git runs on real I/O; step fake time until the archive's 30s cleanup wait resolves.
          for (let step = 0; step < 400 && !settled; step++) {
            await new Promise(resolve => realSetTimeout(resolve, 10));
            await vi.advanceTimersByTimeAsync(1_000);
          }
          const result = JSON.parse(JSON.stringify(await pending));
          emitted.push(result.worktreeCleanup);
          expect(result.ok, `ok for ${result.worktreeCleanup}`).toBe(result.worktreeCleanup !== 'failed');
        }
        expect(emitted).toEqual(['completed', 'completed', 'failed', 'timeout', 'not-applicable']);
        for (const value of emitted) expect(releasedWorktreeCleanup).toContain(value);
      } finally {
        vi.useRealTimers();
      }
    }, 60_000);

    describe('adopted worktrees with --remove-worktree', () => {
      function createRepoWithLinkedWorktree(name: string) {
        const repoPath = createTempGitRepo(name);
        execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
        const worktreePath = path.join(path.dirname(repoPath), `${name}-adopted`);
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'adopted-feature', worktreePath], { cwd: repoPath, stdio: 'ignore' });
        return { repoPath, worktreePath };
      }

      function createAdoptedServices(repoPath: string, adopted: Session): AppServices {
        const commandRunner = new CommandRunner({ path: repoPath });
        const archiveProgressManager = new ArchiveProgressManager();
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        return createServices({
          // SAFETY: This test fixture intentionally supplies the minimal session manager surface exercised by archive.
          sessionManager: {
            ...createServices().sessionManager,
            getSession: vi.fn(() => adopted),
            getProjectForSession: vi.fn(() => ({ ...project, path: repoPath })),
            getProjectContext: vi.fn(() => ({ commandRunner })),
          } as never,
          // SAFETY: This test fixture intentionally supplies the minimal worktree manager surface exercised by archive.
          worktreeManager: {
            getUpstream: vi.fn(async () => null),
            getSessionComparisonBranch: vi.fn(async () => 'main'),
          } as never,
          archiveProgressManager,
        } as never);
      }

      it('evaluates safety and removes an adopted worktree into the trash, keeping its branch', async () => {
        const { repoPath, worktreePath } = createRepoWithLinkedWorktree('adopted-clean');
        const adopted: Session = { ...session, worktreePath, worktreeOwnership: 'external' };
        const services = createAdoptedServices(repoPath, adopted);
        const registry = createRegistry(services);
        const commandRunner = new CommandRunner({ path: repoPath });
        const sessionsDelete = registerSessionsDeleteStub(registry, services, {
          // Mirror sessions:delete, which removes the worktree and records the outcome.
          onArchive: async (sessionId) => {
            const outcome = await removeWorktreeViaTrash(worktreePath, repoPath, new PathResolver({ path: repoPath }), commandRunner);
            services.archiveProgressManager?.setTrashDeletion(sessionId, outcome);
          },
        });

        const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id, removeWorktree: true }]);
        await waitForPendingWorktreeTrash();

        expect(sessionsDelete).toHaveBeenCalledWith(session.id, { removeExternalWorktree: true });
        expect(result).toMatchObject({
          ok: true,
          archived: true,
          worktreeCleanup: 'completed',
          worktreePath,
          safetyCheck: {
            performed: true,
            hasUncommittedChanges: false,
            hasUntrackedFiles: false,
            unpushedCommits: 0,
          },
        });
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, encoding: 'utf8' })).not.toContain('adopted-clean-adopted');
        expect(execFileSync('git', ['branch', '--list', 'adopted-feature'], { cwd: repoPath, encoding: 'utf8' })).toContain('adopted-feature');
        expect(fs.readdirSync(path.join(repoPath, '.git', 'pane-trash'))).toEqual([]);
      });

      it('blocks an adopted worktree with uncommitted work and keeps --remove-worktree in the next command', async () => {
        const { repoPath, worktreePath } = createRepoWithLinkedWorktree('adopted-dirty');
        fs.writeFileSync(path.join(worktreePath, 'draft.txt'), 'unsaved work');
        const adopted: Session = { ...session, worktreePath, worktreeOwnership: 'external' };
        const services = createAdoptedServices(repoPath, adopted);
        const registry = createRegistry(services);
        const sessionsDelete = registerSessionsDeleteStub(registry, services);

        const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id, removeWorktree: true }]);

        expect(sessionsDelete).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          ok: false,
          blocked: { code: 'uncommitted-changes', safetyCheck: { performed: true, hasUntrackedFiles: true } },
          nextCommand: `runpane panes archive --pane ${session.id} --remove-worktree --force --yes --json`,
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
      });

      it('reports why the check was skipped without --remove-worktree, and merged-PR evidence with it or in a Session close-out', async () => {
        const { repoPath, worktreePath } = createRepoWithLinkedWorktree('adopted-merged');
        execFileSync('git', ['commit', '--allow-empty', '-m', 'squash-merged work'], { cwd: worktreePath, stdio: 'ignore' });
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
        const realExecFile = CommandRunner.prototype.execFile;
        const ghCalls: string[][] = [];
        const execFileSpy = vi.spyOn(CommandRunner.prototype, 'execFile').mockImplementation(async function (this: CommandRunner, file, args, cwd, options) {
          if (file !== 'gh') return realExecFile.call(this, file, args, cwd, options);
          ghCalls.push([...args]);
          return { stdout: JSON.stringify([{ number: 42, headRefOid: head }]), stderr: '', exitCode: 0 };
        });
        try {
          const adopted: Session = { ...session, worktreePath, worktreeOwnership: 'external' };
          const services = createAdoptedServices(repoPath, adopted);
          const registry = createRegistry(services);
          const sessionsDelete = registerSessionsDeleteStub(registry, services);

          // Without --remove-worktree the adopted worktree stays, so nothing is checked.
          const kept = JSON.parse(JSON.stringify(await registry.invoke('runpane:panes:archive', [{ paneId: session.id, dryRun: true }])));
          expect(kept).toMatchObject({
            ok: true,
            wouldArchive: true,
            safetyCheck: { performed: false, reason: 'external-worktree', worktreeWillRemain: true },
          });
          expect(kept.safetyCheck).not.toHaveProperty('mergedViaPr');
          expect(ghCalls).toEqual([]);

          // With it, the same Pane gets #832's check, and the squash-merged branch counts as pushed.
          const removed = JSON.parse(JSON.stringify(await registry.invoke('runpane:panes:archive', [{ paneId: session.id, dryRun: true, removeWorktree: true }])));
          expect(removed).toMatchObject({
            ok: true,
            wouldArchive: true,
            safetyCheck: { performed: true, unpushedCommits: 0, mergedViaPr: { number: 42, headOid: head } },
          });
          expect(removed.safetyCheck).not.toHaveProperty('reason');
          expect(removed.safetyCheck).not.toHaveProperty('worktreeWillRemain');

          // A Session close-out checks every Pane; the adopted one keeps its worktree without --remove-worktree.
          const get = vi.fn(async () => ({
            id: 'orchestration-1',
            name: 'refactor',
            associations: [{ paneId: session.id, panelIds: [], attachedAt: '2026-01-01T00:00:00.000Z' }],
          }));
          // SAFETY: This test fixture supplies the one Sessions manager method the bulk archive calls.
          const bulkServices: AppServices = { ...services, orchestrationSessionManager: { get } as never };
          const bulkRegistry = createRegistry(bulkServices);
          registerSessionsDeleteStub(bulkRegistry, bulkServices);
          await expect(bulkRegistry.invoke('runpane:panes:archive', [{ sessionId: 'refactor', merged: true, dryRun: true }])).resolves.toMatchObject({
            ok: true,
            removeWorktree: false,
            archived: 1,
            items: [{
              paneId: session.id,
              outcome: 'would-archive',
              safetyCheck: { performed: true, mergedViaPr: { number: 42, headOid: head }, worktreeWillRemain: true },
            }],
          });
          expect(sessionsDelete).not.toHaveBeenCalled();
          expect(fs.existsSync(worktreePath)).toBe(true);
        } finally {
          execFileSpy.mockRestore();
        }
      });

      it('refuses to remove an adopted path that is the repository main checkout', async () => {
        const { repoPath } = createRepoWithLinkedWorktree('adopted-main');
        const adopted: Session = { ...session, worktreePath: repoPath, worktreeOwnership: 'external' };
        const services = createAdoptedServices(repoPath, adopted);
        const registry = createRegistry(services);
        const sessionsDelete = registerSessionsDeleteStub(registry, services);

        await expect(registry.invoke('runpane:panes:archive', [{ paneId: session.id, removeWorktree: true }]))
          .rejects.toThrow(/main checkout/);
        expect(sessionsDelete).not.toHaveBeenCalled();
      });
    });

    describe('merged pull request evidence', () => {
      function createFeatureBranchRepo(name: string) {
        const repoPath = createTempGitRepo(name);
        execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
        execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repoPath, stdio: 'ignore' });
        execFileSync('git', ['commit', '--allow-empty', '-m', 'squash-merged work'], { cwd: repoPath, stdio: 'ignore' });
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
        return { repoPath, head };
      }

      type GhResponse = { stdout: string } | Error;

      /** A real CommandRunner whose `gh` calls return a canned response; git runs for real. */
      function createRunnerWithGh(repoPath: string, gh: GhResponse) {
        const commandRunner = new CommandRunner({ path: repoPath });
        const realExecFile = commandRunner.execFile.bind(commandRunner);
        const ghCalls: string[][] = [];
        vi.spyOn(commandRunner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
          if (file !== 'gh') return realExecFile(file, args, cwd, options);
          ghCalls.push([...args]);
          if (gh instanceof Error) throw gh;
          return { stdout: gh.stdout, stderr: '', exitCode: 0 };
        });
        return { commandRunner, ghCalls };
      }

      function createMergedServices(featureSession: Session, commandRunner: CommandRunner, upstream: string | null = null): AppServices {
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        return createServices({
          // SAFETY: This test fixture intentionally supplies the minimal session manager surface exercised by archive.
          sessionManager: {
            ...createServices().sessionManager,
            getSession: vi.fn(() => featureSession),
            getProjectContext: vi.fn(() => ({ commandRunner })),
          } as never,
          // SAFETY: This test fixture intentionally supplies the minimal worktree manager surface exercised by archive.
          worktreeManager: {
            getUpstream: vi.fn(async () => upstream),
            getSessionComparisonBranch: vi.fn(async () => 'main'),
          } as never,
          archiveProgressManager: new ArchiveProgressManager(),
        } as never);
      }

      it('counts a squash-merged branch with no upstream as safe when a merged PR has HEAD as its head', async () => {
        const { repoPath, head } = createFeatureBranchRepo('squash-merged-repo');
        const { commandRunner, ghCalls } = createRunnerWithGh(repoPath, {
          stdout: JSON.stringify([{ number: 7, headRefOid: 'a'.repeat(40) }, { number: 42, headRefOid: head }]),
        });
        const services = createMergedServices({ ...session, worktreePath: repoPath }, commandRunner);
        const registry = createRegistry(services);
        const sessionsDelete = registerSessionsDeleteStub(registry, services);

        const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id, dryRun: true }]);

        expect(sessionsDelete).not.toHaveBeenCalled();
        expect(ghCalls).toEqual([['pr', 'list', '--head', 'feature', '--state', 'merged', '--json', 'number,headRefOid', '--limit', '20']]);
        expect(result).toMatchObject({
          ok: true,
          wouldArchive: true,
          safetyCheck: {
            performed: true,
            hasUpstream: false,
            unpushedCommits: 0,
            unpushedCommitDetails: [],
            mergedViaPr: { number: 42, headOid: head },
          },
        });
        expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('blocked');
      });

      it('treats an upstream deleted on the remote as gone and archives with merged PR evidence', async () => {
        const { repoPath, head } = createFeatureBranchRepo('upstream-gone-repo');
        const remotePath = path.join(path.dirname(repoPath), 'upstream-gone-remote.git');
        execFileSync('git', ['init', '--bare', '-q', remotePath], { stdio: 'ignore' });
        execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, stdio: 'ignore' });
        execFileSync('git', ['push', '-q', '-u', 'origin', 'feature'], { cwd: repoPath, stdio: 'ignore' });
        // GitHub deletes the head branch after merging; the local tracking ref goes stale.
        execFileSync('git', ['update-ref', '-d', 'refs/heads/feature'], { cwd: remotePath, stdio: 'ignore' });
        const { commandRunner } = createRunnerWithGh(repoPath, {
          stdout: JSON.stringify([{ number: 42, headRefOid: head }]),
        });
        const services = createMergedServices({ ...session, worktreePath: repoPath }, commandRunner, 'origin/feature');
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
            upstream: 'origin/feature',
            upstreamGone: true,
            unpushedCommits: 0,
            mergedViaPr: { number: 42, headOid: head },
          },
        });
      });

      it('finds no evidence when gh is missing or no merged PR head matches HEAD', async () => {
        const { repoPath } = createFeatureBranchRepo('no-evidence-repo');
        for (const gh of [
          new Error('spawn gh ENOENT'),
          { stdout: JSON.stringify([{ number: 42, headRefOid: 'b'.repeat(40) }]) },
          { stdout: 'not json' },
        ]) {
          const { commandRunner } = createRunnerWithGh(repoPath, gh);
          const services = createMergedServices({ ...session, worktreePath: repoPath }, commandRunner);
          const registry = createRegistry(services);
          const sessionsDelete = registerSessionsDeleteStub(registry, services);

          const result = await registry.invoke('runpane:panes:archive', [{ paneId: session.id }]);

          expect(sessionsDelete).not.toHaveBeenCalled();
          expect(result).toMatchObject({
            ok: false,
            blocked: {
              code: 'unpushed-commits',
              safetyCheck: { unpushedCommits: 1, unpushedCommitDetails: [{ subject: 'squash-merged work' }] },
            },
          });
          expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('blocked.safetyCheck.mergedViaPr');
        }
      });
    });

    describe('--session --merged', () => {
      function createBulkServices(panes: Session[], associations: string[]) {
        const byId = new Map(panes.map(pane => [pane.id, pane]));
        const get = vi.fn(async () => ({
          id: 'orchestration-1',
          name: 'refactor',
          associations: associations.map(paneId => ({ paneId, panelIds: [], attachedAt: '2026-01-01T00:00:00.000Z' })),
        }));
        // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
        const services = createServices({
          // SAFETY: This test fixture intentionally supplies the minimal session manager surface exercised by archive.
          sessionManager: {
            ...createServices().sessionManager,
            getSession: vi.fn((paneId: string) => byId.get(paneId)),
            getProjectContext: vi.fn(() => ({ commandRunner: new CommandRunner({ path: os.tmpdir() }) })),
          } as never,
          // SAFETY: This test fixture intentionally supplies the minimal Sessions manager surface exercised by archive.
          orchestrationSessionManager: { get } as never,
          archiveProgressManager: new ArchiveProgressManager(),
        } as never);
        return { services, get };
      }

      function createBulkPanes(): Session[] {
        const cleanRepo = createTempGitRepo('bulk-clean');
        execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: cleanRepo, stdio: 'ignore' });
        const dirtyRepo = createTempGitRepo('bulk-dirty');
        execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dirtyRepo, stdio: 'ignore' });
        fs.writeFileSync(path.join(dirtyRepo, 'draft.txt'), 'unsaved work');
        return [
          { ...session, id: 'pane-clean', name: 'clean', worktreePath: cleanRepo },
          { ...session, id: 'pane-dirty', name: 'dirty', worktreePath: dirtyRepo },
          { ...session, id: 'pane-archived', name: 'archived', archived: true },
          { ...session, id: 'pane-main', name: 'main', isMainRepo: true },
        ];
      }

      it('dry-runs the Session archive and reports a reason for every skipped Pane', async () => {
        const panes = createBulkPanes();
        const { services, get } = createBulkServices(panes, ['pane-clean', 'pane-dirty', 'pane-archived', 'pane-main', 'pane-missing', 'pane-clean']);
        const registry = createRegistry(services);
        const sessionsDelete = registerSessionsDeleteStub(registry, services);

        const result = await registry.invoke('runpane:panes:archive', [{ sessionId: 'refactor', merged: true, dryRun: true }]);

        expect(get).toHaveBeenCalledWith({ sessionId: 'refactor' });
        expect(sessionsDelete).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          ok: true,
          sessionId: 'orchestration-1',
          merged: true,
          dryRun: true,
          removeWorktree: false,
          archived: 1,
          skipped: 4,
          failed: 0,
          items: [
            { paneId: 'pane-clean', name: 'clean', outcome: 'would-archive', safetyCheck: { performed: true, unpushedCommits: 0 } },
            { paneId: 'pane-dirty', outcome: 'skipped', skipped: { code: 'uncommitted-changes' }, safetyCheck: { hasUntrackedFiles: true } },
            { paneId: 'pane-archived', outcome: 'skipped', skipped: { code: 'already-archived' } },
            { paneId: 'pane-main', outcome: 'skipped', skipped: { code: 'main-repo' } },
            { paneId: 'pane-missing', outcome: 'skipped', skipped: { code: 'missing-pane' } },
          ],
        });
      });

      it('archives only the safe Panes of the Session', async () => {
        const panes = createBulkPanes();
        const { services } = createBulkServices(panes, ['pane-clean', 'pane-dirty']);
        const registry = createRegistry(services);
        const sessionsDelete = registerSessionsDeleteStub(registry, services);

        const result = await registry.invoke('runpane:panes:archive', [{ sessionId: 'refactor', merged: true }]);

        expect(sessionsDelete).toHaveBeenCalledTimes(1);
        expect(sessionsDelete).toHaveBeenCalledWith('pane-clean');
        expect(result).toMatchObject({
          ok: true,
          archived: 1,
          skipped: 1,
          items: [
            { paneId: 'pane-clean', outcome: 'archived', worktreeCleanup: 'completed' },
            { paneId: 'pane-dirty', outcome: 'skipped', skipped: { code: 'uncommitted-changes' } },
          ],
        });
      });

      it('rejects a Session archive without --merged or with --force', async () => {
        const { services } = createBulkServices([], []);
        const registry = createRegistry(services);
        registerSessionsDeleteStub(registry, services);

        await expect(registry.invoke('runpane:panes:archive', [{ sessionId: 'refactor' }])).rejects.toThrow(/merged/);
        await expect(registry.invoke('runpane:panes:archive', [{ sessionId: 'refactor', merged: true, force: true }])).rejects.toThrow(/force/);
        await expect(registry.invoke('runpane:panes:archive', [{ sessionId: 'refactor', merged: true, paneId: 'pane-clean' }])).rejects.toThrow(/either paneId or sessionId/);
      });
    });
  });

  describe('runpane:panes:focus', () => {
    const sentEvents = vi.fn();

    beforeEach(() => {
      sentEvents.mockReset();
      setPaneRuntime({
        eventSink: { send: sentEvents },
        getConfigManager: () => { throw new Error('unused'); },
        getPtyHostRuntime: () => null,
        getWebviewContextMap: () => new Map(),
      });
    });

    afterEach(() => {
      resetPaneRuntimeForTests();
    });

    function createMockWindow() {
      return {
        isMinimized: vi.fn(() => false),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
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
      expect(sentEvents).toHaveBeenCalledWith('pane:focus-requested', {
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
      expect(sentEvents).toHaveBeenCalledWith('pane:focus-requested', {
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

    it('emits the focus event for connected clients when the host has no window', async () => {
      const registry = createRegistry(createServices({ getMainWindow: () => null }));

      const result = await registry.invoke('runpane:panes:focus', [{ paneId: session.id }]);

      expect(sentEvents).toHaveBeenCalledWith('pane:focus-requested', { paneId: session.id, panelId: undefined });
      expect(result).toMatchObject({ ok: true, paneId: session.id });
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
      expect(sentEvents).not.toHaveBeenCalled();
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
      expect(sentEvents).not.toHaveBeenCalled();
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
      expect(sentEvents).not.toHaveBeenCalled();
    });
  });

  describe('runpane:locks', () => {
    const otherPane: Session = { ...session, id: 'session-2', name: 'issue-253' };
    const otherPanel: ToolPanel = { ...terminalPanel, id: 'panel-2', sessionId: otherPane.id };
    const orchestrationSession = {
      id: 'orch-1',
      name: 'Release QA',
      internalSessionId: '__orchestration_session_release__',
      associations: [{ paneId: session.id, panelIds: [], attachedAt: '2026-01-01T00:00:00.000Z' }],
    };

    function createLockServices(overrides: Partial<AppServices> = {}) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-locks-'));
      tempDirs.push(directory);
      const namedLockService = new NamedLockService(new NamedLockStore(path.join(directory, 'locks.json')));
      const base = createServices();
      vi.mocked(base.sessionManager.getSession).mockImplementation((paneId: string) =>
        [session, otherPane].find(pane => pane.id === paneId)
      );
      const orchestrationSessionManager = {
        sessionIdForPane: vi.fn(async (paneId: string) => (paneId === session.id ? orchestrationSession.id : undefined)),
        get: vi.fn(async (selector: { sessionId?: string }) => {
          if (selector.sessionId !== orchestrationSession.id && selector.sessionId !== orchestrationSession.name) {
            throw new Error(`Session ${selector.sessionId} not found`);
          }
          return orchestrationSession;
        }),
        overview: vi.fn(async () => ({
          session: orchestrationSession,
          status: 'idle',
          panes: [],
          activity: [],
          refreshedAt: '2026-01-01T00:00:00.000Z',
        })),
      };
      return createServices({
        namedLockService,
        sessionManager: base.sessionManager,
        // SAFETY: The stub implements the three manager methods the lock and overview handlers call.
        orchestrationSessionManager: orchestrationSessionManager as never,
        ...overrides,
      });
    }

    beforeEach(() => {
      vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) =>
        [terminalPanel, otherPanel].find(panel => panel.id === panelId)
      );
    });

    it('scopes a Session member\'s lock to its Session and refuses a second owner', async () => {
      const registry = createRegistry(createLockServices());

      const acquired = await registry.invoke('runpane:locks:acquire', [{
        name: 'testing-account',
        ttlMs: 1_800_000,
        note: ' call QA ',
        owner: { paneId: session.id, panelId: terminalPanel.id },
      }]);
      expect(acquired).toMatchObject({
        ok: true,
        acquired: true,
        renewed: false,
        lock: {
          name: 'testing-account',
          scope: 'session',
          sessionId: orchestrationSession.id,
          owner: { kind: 'pane', paneId: session.id, panelId: terminalPanel.id },
          note: 'call QA',
        },
      });

      const external = await registry.invoke('runpane:locks:acquire', [{
        name: 'testing-account',
        ttlMs: 60_000,
        owner: { label: 'nightly QA script' },
      }]);
      expect(external).toMatchObject({ ok: true, lock: { scope: 'global', owner: { kind: 'external', label: 'nightly QA script' } } });

      const contended = await registry.invoke('runpane:locks:acquire', [{
        name: 'testing-account',
        ttlMs: 60_000,
        owner: { paneId: session.id },
      }]);
      expect(contended).toMatchObject({
        ok: false,
        heldBy: { kind: 'pane', paneId: session.id, panelId: terminalPanel.id },
        lock: { sessionId: orchestrationSession.id },
      });
    });

    it('resolves the owner Pane from a panel id and reports the holder to a contender', async () => {
      const registry = createRegistry(createLockServices());
      await registry.invoke('runpane:locks:acquire', [{ name: 'staging-db', ttlMs: 60_000, owner: { panelId: otherPanel.id } }]);

      const contended = await registry.invoke('runpane:locks:acquire', [{
        name: 'staging-db',
        ttlMs: 60_000,
        owner: { label: 'human' },
      }]);
      expect(contended).toMatchObject({
        ok: false,
        acquired: false,
        timedOut: false,
        heldBy: { kind: 'pane', paneId: otherPane.id, panelId: otherPanel.id },
      });
    });

    it('rejects unknown owners and callers with no identity', async () => {
      const registry = createRegistry(createLockServices());
      await expect(registry.invoke('runpane:locks:acquire', [{ name: 'x', ttlMs: 60_000, owner: {} }]))
        .rejects.toThrow(/pass --note/);
      await expect(registry.invoke('runpane:locks:acquire', [{ name: 'x', ttlMs: 60_000, owner: { paneId: 'missing' } }]))
        .rejects.toThrow(/No Pane pane found/);
      await expect(registry.invoke('runpane:locks:acquire', [{ name: 'x', ttlMs: 60_000, owner: { paneId: session.id, panelId: otherPanel.id } }]))
        .rejects.toThrow(/does not belong to Pane/);
      await expect(registry.invoke('runpane:locks:acquire', [{ name: 'bad name', ttlMs: 60_000, owner: { label: 'me' } }]))
        .rejects.toThrow(/Lock names/);
    });

    it('releases only for the owner unless forced, including from outside the Session', async () => {
      const registry = createRegistry(createLockServices());
      const owner = { paneId: session.id, panelId: terminalPanel.id };
      await registry.invoke('runpane:locks:acquire', [{ name: 'testing-account', ttlMs: 60_000, owner }]);

      await expect(registry.invoke('runpane:locks:release', [{
        name: 'testing-account',
        sessionId: orchestrationSession.name,
        owner: { label: 'human' },
      }])).resolves.toMatchObject({ ok: false, reason: 'not-owner', heldBy: { paneId: session.id } });

      await expect(registry.invoke('runpane:locks:release', [{
        name: 'testing-account',
        sessionId: orchestrationSession.name,
        force: true,
        owner: {},
      }])).resolves.toMatchObject({ ok: true, released: true, forced: true });

      await registry.invoke('runpane:locks:acquire', [{ name: 'testing-account', ttlMs: 60_000, owner }]);
      await expect(registry.invoke('runpane:locks:release', [{ name: 'testing-account', owner }]))
        .resolves.toMatchObject({ ok: true, released: true, forced: false });
    });

    it('waits in the daemon and is granted the lock when the holder releases', async () => {
      const registry = createRegistry(createLockServices());
      await registry.invoke('runpane:locks:acquire', [{ name: 'testing-account', ttlMs: 60_000, owner: { label: 'first' } }]);

      const waiting = registry.invoke('runpane:locks:acquire', [{
        name: 'testing-account',
        ttlMs: 60_000,
        waitMs: 30_000,
        owner: { label: 'second' },
      }]);
      await registry.invoke('runpane:locks:release', [{ name: 'testing-account', owner: { label: 'first' } }]);

      await expect(waiting).resolves.toMatchObject({ ok: true, acquired: true, lock: { owner: { label: 'second' } } });
    });

    it('lists all locks or one Session\'s locks, and shows them in the Session overview', async () => {
      const registry = createRegistry(createLockServices());
      await registry.invoke('runpane:locks:acquire', [{ name: 'testing-account', ttlMs: 60_000, owner: { paneId: session.id } }]);
      await registry.invoke('runpane:locks:acquire', [{ name: 'staging-db', ttlMs: 60_000, owner: { paneId: otherPane.id } }]);

      await expect(registry.invoke('runpane:locks:list', [{}])).resolves.toMatchObject({
        ok: true,
        locks: [{ name: 'staging-db', scope: 'global' }, { name: 'testing-account', scope: 'session' }],
      });
      await expect(registry.invoke('runpane:locks:list', [{ sessionId: orchestrationSession.name }])).resolves.toEqual({
        ok: true,
        locks: [expect.objectContaining({ name: 'testing-account', sessionId: orchestrationSession.id })],
      });
      await expect(registry.invoke('runpane:sessions:overview', [{ sessionId: orchestrationSession.id }])).resolves.toMatchObject({
        ok: true,
        locks: [{ name: 'testing-account', owner: { paneId: session.id } }],
      });
      await expect(registry.invoke('runpane:locks:list', [{ sessionId: 'nope' }])).rejects.toThrow(/not found/);
    });

    it('shows a member\'s worker report and the Session\'s locks together in the overview, and drops the lock when its panel exits', async () => {
      const report = { state: 'ready', pr: 747, head: 'fc5dce9', summary: 'Tests pass.', reportedAt: '2026-09-27T18:00:00.000Z', panelId: terminalPanel.id };
      const base = createLockServices();
      const namedLockService = base.namedLockService;
      if (!namedLockService) throw new Error('lock service fixture is missing');
      const services = createLockServices({
        namedLockService,
        // SAFETY: The stub implements the manager methods the lock and overview handlers call.
        orchestrationSessionManager: {
          ...base.orchestrationSessionManager,
          overview: vi.fn(async () => ({
            session: orchestrationSession,
            status: 'idle',
            panes: [{ paneId: session.id, name: session.name, archived: false, missing: false, panels: [], report }],
            activity: [],
            refreshedAt: '2026-01-01T00:00:00.000Z',
          })),
        } as never,
      });
      const registry = createRegistry(services);
      await registry.invoke('runpane:locks:acquire', [{
        name: 'testing-account',
        ttlMs: 60_000,
        owner: { paneId: session.id, panelId: terminalPanel.id },
      }]);

      await expect(registry.invoke('runpane:sessions:overview', [{ sessionId: orchestrationSession.id }])).resolves.toMatchObject({
        ok: true,
        panes: [{ paneId: session.id, report }],
        locks: [{ name: 'testing-account', owner: { paneId: session.id, panelId: terminalPanel.id } }],
      });

      namedLockService.send('panel:event', {
        type: 'terminal:exit',
        source: { panelId: terminalPanel.id, sessionId: session.id, panelType: 'terminal' },
        data: { exitCode: 0 },
      });

      await expect(registry.invoke('runpane:sessions:overview', [{ sessionId: orchestrationSession.id }])).resolves.toMatchObject({
        panes: [{ paneId: session.id, report }],
        locks: [],
      });
    });

    it('exposes the lock channels to runpane doctor', async () => {
      const registry = createRegistry(createLockServices());
      const result = await registry.invoke('runpane:doctor');
      // SAFETY: The doctor result carries a daemon.channels string array.
      const daemon = (result as { daemon: { channels: string[] } }).daemon;
      expect(daemon.channels).toEqual(expect.arrayContaining(['runpane:locks:acquire', 'runpane:locks:release', 'runpane:locks:list']));
    });
  });

  describe('runpane:panels:open', () => {
    let worktree: string;

    beforeEach(() => {
      worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-open-'));
      fs.writeFileSync(path.join(worktree, 'plan.html'), '<h1>Plan</h1>');
      fs.mkdirSync(path.join(worktree, 'src'));
      fs.writeFileSync(path.join(worktree, 'src', 'app.ts'), 'export {};');
      vi.mocked(panelManager.getPanelsForSession).mockReturnValue([]);
      vi.mocked(panelManager.createPanel).mockImplementation(async (request: CreatePanelRequest) => ({
        id: 'opened-panel',
        sessionId: request.sessionId,
        type: request.type,
        title: request.title ?? 'Panel',
        // SAFETY: The handler passes { customState } for browser and editor panels.
        state: { isActive: request.activate !== false, customState: (request.initialState as { customState?: object } | undefined)?.customState },
        metadata: { createdAt: '', lastActiveAt: '', position: 0, ...request.metadata },
      }));
    });

    afterEach(() => {
      fs.rmSync(worktree, { recursive: true, force: true });
    });

    function openServices(pane: Session, withProject = true): AppServices {
      const base = createServices();
      return createServices({
        // SAFETY: panels:open only reads getSession and getProjectContext from this fixture.
        sessionManager: {
          ...base.sessionManager,
          getSession: vi.fn(() => pane),
          getProjectContext: vi.fn(() => (withProject ? { pathResolver: new PathResolver({ path: worktree }) } : undefined)),
        } as never,
      });
    }

    it('opens an HTML file as a browser tab in split view by default', async () => {
      const registry = createRegistry(openServices({ ...session, worktreePath: worktree }));

      const result = await registry.invoke('runpane:panels:open', [{ paneId: session.id, filePath: 'plan.html', source: 'agent' }]);

      const request = vi.mocked(panelManager.createPanel).mock.calls[0][0];
      const url = pathToFileURL(path.join(worktree, 'plan.html')).href;
      expect(request).toMatchObject({
        sessionId: session.id,
        type: 'browser',
        title: 'plan.html',
        metadata: { openPlacement: 'split' },
        activate: true,
      });
      expect(request.initialState).toEqual({ customState: { currentUrl: url } });
      expect(result).toMatchObject({ ok: true, type: 'browser', filePath: 'plan.html', url, placement: 'split', reused: false, active: true });
    });

    it('opens other files as editor tabs and honors --tab and --no-focus', async () => {
      const registry = createRegistry(openServices({ ...session, worktreePath: worktree }));

      const result = await registry.invoke('runpane:panels:open', [{
        paneId: session.id, filePath: path.join(worktree, 'src', 'app.ts'), placement: 'tab', noFocus: true,
      }]);

      expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
        type: 'editor',
        initialState: { customState: { filePath: 'src/app.ts', isPreview: false, isDirty: false } },
        metadata: { openPlacement: 'tab' },
        activate: false,
      }));
      expect(result).toMatchObject({ type: 'editor', filePath: 'src/app.ts', placement: 'tab', active: false });
    });

    it('opens URLs and reuses a tab already showing the same URL', async () => {
      const existing: ToolPanel = {
        id: 'existing-browser',
        sessionId: session.id,
        type: 'browser',
        title: 'localhost:3000',
        state: { isActive: false, customState: { currentUrl: 'http://localhost:3000/' } },
        metadata: { createdAt: '', lastActiveAt: '', position: 1 },
      };
      vi.mocked(panelManager.getPanelsForSession).mockReturnValue([existing]);
      vi.mocked(panelManager.getPanel).mockReturnValue(existing);
      vi.mocked(panelManager.setActivePanel).mockImplementation(async () => { existing.state.isActive = true; });
      const registry = createRegistry(openServices({ ...session, worktreePath: worktree }));

      const result = await registry.invoke('runpane:panels:open', [{ paneId: session.id, url: 'http://localhost:3000' }]);

      expect(panelManager.createPanel).not.toHaveBeenCalled();
      expect(panelManager.setActivePanel).toHaveBeenCalledWith(session.id, 'existing-browser');
      // Reopening stamps the tab so an open page reloads with the latest content.
      expect(panelManager.updatePanel).toHaveBeenCalledWith('existing-browser', expect.objectContaining({
        state: expect.objectContaining({ isActive: true, customState: expect.objectContaining({ currentUrl: 'http://localhost:3000/', reopenedAt: expect.any(String) }) }),
      }));
      expect(result).toMatchObject({ panelId: 'existing-browser', type: 'browser', reused: true });
    });

    it('resolves files in a hidden Session orchestrator workspace', async () => {
      const orchestrator: Session = { ...session, id: '__orchestration_session_abc', isHidden: true, worktreePath: worktree };
      const registry = createRegistry(openServices(orchestrator, false));

      const result = await registry.invoke('runpane:panels:open', [{ paneId: orchestrator.id, filePath: 'plan.html' }]);

      expect(result).toMatchObject({ paneId: orchestrator.id, type: 'browser', filePath: 'plan.html' });
    });

    it.skipIf(process.platform !== 'win32')('opens a WSL Session file using its Linux mount path', async () => {
      const orchestrator: Session = { ...session, id: '__orchestration_session_wsl', isHidden: true, worktreePath: worktree };
      const services = openServices(orchestrator, false);
      // SAFETY: File resolution only reads the owning Session's runtime metadata.
      services.orchestrationSessionManager = {
        sessionIdForPane: async () => 'wsl-session',
        get: async () => ({ runtime: 'wsl', wslDistribution: 'Ubuntu-24.04' }),
      } as never;
      const registry = createRegistry(services);
      const linuxPath = `/mnt/${worktree[0].toLowerCase()}${worktree.slice(2).replaceAll('\\', '/')}/plan.html`;
      const result = await registry.invoke('runpane:panels:open', [{ paneId: orchestrator.id, filePath: linuxPath }]);
      expect(result).toMatchObject({ type: 'browser', filePath: 'plan.html' });
    });

    it.skipIf(process.platform !== 'win32')('normalizes a WSL Session file URL to the same target as --file', async () => {
      const orchestrator: Session = { ...session, id: '__orchestration_session_wsl', isHidden: true, worktreePath: worktree };
      const services = openServices(orchestrator, false);
      // SAFETY: File resolution only reads the owning Session's runtime metadata.
      services.orchestrationSessionManager = {
        sessionIdForPane: async () => 'wsl-session',
        get: async () => ({ runtime: 'wsl', wslDistribution: 'Ubuntu-24.04' }),
      } as never;
      const registry = createRegistry(services);
      const linuxPath = `/mnt/${worktree[0].toLowerCase()}${worktree.slice(2).replaceAll('\\', '/')}/plan.html`;
      const result = await registry.invoke('runpane:panels:open', [{ paneId: orchestrator.id, url: `file://${linuxPath}?mode=preview#heading` }]);
      expect(result).toMatchObject({ url: `${pathToFileURL(path.join(worktree, 'plan.html')).href}?mode=preview#heading` });
    });

    it.skipIf(process.platform !== 'win32').each([
      ['file:///home/me/Preview%20%23%25.html?view=1#section', 'file://wsl.localhost/Ubuntu/home/me/Preview%20%23%25.html?view=1#section'],
      ['file://wsl$/Ubuntu/home/me/index.html', 'file://wsl.localhost/Ubuntu/home/me/index.html'],
      ['file:///C:/repo/index.html', 'file:///C:/repo/index.html'],
      ['file://wsl.localhost/Other/home/me/index.html', 'file://wsl.localhost/Other/home/me/index.html'],
    ])('opens WSL project URL %s', async (url, expected) => {
      const services = openServices({ ...session, worktreePath: '/home/me' });
      // SAFETY: Browser resolution reads only pathResolver.
      vi.mocked(services.sessionManager.getProjectContext).mockReturnValue({
        pathResolver: new PathResolver({ path: '/home/me', wsl_enabled: true, wsl_distribution: 'Ubuntu' }),
      } as never);
      const registry = createRegistry(services);
      expect(await registry.invoke('runpane:panels:open', [{ paneId: session.id, url }])).toMatchObject({ url: expected });
    });

    it('preserves native file URLs without project context', async () => {
      const registry = createRegistry(openServices({ ...session, worktreePath: worktree }, false));
      const url = pathToFileURL(path.join(worktree, 'plan.html')).href;
      expect(await registry.invoke('runpane:panels:open', [{ paneId: session.id, url }])).toMatchObject({ url });
    });

    it.skipIf(process.platform !== 'win32' || !process.env.PANE_TEST_WSL_DISTRO)('opens real WSL files and preserves containment', async () => {
      const distro = process.env.PANE_TEST_WSL_DISTRO!;
      const linuxRoot = `/tmp/pane-browser-${Date.now()}`;
      const resolver = new PathResolver({ path: linuxRoot, wsl_enabled: true, wsl_distribution: distro });
      const hostRoot = resolver.toFileSystem(linuxRoot);
      fs.mkdirSync(hostRoot);
      try {
        fs.writeFileSync(path.join(hostRoot, 'plan #%.html'), '<h1>WSL plan</h1>');
        const services = openServices({ ...session, worktreePath: linuxRoot });
        // SAFETY: Browser resolution reads only pathResolver.
        vi.mocked(services.sessionManager.getProjectContext).mockReturnValue({ pathResolver: resolver } as never);
        const registry = createRegistry(services);
        const url = pathToFileURL(path.join(hostRoot, 'plan #%.html')).href;
        for (const filePath of ['plan #%.html', `${linuxRoot}/plan #%.html`, path.join(hostRoot, 'plan #%.html'), path.join(hostRoot, 'plan #%.html').replace('wsl.localhost', 'wsl$')]) {
          expect(await registry.invoke('runpane:panels:open', [{ paneId: session.id, filePath }])).toMatchObject({ url, filePath: 'plan #%.html' });
        }
        await expect(registry.invoke('runpane:panels:open', [{ paneId: session.id, filePath: '/etc/passwd' }])).rejects.toThrow('inside the Pane worktree');
        const mounted = `/mnt/${worktree[0].toLowerCase()}${worktree.slice(2).replaceAll('\\', '/')}`;
        const mountedServices = openServices({ ...session, worktreePath: mounted });
        // SAFETY: Browser resolution reads only pathResolver.
        vi.mocked(mountedServices.sessionManager.getProjectContext).mockReturnValue({ pathResolver: resolver } as never);
        const mountedRegistry = createRegistry(mountedServices);
        const fromWindows = await mountedRegistry.invoke('runpane:panels:open', [{ paneId: session.id, filePath: path.join(worktree, 'plan.html') }]);
        const fromLinux = await mountedRegistry.invoke('runpane:panels:open', [{ paneId: session.id, filePath: `${mounted}/plan.html` }]);
        expect(fromWindows).toEqual(fromLinux);
      } finally {
        fs.rmSync(hostRoot, { recursive: true, force: true });
      }
    });

    it('rejects paths outside the worktree, missing files, and unsupported URL schemes', async () => {
      const registry = createRegistry(openServices({ ...session, worktreePath: worktree }));

      await expect(registry.invoke('runpane:panels:open', [{ paneId: session.id, filePath: '../escape.html' }]))
        .rejects.toThrow('inside the Pane worktree');
      await expect(registry.invoke('runpane:panels:open', [{ paneId: session.id, filePath: 'missing.html' }]))
        .rejects.toThrow('File not found');
      await expect(registry.invoke('runpane:panels:open', [{ paneId: session.id, url: 'javascript:alert(1)' }]))
        .rejects.toThrow('Unsupported URL scheme');
      await expect(registry.invoke('runpane:panels:open', [{ paneId: session.id, url: 'https://a.test', filePath: 'plan.html' }]))
        .rejects.toThrow('exactly one of url or filePath');
      expect(panelManager.createPanel).not.toHaveBeenCalled();
    });
  });
});
