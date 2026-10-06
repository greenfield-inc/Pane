import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nativeTheme, type IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../database/models';
import type { AppServices } from './types';
import type { AppConfig, UpdateConfigRequest } from '../types/config';
import {
  ensureProjectAgentContext,
  PANE_AGENT_CONTEXT_START,
} from '../services/agentContextManager';
import { registerConfigHandlers } from './config';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import { AppearanceValidationError, normalizeAppearance } from '../../../shared/types/appearance';
import { applyNativeThemeSource } from '../services/appearanceService';
import { ConfigManager } from '../services/configManager';

interface TestIpcEvent { readonly sender?: { readonly id?: number } }
type IpcHandler = (_event: TestIpcEvent, ...args: PaneCommandValue[]) => PaneCommandValue | Promise<PaneCommandValue>;

interface IpcMainStub {
  handlers: Map<string, IpcHandler>;
  handle(channel: string, listener: IpcHandler): void;
}

const tempDirs: string[] = [];

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

async function createTempProject(id: number): Promise<Project> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-config-agent-context-'));
  tempDirs.push(projectPath);
  return {
    id,
    name: `Project ${id}`,
    path: projectPath,
    active: id === 1,
    created_at: '',
    updated_at: '',
  };
}

async function createTempConfigManager(): Promise<ConfigManager> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-config-ipc-'));
  tempDirs.push(configDir);
  const previousPaneDir = process.env.PANE_DIR;
  try {
    process.env.PANE_DIR = configDir;
    return new ConfigManager();
  } finally {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
  }
}

function createServicesStub(projects: Project[]): AppServices {
  // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
  let config = { agentContext: { managedAgentsMd: true } } as AppConfig;

  // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
  return {
    app: {},
    sessionManager: {
      getActiveProject: () => projects[0] ?? null,
    },
    gitStatusManager: {},
    configManager: {
      getConfig: () => config,
      reloadFromDisk: async () => config,
      updateConfig: async (updates: UpdateConfigRequest) => {
        config = {
          ...config,
          ...updates,
          agentContext: updates.agentContext
            ? { ...config.agentContext, ...updates.agentContext }
            : config.agentContext,
        };
        return config;
      },
      getSessionCreationPreferences: () => config.sessionCreationPreferences,
    },
    databaseService: {
      getAllProjects: () => projects,
    },
    worktreeManager: {},
    gitDiffManager: {},
    analyticsManager: {},
    taskQueue: {},
    cliManagerFactory: {},
    claudeCodeManager: {
      clearAvailabilityCache: () => undefined,
    },
    worktreeNameGenerator: {},
    archiveProgressManager: {},
    spotlightManager: {},
    runCommandManager: {},
    getMainWindow: () => null,
  } as AppServices;
}

describe('config IPC handlers', () => {
  it.each([
    { platform: 'darwin', agents: ['claude', 'codex', 'cursor'] },
    { platform: 'linux', agents: ['claude', 'codex', 'cursor'] },
    { platform: 'win32', agents: ['claude', 'codex'] },
  ])('keeps terminal-only OpenCode out of remote Session agents on $platform', async ({ platform, agents }) => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    try {
      const ipcMain = createIpcMainStub();
      const registry = new PaneCommandRegistry();
      // SAFETY: The stub implements the IpcMain handle surface exercised by registerConfigHandlers.
      registerConfigHandlers(ipcMain as IpcMain, createServicesStub([]), registry);
      await expect(registry.invoke('remote:pwa-affordances')).resolves.toMatchObject({
        sessionAgents: { agents, defaultAgent: 'claude' },
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('removes Pane AGENTS.md blocks when publishing is turned off', async () => {
    const activeProject = await createTempProject(1);
    const inactiveProject = await createTempProject(2);
    const activeAgentsPath = path.join(activeProject.path, 'AGENTS.md');
    const inactiveAgentsPath = path.join(inactiveProject.path, 'AGENTS.md');

    await fs.writeFile(activeAgentsPath, '# Repo Rules\n\nKeep this line.\n', 'utf8');
    await ensureProjectAgentContext(activeProject, { agentContext: { managedAgentsMd: true } });
    await ensureProjectAgentContext(inactiveProject, { agentContext: { managedAgentsMd: true } });

    const ipcMain = createIpcMainStub();
    registerConfigHandlers(
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      ipcMain as IpcMain,
      createServicesStub([activeProject, inactiveProject]),
    );

    const updateConfig = ipcMain.handlers.get('config:update');
    expect(updateConfig).toBeDefined();

    await expect(updateConfig?.({}, { agentContext: { managedAgentsMd: false } })).resolves.toEqual({
      success: true,
      data: { agentContext: { managedAgentsMd: false, cleanupPending: false } },
    });

    const activeContent = await fs.readFile(activeAgentsPath, 'utf8');
    const inactiveContent = await fs.readFile(inactiveAgentsPath, 'utf8');
    expect(activeContent).toContain('Keep this line.');
    expect(activeContent).not.toContain(PANE_AGENT_CONTEXT_START);
    expect(inactiveContent).not.toContain(PANE_AGENT_CONTEXT_START);
  });

  it('returns the specific appearance validation error envelope', async () => {
    const ipcMain = createIpcMainStub();
    const services = createServicesStub([]);
    services.configManager.updateConfig = async () => {
      throw new AppearanceValidationError('systemLightTheme must be a light palette');
    };
    // SAFETY: The stub implements the IpcMain handle surface exercised by registerConfigHandlers.
    registerConfigHandlers(ipcMain as IpcMain, services);
    await expect(ipcMain.handlers.get('config:update')?.({}, { systemLightTheme: 'dark' })).resolves.toEqual({
      success: false,
      error: 'systemLightTheme must be a light palette',
    });
  });

  it('applies the native theme source after a successful appearance update', async () => {
    nativeTheme.themeSource = 'system';
    const ipcMain = createIpcMainStub();
    const configManager = await createTempConfigManager();
    await configManager.initialize();
    let configUpdatedCount = 0;
    configManager.on('config-updated', (updated: AppConfig) => {
      configUpdatedCount += 1;
      applyNativeThemeSource(normalizeAppearance(updated).appearance);
    });
    const services = createServicesStub([]);
    services.configManager = configManager;
    registerConfigHandlers(
      // SAFETY: The stub implements the IpcMain handle surface exercised by registerConfigHandlers.
      ipcMain as IpcMain,
      services,
    );

    await expect(ipcMain.handlers.get('config:update')?.({}, {
      appearanceMode: 'fixed',
      theme: 'forge',
    })).resolves.toMatchObject({ success: true });
    expect(configUpdatedCount).toBe(1);
    expect(nativeTheme.themeSource).toBe('dark');
  });

  describe('remote:settings:update', () => {
    async function registerRemoteSettings() {
      const configManager = await createTempConfigManager();
      await configManager.initialize();
      const services = createServicesStub([]);
      services.configManager = configManager;
      const registry = new PaneCommandRegistry();
      // SAFETY: The stub implements the IpcMain handle surface exercised by registerConfigHandlers.
      registerConfigHandlers(createIpcMainStub() as IpcMain, services, registry);
      return { configManager, registry };
    }

    const screenshotShortcut = {
      id: 'screenshot',
      label: 'Screenshot attached',
      key: 'a',
      text: 'Look at the screenshot I just attached.',
      enabled: true,
    };

    it('replaces the shortcut list, and the next read from any client returns it', async () => {
      const { registry } = await registerRemoteSettings();

      const result = await registry.invokeRemote('remote:settings:update', [{ terminalShortcuts: [screenshotShortcut] }]);

      // SAFETY: remote:settings:update returns the refreshed affordances.
      expect((result as RemotePwaAffordances).terminalShortcuts).toEqual([screenshotShortcut]);
      // SAFETY: remote:pwa-affordances returns RemotePwaAffordances.
      const reread = await registry.invoke('remote:pwa-affordances') as RemotePwaAffordances;
      expect(reread.terminalShortcuts).toEqual([screenshotShortcut]);
    });

    it('saves a voice key, reports it only as configured, and never returns it', async () => {
      const { configManager, registry } = await registerRemoteSettings();
      const key = 'dg-secret-0123456789';

      const result = await registry.invokeRemote('remote:settings:update', [{ deepgramApiKey: key }]);

      expect(configManager.getConfig().deepgramApiKey).toBe(key);
      // SAFETY: remote:settings:update returns the refreshed affordances.
      expect((result as RemotePwaAffordances).voiceTranscription.configured.deepgram).toBe(true);
      expect(JSON.stringify(result)).not.toContain(key);
    });

    it('offers live dictation with only a Deepgram key, and recorded with only a fal key', async () => {
      vi.stubEnv('OPENROUTER_API_KEY', '');
      vi.stubEnv('DEEPGRAM_API_KEY', '');
      vi.stubEnv('FAL_KEY', '');
      const { registry } = await registerRemoteSettings();

      // SAFETY: remote:settings:update returns the refreshed affordances.
      const live = await registry.invokeRemote('remote:settings:update', [{ deepgramApiKey: 'dg-key-1' }]) as RemotePwaAffordances;
      expect(live.voiceTranscription.availableModes).toEqual(['streaming']);
      // SAFETY: remote:settings:update returns the refreshed affordances.
      const both = await registry.invokeRemote('remote:settings:update', [{ falApiKey: 'fal-key-1' }]) as RemotePwaAffordances;
      expect(both.voiceTranscription.availableModes).toEqual(['streaming', 'recorded']);
      expect(both.voiceTranscription.configured.cleanup).toBe(false);
    });

    it('leaves fields the patch omits as they were', async () => {
      const { configManager, registry } = await registerRemoteSettings();
      await registry.invokeRemote('remote:settings:update', [{ openRouterApiKey: 'or-key-1' }]);

      await registry.invokeRemote('remote:settings:update', [{ terminalShortcuts: [screenshotShortcut] }]);

      expect(configManager.getConfig().openRouterApiKey).toBe('or-key-1');
    });

    it('refuses a patch with any other config field and writes nothing', async () => {
      const { configManager, registry } = await registerRemoteSettings();

      await expect(registry.invokeRemote('remote:settings:update', [{
        terminalShortcuts: [screenshotShortcut],
        claudeExecutablePath: '/tmp/not-claude',
      }])).rejects.toThrow(/claudeExecutablePath/);

      expect(configManager.getConfig().claudeExecutablePath).toBeUndefined();
      expect(configManager.getConfig().terminalShortcuts).not.toEqual([screenshotShortcut]);
    });

    it('refuses shortcuts desktop could not bind: a hotkey that is not one letter, or two enabled on one letter', async () => {
      const { configManager, registry } = await registerRemoteSettings();
      const before = configManager.getConfig().terminalShortcuts;

      await expect(registry.invokeRemote('remote:settings:update', [{
        terminalShortcuts: [{ ...screenshotShortcut, key: 'ab' }],
      }])).rejects.toThrow(/key/);
      await expect(registry.invokeRemote('remote:settings:update', [{
        terminalShortcuts: [screenshotShortcut, { ...screenshotShortcut, id: 'other' }],
      }])).rejects.toThrow(/letter a/);

      expect(configManager.getConfig().terminalShortcuts).toEqual(before);
    });

    describe('change event', () => {
      const sent = vi.fn();
      afterEach(() => {
        sent.mockReset();
        resetPaneRuntimeForTests();
      });
      function captureEvents() {
        setPaneRuntime({
          eventSink: { send: sent },
          getConfigManager: () => { throw new Error('unused'); },
          getPtyHostRuntime: () => null,
          getWebviewContextMap: () => new Map(),
        });
      }

      it('tells every client to refetch after a phone saves, without the values', async () => {
        const { registry } = await registerRemoteSettings();
        captureEvents();

        await registry.invokeRemote('remote:settings:update', [{ falApiKey: 'fal-key-1' }]);

        expect(sent).toHaveBeenCalledWith('remote:settings-changed');
      });

      it('tells phones to refetch after desktop saves its settings', async () => {
        const ipcMain = createIpcMainStub();
        // SAFETY: The stub implements the IpcMain handle surface exercised by registerConfigHandlers.
        registerConfigHandlers(ipcMain as IpcMain, createServicesStub([]));
        captureEvents();

        await ipcMain.handlers.get('config:update')?.({}, { terminalShortcuts: [screenshotShortcut] });

        expect(sent).toHaveBeenCalledWith('remote:settings-changed');
      });
    });
  });
});
