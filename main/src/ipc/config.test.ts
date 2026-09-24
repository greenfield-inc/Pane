import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nativeTheme, type IpcMain } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../database/models';
import type { AppServices } from './types';
import type { AppConfig, UpdateConfigRequest } from '../types/config';
import {
  PANE_AGENT_CONTEXT_START,
} from '../services/agentContextManager';
import { registerConfigHandlers } from './config';
import type { PaneCommandValue } from '../daemon/commandRegistry';
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
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('removes managed AGENTS blocks from all saved projects when disabled', async () => {
    const activeProject = await createTempProject(1);
    const inactiveProject = await createTempProject(2);
    const activeAgentsPath = path.join(activeProject.path, 'AGENTS.md');
    const inactiveAgentsPath = path.join(inactiveProject.path, 'AGENTS.md');

    await fs.writeFile(activeAgentsPath, '# Repo Rules\n\nKeep this line.\n', 'utf8');
    const block = `${PANE_AGENT_CONTEXT_START}\nOld generated text\n<!-- pane-agent-context:end -->\n`;
    await fs.appendFile(activeAgentsPath, block);
    await fs.writeFile(inactiveAgentsPath, block);

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
      data: { agentContext: { managedAgentsMd: false } },
    });

    const activeContent = await fs.readFile(activeAgentsPath, 'utf8');
    const inactiveContent = await fs.readFile(inactiveAgentsPath, 'utf8');
    expect(activeContent).toContain('Keep this line.');
    expect(activeContent).not.toContain(PANE_AGENT_CONTEXT_START);
    expect(inactiveContent).toBe('');
    await expect(fs.access(inactiveAgentsPath)).resolves.toBeUndefined();
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
});
