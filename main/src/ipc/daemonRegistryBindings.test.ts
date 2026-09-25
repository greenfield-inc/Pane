import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { registerFileHandlers } from './file';
import { registerConfigHandlers } from './config';
import { registerGitHandlers } from './git';
import { registerPanelHandlers } from './panels';
import { registerPaneChatHandlers } from './paneChat';
import { registerOrchestrationSessionHandlers } from './orchestrationSessions';
import { registerPermissionHandlers } from './permissions';
import { registerProjectHandlers } from './project';
import { registerPromptHandlers } from './prompt';
import { registerScriptHandlers } from './script';
import { registerSessionHandlers } from './session';
import { registerVoiceHandlers } from './voice';
import { registerUsageHandlers } from './usage';
import type { AppServices } from './types';

const USAGE_CHANNELS = [
  'usage:get-report',
  'usage:get-status',
  'usage:rescan',
] as const;
const PROJECT_CHANNELS = [
  'projects:get-all',
  'projects:get-active',
  'projects:create',
  'projects:activate',
  'projects:update',
  'projects:delete',
  'projects:reorder',
  'projects:detect-branch',
  'projects:list-branches',
  'projects:refresh-git-status',
  'projects:get-running-script',
  'projects:stop-script',
  'projects:detect-config',
  'projects:resolve-run-script',
  'projects:run-script',
] as const;

const CONFIG_CHANNELS = [
  'remote:pwa-affordances',
] as const;

const VOICE_CHANNELS = [
  'voice:transcribe',
  'voice:deepgram-token',
  'voice:finalize-streaming',
] as const;

const PROMPT_CHANNELS = [
  'sessions:get-prompts',
  'prompts:get-all',
  'prompts:get-by-id',
] as const;

const PANE_CHAT_CHANNELS = [
  'pane-chat:get-or-create',
  'pane-chat:set-agent',
] as const;
const ORCHESTRATION_SESSION_CHANNELS = [
  'orchestration-sessions:progress',
  'orchestration-sessions:promote',
  'orchestration-sessions:list',
  'orchestration-sessions:select',
  'orchestration-sessions:create',
  'orchestration-sessions:get',
  'orchestration-sessions:update',
  'orchestration-sessions:set-agent',
  'orchestration-sessions:associate',
  'orchestration-sessions:detach',
  'orchestration-sessions:overview',
] as const;

const PERMISSION_CHANNELS = [
  'permission:getPending',
  'permission:respond',
] as const;

const FILE_CHANNELS = [
  'file:read',
  'file:read-binary',
  'file:exists',
  'file:write',
  'file:write-binary',
  'file:getPath',
  'git:commit',
  'git:revert',
  'git:restore',
  'file:readAtRevision',
  'file:list',
  'file:delete',
  'file:rename',
  'file:move',
  'file:copy',
  'file:duplicate',
  'file:search',
  'file:read-project',
  'file:write-project',
  'git:execute-project',
  'file:resolveAbsolutePath',
] as const;

const PANEL_CHANNELS = [
  'panels:create',
  'panels:delete',
  'panels:update',
  'panels:list',
  'panels:set-active',
  'panels:getActive',
  'panels:initialize',
  'panels:agent-statuses',
  'panels:checkInitialized',
  'panels:emitEvent',
  'panels:resize-terminal',
  'panels:send-terminal-input',
  'panels:shouldAutoCreate',
  'panels:get-layout',
  'panels:set-layout',
  'terminal:input',
  'terminal:resize',
  'terminal:getState',
  'terminal:saveState',
  'terminal:saveSnapshot',
  'terminal:clearScrollback',
  'terminal:setVisibility',
  'terminal:ack',
  'terminal:resetFlowControl',
  'terminal:getAltScreenState',
  'terminal:getScrollbackClean',
  'terminal:paste-image',
  'terminal:save-scrollback',
  'terminal:paste-file',
] as const;

const SCRIPT_CHANNELS = [
  'sessions:has-run-script',
  'sessions:get-running-session',
  'sessions:run-script',
  'sessions:stop-script',
  'sessions:run-terminal-command',
  'sessions:send-terminal-input',
  'sessions:pre-create-terminal',
  'sessions:resize-terminal',
  'logs:runScript',
  'logs:stopScript',
  'logs:isRunning',
] as const;

const SESSION_CHANNELS = [
  'sessions:get-all',
  'sessions:get',
  'sessions:get-all-with-projects',
  'sessions:get-archived-with-projects',
  'sessions:create',
  'sessions:delete',
  'sessions:permanent-delete',
  'sessions:permanent-delete-archived',
  'sessions:input',
  'sessions:get-or-create-main-repo',
  'sessions:continue',
  'sessions:get-output',
  'sessions:get-conversation',
  'sessions:get-conversation-messages',
  'sessions:get-conversation-message-count',
  'sessions:generate-compacted-context',
  'sessions:get-json-messages',
  'sessions:mark-viewed',
  'sessions:stop',
  'sessions:generate-name',
  'sessions:rename',
  'sessions:toggle-favorite',
  'sessions:reorder',
  'sessions:save-images',
  'sessions:save-large-text',
  'sessions:restore',
  'sessions:get-statistics',
  'sessions:get-resumable',
  'sessions:resume-interrupted',
  'sessions:dismiss-interrupted',
  'panels:get-output',
  'panels:get-conversation-messages',
  'panels:get-json-messages',
  'panels:get-prompts',
  'panels:send-input',
  'panels:continue',
] as const;

const GIT_STATUS_CHANNELS = [
  'sessions:get-executions',
  'sessions:get-execution-diff',
  'sessions:get-git-graph',
  'git:file-status',
  'sessions:git-diff',
  'sessions:get-diff-manifest',
  'sessions:get-file-diff',
  'sessions:check-rebase-conflicts',
  'sessions:has-stash',
  'sessions:get-upstream',
  'sessions:get-remote-branches',
  'sessions:get-last-commits',
  'sessions:has-changes-to-rebase',
  'sessions:get-git-commands',
  'sessions:get-git-status',
  'git:cancel-status-for-project',
  'git:get-github-remote',
] as const;

const GIT_MUTATION_CHANNELS = [
  'sessions:git-commit',
  'sessions:rebase-main-into-worktree',
  'sessions:abort-rebase-and-use-claude',
  'sessions:squash-and-rebase-to-main',
  'sessions:rebase-to-main',
  'sessions:git-pull',
  'sessions:git-push',
  'sessions:git-soft-reset',
  'sessions:git-fetch',
  'sessions:git-stash',
  'sessions:git-stash-pop',
  'sessions:set-upstream',
  'sessions:git-stage-and-commit',
  'git:clone-repo',
] as const;

const GIT_CHANNELS = [
  ...GIT_STATUS_CHANNELS,
  ...GIT_MUTATION_CHANNELS,
] as const;

interface TestIpcEvent { readonly sender?: { readonly id?: number } }
type TestIpcHandler = (_event: TestIpcEvent, ...args: PaneCommandValue[]) => PaneCommandValue | Promise<PaneCommandValue>;

interface IpcMainStub {
  boundChannels: string[];
  listeners: Map<string, TestIpcHandler>;
  handle(channel: string, listener: TestIpcHandler): void;
}

function createIpcMainStub(): IpcMainStub {
  const boundChannels: string[] = [];
  const listeners = new Map<string, TestIpcHandler>();

  return {
    boundChannels,
    listeners,
    handle(channel: string, listener: TestIpcHandler) {
      boundChannels.push(channel);
      listeners.set(channel, listener);
    },
  };
}

function createServicesStub(overrides: Partial<AppServices> = {}): AppServices {
  // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
  return {
    sessionManager: {},
    gitStatusManager: {},
    configManager: {},
    databaseService: {},
    worktreeManager: {},
    gitDiffManager: {},
    analyticsManager: {},
    taskQueue: {},
    cliManagerFactory: {},
    claudeCodeManager: {},
    worktreeNameGenerator: {},
    archiveProgressManager: {},
    spotlightManager: {},
    runCommandManager: {},
    ...overrides,
  } as AppServices;
}

describe('daemon registry IPC bindings', () => {
  it('binds daemon-owned project channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerProjectHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PROJECT_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...PROJECT_CHANNELS].sort());
  });

  it('binds remote-safe config affordances through the shared registry', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerConfigHandlers(ipcMain, createServicesStub({
      configManager: {
        getConfig: () => ({
          anthropicApiKey: 'secret-api-key',
          terminalShortcuts: [{
            id: 'shortcut-1',
            label: 'Review',
            key: 'r',
            text: 'review this',
            enabled: true,
          }],
          customCommands: [{ name: 'Codex Fast', command: 'codex --yolo' }],
        }),
      },
    } as Partial<AppServices>), registry);

    expect(registry.listChannels()).toEqual([...CONFIG_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('config:get');
    expect(ipcMain.boundChannels.filter(channel => channel !== 'config:get' && !channel.startsWith('config:')).sort()).toEqual(
      [...CONFIG_CHANNELS].sort(),
    );
    await expect(registry.invoke('remote:pwa-affordances')).resolves.toEqual({
      terminalShortcuts: [{
        id: 'shortcut-1',
        label: 'Review',
        key: 'r',
        text: 'review this',
        enabled: true,
      }],
      customCommands: [{ name: 'Codex Fast', command: 'codex --yolo' }],
      voiceTranscription: {
        availableModes: [],
        defaultMode: 'streaming',
        configured: {
          cleanup: false,
          recorded: false,
          streaming: false,
          fal: false,
          deepgram: false,
          openRouter: false,
        },
        modes: {
          streaming: {
            label: 'Live',
            priceLabel: '~$0.462/hr ASR + cleanup',
            latencyLabel: 'Realtime text while speaking',
            recommended: true,
          },
          recorded: {
            label: 'Batch',
            priceLabel: '~$0.084/hr full pipeline',
            latencyLabel: 'Text appears after stop',
            recommended: false,
          },
        },
      },
    });
  });

  it('binds daemon-owned voice channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerVoiceHandlers(ipcMain, createServicesStub({
      configManager: {
        getConfig: () => ({}),
      },
    } as Partial<AppServices>), registry);

    expect(registry.listChannels()).toEqual([...VOICE_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...VOICE_CHANNELS].sort());
  });

  it('binds daemon-owned usage channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerUsageHandlers(ipcMain, registry);

    expect(registry.listChannels()).toEqual([...USAGE_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...USAGE_CHANNELS].sort());
  });

  it('binds daemon-owned prompt channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerPromptHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PROMPT_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...PROMPT_CHANNELS].sort());
  });

  it('binds daemon-owned Pane Chat channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerPaneChatHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PANE_CHAT_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...PANE_CHAT_CHANNELS].sort());
  });

  it('binds daemon-owned orchestration Session channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerOrchestrationSessionHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...ORCHESTRATION_SESSION_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...ORCHESTRATION_SESSION_CHANNELS].sort());
  });

  it('binds daemon-owned permission channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerPermissionHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PERMISSION_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...PERMISSION_CHANNELS].sort());
  });

  it('keeps file manager shell adapters outside the daemon registry surface', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerFileHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...FILE_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('file:showInFolder');
    expect(ipcMain.boundChannels.filter(channel => channel !== 'file:showInFolder').sort()).toEqual(
      [...FILE_CHANNELS].sort(),
    );
    expect(registry.has('file:showInFolder')).toBe(false);
  });

  it('returns a file URL for a path inside the session worktree', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();
    const worktreePath = path.join(process.cwd(), 'Pane Preview');
    const filePath = path.join(worktreePath, 'index.html');

    // SAFETY: This test fixture supplies the session and path resolver used by file:getPath.
    registerFileHandlers(ipcMain, createServicesStub({
      sessionManager: {
        getSession: () => ({ worktreePath }),
        getProjectContext: () => ({
          pathResolver: {
            toFileSystem: (value: string) => value,
            isWithin: async () => true,
          },
        }),
      },
    } as Partial<AppServices>), registry);

    await expect(registry.invoke('file:getPath', [{
      sessionId: 'session-1',
      filePath: 'index.html',
    }])).resolves.toEqual({
      success: true,
      path: filePath,
      url: pathToFileURL(filePath).href,
    });
  });

  it('keeps browser and clipboard panel adapters outside the daemon registry surface', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerPanelHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PANEL_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('terminal:clipboard-paste-image');
    expect(ipcMain.boundChannels).toContain('browser-panel:register-webview');
    expect(
      ipcMain.boundChannels.filter(
        channel => channel !== 'terminal:clipboard-paste-image' && channel !== 'browser-panel:register-webview',
      ).sort(),
    ).toEqual([...PANEL_CHANNELS].sort());
    expect(registry.has('terminal:clipboard-paste-image')).toBe(false);
  });

  it('keeps local IDE launching outside the daemon registry surface', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerScriptHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...SCRIPT_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('sessions:open-ide');
    expect(ipcMain.boundChannels.filter(channel => channel !== 'sessions:open-ide').sort()).toEqual(
      [...SCRIPT_CHANNELS].sort(),
    );
    expect(registry.has('sessions:open-ide')).toBe(false);
  });

  it('routes active-session polling hints through the remote daemon bridge when active', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();
    const setActiveSession = vi.fn();
    const remoteInvoke = vi
      .spyOn(remotePaneClientController, 'invoke')
      .mockImplementation((_channel, _args, invokeLocal) => invokeLocal());

    registerSessionHandlers(
      ipcMain,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      createServicesStub({ gitStatusManager: { setActiveSession } } as Partial<AppServices>),
      registry,
    );

    const listener = ipcMain.listeners.get('sessions:set-active-session');
    expect(listener).toBeDefined();
    await listener?.({}, 'session-1');

    expect(remoteInvoke).toHaveBeenCalledWith(
      'sessions:set-active-session',
      ['session-1'],
      expect.any(Function),
    );
    expect(setActiveSession).toHaveBeenCalledWith('session-1');

    expect(registry.listChannels()).toEqual([...SESSION_CHANNELS, 'sessions:set-active-session'].sort());
    expect(ipcMain.boundChannels).toContain('sessions:set-active-session');
    expect(ipcMain.boundChannels).toContain('debug:get-table-structure');
    expect(ipcMain.boundChannels).toContain('archive:get-progress');
    expect(
      ipcMain.boundChannels.filter(
        channel =>
          channel !== 'sessions:set-active-session' &&
          channel !== 'debug:get-table-structure' &&
          channel !== 'archive:get-progress',
      ).sort(),
    ).toEqual([...SESSION_CHANNELS].sort());
    expect(registry.has('sessions:set-active-session')).toBe(true);
  });

  it('routes all daemon-owned git handlers through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerGitHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...GIT_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...GIT_CHANNELS].sort());
    expect(registry.has('git:clone-repo')).toBe(true);
  });

  it('rejects commit messages without a title at the git IPC boundary', async () => {
    const registry = new PaneCommandRegistry();
    registerGitHandlers(createIpcMainStub(), createServicesStub(), registry);
    registerFileHandlers(createIpcMainStub(), createServicesStub(), registry);

    await expect(registry.invoke(
      'sessions:git-stage-and-commit',
      ['session-1', '  \n\nDescription only'],
    )).resolves.toEqual({ success: false, error: 'Commit title is required' });
    await expect(registry.invoke(
      'sessions:squash-and-rebase-to-main',
      ['session-1', ''],
    )).resolves.toEqual({ success: false, error: 'Commit title is required' });
    await expect(registry.invoke(
      'git:commit',
      [{ sessionId: 'session-1', message: '\n\nDescription only' }],
    )).resolves.toEqual({ success: false, error: 'Commit title is required' });
  });
});
