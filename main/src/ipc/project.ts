import type { IpcMain } from 'electron';
import { mkdir, access } from 'fs/promises';
import path from 'path';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { CreateProjectRequest, UpdateProjectRequest } from '../../../frontend/src/types/project';
import { scriptExecutionTracker } from '../services/scriptExecutionTracker';
import { panelManager } from '../services/panelManager';
import { parseWSLPath, validateWSLAvailable } from '../utils/wslUtils';
import { PathResolver, expandUserRepoPath } from '../utils/pathResolver';
import { CommandRunner } from '../utils/commandRunner';
import { detectProjectBranch } from '../utils/detectProjectBranch';
import { getGitAttributionEnv } from '../utils/attribution';
import { detectProjectConfig } from '../services/projectConfigDetector';
import { ensureProjectAgentContext } from '../services/agentContextManager';
import type { ConfigManager } from '../services/configManager';
import type { Project } from '../database/models';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { createRequire } from 'node:module';

const loadProjectDependency = createRequire(__filename);

// Helper function to stop a running project script
async function stopProjectScriptInternal(projectId?: number): Promise<{ success: boolean; error?: string }> {
  try {
    const runningScript = scriptExecutionTracker.getRunningScript();

    // If a specific project ID is provided, only stop if it matches the running project
    if (projectId !== undefined && runningScript?.type === 'project' && runningScript?.id !== projectId) {
      return { success: true }; // Not running, nothing to stop
    }

    // If there's a running project script, stop it
    if (runningScript && runningScript.type === 'project' && runningScript.sessionId) {
      const projectIdToStop = decodeBoundary(runningScript.id, boundary.number);

      // Mark as closing
      scriptExecutionTracker.markClosing('project', projectIdToStop);

      const { logsManager } = loadProjectDependency('../services/panels/logPanel/logsManager');

      const panels = await panelManager.getPanelsForSession(runningScript.sessionId);
      const logsPanel = panels?.find((p: { type: string }) => p.type === 'logs');
      if (logsPanel) {
        await logsManager.stopScript(logsPanel.id);
      }

      // Mark as stopped
      scriptExecutionTracker.stop('project', projectIdToStop);

      console.log(`[Main] Stopped project script for project ${projectIdToStop}`);
    }

    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to stop project script:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to stop project script' };
  }
}

const DAEMON_PROJECT_CHANNELS = [
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

export function registerProjectHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { databaseService, sessionManager, worktreeManager, analyticsManager, configManager } = services;

  commandRegistry.register('projects:get-all', async () => {
    try {
      const projects = databaseService.getAllProjects();
      const projectsWithEnv = projects.map(p => ({
        ...p,
        environment: new PathResolver(p).environment
      }));
      return { success: true, data: projectsWithEnv };
    } catch (error) {
      console.error('Failed to get projects:', error);
      return { success: false, error: 'Failed to get projects' };
    }
  });

  commandRegistry.register('projects:get-active', async () => {
    try {
      const activeProject = sessionManager.getActiveProject();
      const projectWithEnv = activeProject ? {
        ...activeProject,
        environment: new PathResolver(activeProject).environment
      } : null;
      return { success: true, data: projectWithEnv };
    } catch (error) {
      console.error('Failed to get active project:', error);
      return { success: false, error: 'Failed to get active project' };
    }
  });

  commandRegistry.register('projects:create', async (projectData: CreateProjectRequest) => {
    try {
      console.log('[Main] Creating project:', projectData);

      const requestedPath = expandUserRepoPath(projectData.path);

      // Parse WSL path if applicable
      const wslInfo = parseWSLPath(requestedPath);
      let actualPath = requestedPath;
      let wslEnabled = false;
      let wslDistribution: string | null = null;
      let isGitRepo = false;

      if (wslInfo) {
        const wslError = validateWSLAvailable(wslInfo.distro);
        if (wslError) {
          return { success: false, error: wslError };
        }
        wslEnabled = true;
        wslDistribution = wslInfo.distro;
        actualPath = wslInfo.linuxPath;
        console.log(`[Main] WSL project detected: ${wslInfo.distro}:${wslInfo.linuxPath}`);
      }

      // Create CommandRunner and PathResolver — handles WSL/non-WSL transparently
      const tempProject = {
        path: actualPath,
        wsl_enabled: wslEnabled,
        wsl_distribution: wslDistribution
      };
      const pathResolver = new PathResolver(tempProject);
      const commandRunner = new CommandRunner(tempProject);

      // Create directory if needed (recursive: true is a no-op if it already exists)
      await mkdir(pathResolver.toFileSystem(actualPath), { recursive: true });
      console.log('[Main] Ensured project directory exists');

      // Check if it's a git repository
      try {
        await commandRunner.execAsync('git rev-parse --is-inside-work-tree', actualPath, { silent: true });
        isGitRepo = true;
        console.log('[Main] Directory is already a git repository');
      } catch {
        console.log('[Main] Directory is not a git repository, initializing...');
      }

      // Initialize git if needed
      if (!isGitRepo) {
        try {
          const branchName = 'main';
          await commandRunner.execAsync('git init', actualPath);
          console.log('[Main] Git repository initialized successfully');

          await commandRunner.execAsync(`git checkout -b ${branchName}`, actualPath);
          console.log(`[Main] Created and checked out branch: ${branchName}`);

          await commandRunner.execAsync('git commit -m "Initial commit" --allow-empty', actualPath, { env: getGitAttributionEnv(configManager.getConfig()) });
          console.log('[Main] Created initial empty commit');
        } catch (error) {
          console.error('[Main] Failed to initialize git repository:', error);
          // Continue anyway - let the user handle git setup manually if needed
        }
      }

      // Always detect the main branch - never use projectData.mainBranch
      let mainBranch: string | undefined;
      if (isGitRepo) {
        try {
          mainBranch = await worktreeManager.getProjectMainBranch(actualPath, commandRunner);
          console.log('[Main] Detected main branch:', mainBranch);
        } catch (error) {
          console.log('[Main] Could not detect main branch, skipping:', error);
        }
      }

      const project = databaseService.createProject(
        projectData.name,
        actualPath,  // Use actualPath (Linux path for WSL, original for non-WSL)
        projectData.systemPrompt,
        projectData.runScript,
        projectData.buildScript,
        undefined, // default_permission_mode
        projectData.openIdeCommand,
        wslEnabled || undefined,     // wsl_enabled
        wslDistribution              // wsl_distribution
      );

      // If run_script was provided, also create run commands
      if (projectData.runScript && project) {
        const commands = projectData.runScript.split('\n').filter((cmd: string) => cmd.trim());
        commands.forEach((command: string, index: number) => {
          databaseService.createRunCommand(
            project.id,
            command.trim(),
            `Command ${index + 1}`,
            index
          );
        });
      }

      console.log('[Main] Project created successfully:', project);

      if (project) {
        await updateProjectAgentContextBestEffort(project, configManager, 'project create');
      }

      // Track project creation
      if (analyticsManager && project) {
        const allProjects = databaseService.getAllProjects();
        analyticsManager.track('project_created', {
          was_auto_initialized: !isGitRepo,
          project_count: allProjects.length
        });
      }

      const projectWithEnv = project ? {
        ...project,
        environment: new PathResolver(project).environment
      } : null;

      return { success: true, data: projectWithEnv };
    } catch (error) {
      console.error('[Main] Failed to create project:', error);

      // Extract detailed error information
      let errorMessage = 'Failed to create project';
      let errorDetails = '';
      let command = '';

      if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack || error.toString();

        // Check if it's a command error
        const cmdError = decodeBoundary(error, boundary.object({
          cmd: boundary.optional(boundary.string),
          stderr: boundary.optional(boundary.string),
          stdout: boundary.optional(boundary.string),
        }));
        if (cmdError.cmd) {
          command = cmdError.cmd;
        }

        // Include command output if available
        if (cmdError.stderr) {
          errorDetails = cmdError.stderr;
        } else if (cmdError.stdout) {
          errorDetails = cmdError.stdout;
        }
      }

      return {
        success: false,
        error: errorMessage,
        details: errorDetails,
        command: command
      };
    }
  });

  commandRegistry.register('projects:activate', async (projectId: string) => {
    try {
      const project = databaseService.setActiveProject(parseInt(projectId));
      if (project) {
        sessionManager.setActiveProject(project);
        const ctx = sessionManager.getProjectContextByProjectId(parseInt(projectId));
        if (ctx) {
          await worktreeManager.initializeProject(project.path, undefined, ctx.pathResolver, ctx.commandRunner);
        }

        await updateProjectAgentContextBestEffort(project, configManager, 'project activate');

        // Track project switch
        if (analyticsManager) {
          const projectIdNum = parseInt(projectId);
          const projectSessions = databaseService.getAllSessions(projectIdNum);
          const hasActiveSessions = projectSessions.some(s => s.status === 'running' || s.status === 'pending');
          analyticsManager.track('project_switched', {
            has_active_sessions: hasActiveSessions
          });
        }
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to activate project:', error);
      return { success: false, error: 'Failed to activate project' };
    }
  });

  commandRegistry.register('projects:update', async (projectId: string, updates: UpdateProjectRequest) => {
    try {
      const projectIdNum = parseInt(projectId);

      // Invalidate cached PathResolver/CommandRunner in case WSL settings changed
      sessionManager.invalidateProjectContext(projectIdNum);

      // Update the project
      const project = databaseService.updateProject(projectIdNum, updates);

      // If run_script was updated, also update the run commands table
      if (updates.run_script !== undefined) {
        // Delete existing run commands
        databaseService.deleteProjectRunCommands(projectIdNum);

        // Add new run commands from the multiline script
        // Treat empty string and null the same - both mean no commands
        if (updates.run_script && updates.run_script.trim()) {
          const commands = updates.run_script.split('\n').filter((cmd: string) => cmd.trim());
          commands.forEach((command: string, index: number) => {
            databaseService.createRunCommand(
              projectIdNum,
              command.trim(),
              `Command ${index + 1}`,
              index
            );
          });
        }
      }

      // Emit event to notify frontend about project update
      if (project) {
        sessionManager.emit('project:updated', project);
      }

      // Track project settings update
      if (analyticsManager && project) {
        // Determine which category of setting was updated
        let settingCategory = 'other';
        if (updates.system_prompt !== undefined) {
          settingCategory = 'system_prompt';
        } else if (updates.run_script !== undefined || updates.build_script !== undefined) {
          settingCategory = 'scripts';
        } else if (updates.open_ide_command !== undefined) {
          settingCategory = 'ide';
        } else if (updates.name !== undefined) {
          settingCategory = 'name';
        }

        analyticsManager.track('project_settings_updated', {
          setting_category: settingCategory
        });
      }

      return { success: true, data: project };
    } catch (error) {
      console.error('Failed to update project:', error);
      return { success: false, error: 'Failed to update project' };
    }
  });

  commandRegistry.register('projects:delete', async (projectId: string) => {
    try {
      const projectIdNum = parseInt(projectId);
      
      // Get the project to access its path
      const project = databaseService.getProject(projectIdNum);
      if (!project) {
        console.error(`[Main] Project ${projectIdNum} not found`);
        return { success: false, error: 'Project not found' };
      }
      
      // Get all sessions for this project (including archived) to clean up worktrees
      const allProjectSessions = databaseService.getAllSessionsIncludingArchived().filter(s => s.project_id === projectIdNum);
      const projectSessions = databaseService.getAllSessions(projectIdNum);
      
      console.log(`[Main] Deleting project ${project.name} with ${allProjectSessions.length} total sessions`);
      
      // Check if any session from this project has a running script
      const runningScript = scriptExecutionTracker.getRunningScript();
      if (runningScript) {
        const runningSession = projectSessions.find(s => s.id === runningScript.id);
        if (runningSession && runningScript.type === 'session') {
          console.log(`[Main] Stopping running script for session ${runningScript.id} before deleting project`);
          await sessionManager.stopRunningScript();
          // Ensure tracker is updated even if sessionManager's internal update fails
          scriptExecutionTracker.stop('session', runningScript.id);
        }
      }
      
      // Close all terminal sessions for this project
      for (const session of projectSessions) {
        if (sessionManager.hasTerminalSession(session.id)) {
          console.log(`[Main] Closing terminal session ${session.id} before deleting project`);
          await sessionManager.closeTerminalSession(session.id);
        }
      }
      
      // Clean up all worktrees for this project (including archived sessions)
      let worktreeCleanupCount = 0;
      const ctx = sessionManager.getProjectContextByProjectId(projectIdNum);
      if (ctx) {
        for (const session of allProjectSessions) {
          // Skip sessions that are main repo or don't have worktrees
          if (session.is_main_repo || !session.worktree_name || session.worktree_ownership === 'external') {
            continue;
          }

          try {
            console.log(`[WorktreeAudit] remove_requested source="project-delete" sessionId=${JSON.stringify(session.id)} projectId=${projectIdNum} projectPath=${JSON.stringify(project.path)} worktreeName=${JSON.stringify(session.worktree_name)} worktreePath=${JSON.stringify(session.worktree_path || '')}`);
            // Pass session creation date for analytics tracking
            const sessionCreatedAt = session.created_at ? new Date(session.created_at) : undefined;
            await worktreeManager.removeWorktree(project.path, session.worktree_name, project.worktree_folder || undefined, sessionCreatedAt, ctx.pathResolver, ctx.commandRunner, {
              source: 'project-delete',
              sessionId: session.id,
              projectId: projectIdNum,
            });
            worktreeCleanupCount++;
          } catch (error) {
            // Log error but continue with other worktrees
            console.error(`[Main] Failed to remove worktree '${session.worktree_name}' for session ${session.id}:`, error);
          }
        }
      } else {
        for (const session of allProjectSessions) {
          if (session.is_main_repo || !session.worktree_name || session.worktree_ownership === 'external') {
            continue;
          }
          console.warn(`[WorktreeAudit] remove_skipped source="project-delete" sessionId=${JSON.stringify(session.id)} projectId=${projectIdNum} projectPath=${JSON.stringify(project.path)} worktreeName=${JSON.stringify(session.worktree_name)} worktreePath=${JSON.stringify(session.worktree_path || '')} reason="missing_project_context"`);
        }
      }
      
      console.log(`[Main] Cleaned up ${worktreeCleanupCount} worktrees for project ${project.name}`);

      // Invalidate project context cache before deleting
      sessionManager.invalidateProjectContext(projectIdNum);

      // Track project deletion before actually deleting
      if (analyticsManager) {
        const projectAge = Math.floor((Date.now() - new Date(project.created_at).getTime()) / (1000 * 60 * 60 * 24));
        analyticsManager.track('project_deleted', {
          session_count: projectSessions.length,
          project_age_days: projectAge
        });
      }

      // Now safe to delete the project
      const success = databaseService.deleteProject(projectIdNum);
      return { success: true, data: success };
    } catch (error) {
      console.error('Failed to delete project:', error);
      return { success: false, error: 'Failed to delete project' };
    }
  });

  commandRegistry.register('projects:reorder', async (projectOrders: Array<{ id: number; displayOrder: number }>) => {
    try {
      databaseService.reorderProjects(projectOrders);
      return { success: true };
    } catch (error) {
      console.error('Failed to reorder projects:', error);
      return { success: false, error: 'Failed to reorder projects' };
    }
  });

  commandRegistry.register('projects:detect-branch', async (repoPath: string) => {
    return detectProjectBranch(repoPath, (projectPath, commandRunner) => (
      worktreeManager.getProjectMainBranch(projectPath, commandRunner)
    ));
  });

  commandRegistry.register('projects:list-branches', async (projectId: string) => {
    try {
      const project = databaseService.getProject(parseInt(projectId));
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const ctx = sessionManager.getProjectContextByProjectId(parseInt(projectId));
      if (!ctx) {
        return { success: false, error: 'Failed to get project context' };
      }

      const branches = await worktreeManager.listBranches(project.path, ctx.commandRunner);
      return { success: true, data: branches };
    } catch (error) {
      console.error('[Main] Failed to list branches:', error);
      return { success: false, error: 'Failed to list branches' };
    }
  });

  commandRegistry.register('projects:refresh-git-status', async (projectId: string) => {
    try {
      const projectIdNum = parseInt(projectId);
      const { gitStatusManager } = services;

      // Check if the project exists
      const project = databaseService.getProject(projectIdNum);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // Invalidate PR cache for this project so fresh data is fetched
      gitStatusManager.invalidatePrCache(project.path);

      // Get all sessions for this project
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectIdNum && !s.archived && s.status !== 'error');

      // Count the sessions that will be refreshed
      const sessionsToRefresh = projectSessions.filter(session => session.worktreePath);
      const sessionCount = sessionsToRefresh.length;

      // Start the refresh in background (non-blocking)
      // Don't await this - let it run asynchronously
      setImmediate(() => {
        const refreshPromises = sessionsToRefresh
          .map(session =>
            gitStatusManager.refreshSessionGitStatus(session.id, true) // true = user initiated
              .catch(error => {
                console.error(`[Main] Failed to refresh git status for session ${session.id}:`, error);
                return null;
              })
          );

        Promise.allSettled(refreshPromises).then(results => {
          const refreshedCount = results.filter(result => result.status === 'fulfilled').length;
          console.log(`[Main] Background refresh completed: ${refreshedCount}/${sessionCount} sessions`);
        });
      });

      // Return immediately with the count of sessions that will be refreshed
      console.log(`[Main] Starting background refresh for ${sessionCount} sessions`);

      return { success: true, data: { count: sessionCount, backgroundRefresh: true } };
    } catch (error) {
      console.error('[Main] Failed to start project git status refresh:', error);
      return { success: false, error: 'Failed to refresh git status' };
    }
  });

  commandRegistry.register('projects:get-running-script', async () => {
    try {
      const runningProjectId = scriptExecutionTracker.getRunningScriptId('project');
      return { success: true, data: runningProjectId };
    } catch (error) {
      console.error('[Main] Failed to get running project script:', error);
      return { success: false, error: 'Failed to get running project script' };
    }
  });

  commandRegistry.register('projects:stop-script', async (projectId?: number) => {
    return stopProjectScriptInternal(projectId);
  });

  /**
   * IPC handler: `projects:detect-config`
   *
   * Runs `detectProjectConfig` against the project's root directory and returns the
   * resulting `DetectedProjectConfig` (or null if no config file is found).
   *
   * PURPOSE — Frontend badge display:
   *   The ProjectSettings component calls this handler when the settings modal opens
   *   in order to populate the "From <source>" badges shown beneath the Build Script,
   *   Run Commands, and Archive Script fields.  These badges communicate to the user
   *   that a value will be automatically sourced from a config file (e.g. pane.json)
   *   if they leave the corresponding Project Settings field empty.
   *
   * This handler always reads from `project.path` (the repo root on the main branch).
   * It does NOT read from a session's worktree path — that distinction only matters at
   * runtime when scripts are actually executed.  For display purposes the project root
   * is the canonical location.
   *
   * Related:
   *   - `shared/types/projectConfig.ts` — `DetectedProjectConfig` shape
   *   - `main/src/services/projectConfigDetector.ts` — `detectProjectConfig` implementation
   *   - `frontend/src/components/ProjectSettings.tsx` — consumer (badge rendering)
   */
  commandRegistry.register('projects:detect-config', async (projectId: string) => {
    try {
      const project = databaseService.getProject(parseInt(projectId));
      if (!project) return { success: false, error: 'Project not found' };
      const ctx = sessionManager.getProjectContextByProjectId(project.id);
      const detected = await detectProjectConfig(
        project.path,
        ctx?.pathResolver.environment || 'linux',
        ctx?.commandRunner
      );
      return { success: true, data: detected };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  /**
   * Resolves which run script should execute for a session.
   *
   * Resolution hierarchy (first match wins):
   * 1. DB `run_script` from Project Settings
   * 2. `pane.json` → `scripts.run`
   * 3. `conductor.json` → `scripts.run`
   * 4. `.gitpod.yml` → first task's `command`
   * 5. `.devcontainer/devcontainer.json` → `postStartCommand`
   * 6. `scripts/pane-run-script.js` in the session's worktree
   * 7. `null` — no run script found
   *
   * Steps 2-5 are handled by `detectProjectConfig()`.
   * DB values always override config files (Conductor model).
   */
  commandRegistry.register('projects:resolve-run-script', async (sessionId: string) => {
    try {
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession?.project_id) return { success: true, data: null };

      const project = databaseService.getProject(dbSession.project_id);
      if (!project) return { success: true, data: null };

      // 1. DB run_script wins
      if (project.run_script) {
        return { success: true, data: { command: project.run_script, source: 'Project Settings' } };
      }

      // 2-5. Config file detection (pane.json > conductor.json > .gitpod.yml > devcontainer.json)
      // Resolve from session's worktree path so branch-local config changes are picked up
      const session = sessionManager.getSession(sessionId);
      const configPath = session?.worktreePath || project.path;
      const ctx = sessionManager.getProjectContextByProjectId(project.id);
      if (ctx) {
        const detected = await detectProjectConfig(
          configPath,
          ctx.pathResolver.environment,
          ctx.commandRunner
        );
        if (detected?.run) {
          return { success: true, data: { command: detected.run, source: detected.source } };
        }
      }
      if (session?.worktreePath) {
        const scriptRelPath = 'scripts/pane-run-script.js';
        // Use the session's worktree path to check for the script
        const ctx2 = sessionManager.getProjectContext(sessionId);
        if (ctx2) {
          const scriptFullPath = path.join(ctx2.pathResolver.toFileSystem(session.worktreePath), scriptRelPath);
          try {
            await access(scriptFullPath);
            return { success: true, data: { command: `node ${scriptRelPath}`, source: scriptRelPath } };
          } catch {
            // Script doesn't exist — fall through
          }
        }
      }

      // 7. Nothing found
      return { success: true, data: null };
    } catch (error) {
      console.error('[Main] Failed to resolve run script:', error);
      return { success: false, error: String(error) };
    }
  });

  commandRegistry.register('projects:run-script', async (projectId: number) => {
    try {
      // Get the project
      const project = databaseService.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // Get the run script, with fallback to detected config.
      //
      // NOTE: `projects:run-script` is the *project-level* run handler used from the
      // Dashboard / project toolbar.  It is distinct from `projects:resolve-run-script`
      // which resolves a run script for a specific session's worktree.  Both follow the
      // same DB-wins-then-config-detection fallback pattern, but this handler always
      // reads from `project.path` (the main worktree) rather than a session worktree.
      //
      // Resolution chain (first match wins):
      //   1. DB `project.run_script`
      //   2. `detectProjectConfig(project.path)` → `run` field
      //   3. Error — nothing to run
      let runScript = project.run_script;
      if (!runScript) {
        const ctx = sessionManager.getProjectContextByProjectId(project.id);
        if (ctx) {
          const detected = await detectProjectConfig(
            project.path,
            ctx.pathResolver.environment,
            ctx.commandRunner
          );
          runScript = detected?.run ?? null;
        }
      }
      if (!runScript) {
        return { success: false, error: 'No run script configured for this project' };
      }

      // If there's already a running script (any type), stop it first
      const runningScript = scriptExecutionTracker.getRunningScript();
      if (runningScript) {
        console.log(`[Main] Stopping currently running ${runningScript.type} script for ${runningScript.type}:${runningScript.id}`);

        // Mark the old script as closing
        scriptExecutionTracker.markClosing(runningScript.type, runningScript.id);

        // Stop the script based on its type
        if (runningScript.type === 'project') {
          // Call internal stop function
          const projectScriptId = decodeBoundary(runningScript.id, boundary.number);
          const stopResult = await stopProjectScriptInternal(projectScriptId);
          if (!stopResult?.success) {
            console.warn('[Main] Failed to stop running project script, continuing anyway');
          }
        } else if (runningScript.type === 'session') {
          // Stop session script through logs panel
          const sessionIdToStop = decodeBoundary(runningScript.id, boundary.string);
          const panels = await panelManager.getPanelsForSession(sessionIdToStop);
          const logsPanel = panels?.find((p: { type: string }) => p.type === 'logs');
          if (logsPanel) {
            const { logsManager } = loadProjectDependency('../services/panels/logPanel/logsManager');
            await logsManager.stopScript(logsPanel.id);
          }
          // Also try old mechanism as fallback
          await sessionManager.stopRunningScript();
          // Mark as stopped in tracker
          scriptExecutionTracker.stop('session', sessionIdToStop);
        }
      }

      // Get or create main repo session for this project
      const mainRepoSession = await sessionManager.getOrCreateMainRepoSession(projectId);
      if (!mainRepoSession) {
        return { success: false, error: 'Failed to get or create main repo session' };
      }

      const sessionId = mainRepoSession.id;

      // Run the script in the project root using logsManager
      const { logsManager } = loadProjectDependency('../services/panels/logPanel/logsManager');
      const ctx = sessionManager.getProjectContextByProjectId(projectId);
      const wslContext = ctx ? ctx.commandRunner.wslContext : null;
      await logsManager.runScript(sessionId, runScript, project.path, wslContext);

      // Track the running project
      scriptExecutionTracker.start('project', projectId, sessionId);

      return { success: true, data: { sessionId } };
    } catch (error) {
      console.error('[Main] Failed to run project script:', error);

      // Clear running state on error
      scriptExecutionTracker.stop('project', projectId);

      return { success: false, error: error instanceof Error ? error.message : 'Failed to run project script' };
    }
  });
  commandRegistry.bindChannels(ipcMain, DAEMON_PROJECT_CHANNELS);
}

async function updateProjectAgentContextBestEffort(
  project: Project,
  configManager: ConfigManager,
  source: string,
): Promise<void> {
  try {
    await ensureProjectAgentContext(project, configManager.getConfig());
  } catch (error) {
    console.warn(`[Main] Failed to update Pane agent context during ${source}:`, error);
  }
}
