/**
 * Session IPC handlers for Pane.
 * Note: "Sessions" are called "Panes" in the UI. Internally they remain
 * "sessions" in code, database, and IPC to avoid a massive refactor.
 */

import type { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { CreateSessionRequest, Session } from '../types/session';
import { getAppSubdirectory } from '../utils/appDirectory';
import { convertDbFolderToRendererFolder } from '../services/folderEvents';
import { sessionImageCounters } from './panels';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import {
  validateSessionExists,
  validatePanelExists,
  validateSessionIsActive,
  logValidationFailure,
  createValidationError,
} from '../utils/sessionValidation';
import type { SerializedArchiveTask } from '../services/archiveProgressManager';
import { detectProjectConfig } from '../services/projectConfigDetector';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const DAEMON_SESSION_CHANNELS = [
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
] as const;

const ACTIVE_SESSION_HINT_CHANNEL = 'sessions:set-active-session';

const DAEMON_SESSION_PANEL_CHANNELS = [
  'panels:get-output',
  'panels:get-conversation-messages',
  'panels:get-json-messages',
  'panels:get-prompts',
  'panels:send-input',
  'panels:continue',
] as const;

type DatabaseSession = {
  id: string;
  name?: string | null;
  archived?: boolean | number | null;
  worktree_name?: string | null;
  worktree_path?: string | null;
  project_id?: number | null;
  is_main_repo?: boolean | number | null;
  worktree_ownership?: 'pane' | 'external' | null;
  created_at?: string | null;
};

export function registerSessionHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const {
    sessionManager,
    databaseService,
    taskQueue,
    worktreeManager,
    claudeCodeManager, // For backward compatibility
    worktreeNameGenerator,
    gitStatusManager,
    archiveProgressManager,
    spotlightManager,
    runCommandManager
  } = services;

  const attachCachedGitStatus = (session: Session): Session => {
    const cached = gitStatusManager.getCachedStatus(session.id)?.status;
    return cached ? { ...session, gitStatus: cached } : session;
  };

  const cleanupPermanentDeleteFiles = async (dbSession: DatabaseSession) => {
    const sessionId = dbSession.id;

    try {
      await runCommandManager.stopRunCommands(sessionId);
    } catch (err) {
      console.error(`[Session IPC] stopRunCommands failed during permanent delete for ${sessionId}:`, err);
    }

    try {
      const worktreeName = dbSession.worktree_name || '';
      const projectId = dbSession.project_id;
      const worktreePath = dbSession.worktree_path || '';
      if (worktreeName && projectId && !dbSession.is_main_repo && dbSession.worktree_ownership !== 'external' && worktreePath) {
        const project = databaseService.getProject(projectId);
        const ctx = sessionManager.getProjectContextByProjectId(projectId);
        if (project && ctx) {
          const sessionCreatedAt = dbSession.created_at ? new Date(dbSession.created_at) : undefined;
          console.log(`[WorktreeAudit] remove_requested source="session-delete" permanentDelete=true sessionId=${JSON.stringify(sessionId)} projectId=${projectId} projectPath=${JSON.stringify(project.path)} worktreeName=${JSON.stringify(worktreeName)} worktreePath=${JSON.stringify(worktreePath)}`);
          await worktreeManager.removeWorktree(
            project.path,
            worktreeName,
            project.worktree_folder || undefined,
            sessionCreatedAt,
            ctx.pathResolver,
            ctx.commandRunner,
            {
              source: 'session-delete',
              sessionId,
              projectId,
            },
          );
        } else {
          console.warn(`[WorktreeAudit] remove_skipped source="session-delete" permanentDelete=true sessionId=${JSON.stringify(sessionId)} projectId=${projectId} worktreeName=${JSON.stringify(worktreeName)} reason="missing_project_or_context"`);
        }
      }
    } catch (err) {
      console.error(`[Session IPC] Failed to remove worktree during permanent delete for ${sessionId}:`, err);
    }

    const artifactsDir = getAppSubdirectory('artifacts', sessionId);
    if (existsSync(artifactsDir)) {
      try {
        await fs.rm(artifactsDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[Session IPC] Failed to remove artifacts during permanent delete for ${sessionId}:`, err);
      }
    }

    for (const subdir of ['images', 'files'] as const) {
      const dir = getAppSubdirectory(subdir);
      if (!existsSync(dir)) continue;

      try {
        const allFiles = await fs.readdir(dir);
        const sessionPrefix = `${sessionId}_`;
        const sessionFiles = allFiles.filter(file => file.startsWith(sessionPrefix));
        for (const file of sessionFiles) {
          await fs.unlink(path.join(dir, file)).catch(() => {});
        }
      } catch (err) {
        console.error(`[Session IPC] Failed to remove ${subdir} during permanent delete for ${sessionId}:`, err);
      }
    }

    sessionImageCounters.delete(sessionId);
  };

  // Session management handlers
  commandRegistry.register('sessions:get-all', async () => {
    try {
      const sessions = (await sessionManager.getAllSessions()).map(attachCachedGitStatus);
      return { success: true, data: sessions };
    } catch (error) {
      console.error('Failed to get sessions:', error);
      return { success: false, error: 'Failed to get sessions' };
    }
  });

  commandRegistry.register('sessions:get', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      return { success: true, data: attachCachedGitStatus(session) };
    } catch (error) {
      console.error('Failed to get session:', error);
      return { success: false, error: 'Failed to get session' };
    }
  });

  commandRegistry.register('sessions:get-all-with-projects', async () => {
    try {
      const allProjects = databaseService.getAllProjects();
      const projectsWithSessions = allProjects.map(project => {
        const sessions = sessionManager.getSessionsForProject(project.id).map(attachCachedGitStatus);
        const folders = databaseService.getFoldersForProject(project.id);
        const convertedFolders = folders.map(convertDbFolderToRendererFolder);
        return {
          ...project,
          sessions,
          folders: convertedFolders
        };
      });
      return { success: true, data: projectsWithSessions };
    } catch (error) {
      console.error('Failed to get sessions with projects:', error);
      return { success: false, error: 'Failed to get sessions with projects' };
    }
  });

  commandRegistry.register('sessions:get-archived-with-projects', async () => {
    try {
      const allProjects = databaseService.getAllProjects();
      const projectsWithArchivedSessions = allProjects.map(project => {
        const archivedSessions = databaseService.getArchivedSessions(project.id);
        return {
          ...project,
          sessions: archivedSessions,
          folders: [] // Archived sessions don't need folders
        };
      }).filter(project => project.sessions.length > 0); // Only include projects with archived sessions
      return { success: true, data: projectsWithArchivedSessions };
    } catch (error) {
      console.error('Failed to get archived sessions with projects:', error);
      return { success: false, error: 'Failed to get archived sessions with projects' };
    }
  });

  commandRegistry.register('sessions:create', async (request: CreateSessionRequest) => {
    try {
      let targetProject;

      if (request.projectId) {
        // Use the project specified in the request
        targetProject = databaseService.getProject(request.projectId);
        if (!targetProject) {
          return { success: false, error: 'Project not found' };
        }
      } else {
        // Fall back to active project for backward compatibility
        targetProject = sessionManager.getActiveProject();
        if (!targetProject) {
          console.warn('[IPC] No project specified and no active project found');
          return { success: false, error: 'No project specified. Please provide a projectId.' };
        }
      }

      if (!taskQueue) {
        console.error('[IPC] Task queue not initialized');
        return { success: false, error: 'Task queue not initialized' };
      }

      // Force count to 1 for main-repo sessions — no worktree isolation means
      // multiple panes would all operate on the same directory concurrently.
      const count = request.isMainRepo ? 1 : (request.count || 1);

      const sessionToolType: 'claude' | 'none' | undefined = request.toolType;

      if (count > 1) {
        const jobs = await taskQueue.createMultipleSessions(
          request.prompt,
          request.worktreeTemplate || '',
          count,
          request.permissionMode,
          targetProject.id,
          request.baseBranch,
          sessionToolType,
          request.folderId,
          request.isMainRepo,
          request.startPinned
        );

        return { success: true, data: { jobIds: jobs.map(job => job.id) } };
      } else {
        const job = await taskQueue.createSession({
          prompt: request.prompt,
          worktreeTemplate: request.worktreeTemplate || '',
          permissionMode: request.permissionMode,
          projectId: targetProject.id,
          folderId: request.folderId,
          isMainRepo: request.isMainRepo,
          baseBranch: request.baseBranch,
          toolType: sessionToolType,
          startPinned: request.startPinned
        });

        return { success: true, data: { jobId: job.id } };
      }
    } catch (error) {
      console.error('[IPC] Failed to create session:', error);
      console.error('[IPC] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

      // Extract detailed error information
      let errorMessage = 'Failed to create session';
      let errorDetails = '';
      let command = '';

      if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack || error.toString();

        // Check if it's a git command error
        const gitError = decodeBoundary(error, boundary.object({
          gitCommand: boundary.optional(boundary.string),
          cmd: boundary.optional(boundary.string),
          gitOutput: boundary.optional(boundary.string),
          stderr: boundary.optional(boundary.string),
        }));
        if (gitError.gitCommand) {
          command = gitError.gitCommand;
        } else if (gitError.cmd) {
          command = gitError.cmd;
        }

        // Include git output if available
        if (gitError.gitOutput) {
          errorDetails = gitError.gitOutput;
        } else if (gitError.stderr) {
          errorDetails = gitError.stderr;
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

  commandRegistry.register('sessions:delete', async (sessionId: string) => {
    try {
      // Get database session details before archiving (includes worktree_name and project_id)
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }
      
      // Check if session is already archived
      if (dbSession.archived) {
        return { success: false, error: 'Session is already archived' };
      }

      // Add a message to session output about archiving
      const timestamp = new Date().toLocaleTimeString();
      let archiveMessage = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[44m\x1b[37m 📦 ARCHIVING SESSION \x1b[0m\r\n`;
      archiveMessage += `\x1b[90mSession will be archived and removed from the active sessions list.\x1b[0m\r\n`;

      // Disable spotlight if this session is spotlighted
      try {
        if (spotlightManager.isSpotlightActive(sessionId)) {
          await spotlightManager.disable(sessionId);
          console.log(`[Session IPC] Disabled spotlight for archived session ${sessionId}`);
        }
      } catch (spotlightError) {
        console.error('[Session IPC] Failed to disable spotlight during archive:', spotlightError);
      }

      // Archive the session immediately to provide fast feedback to the user
      await sessionManager.archiveSession(sessionId);

      // Add the archive message to session output
      try {
        sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: archiveMessage,
          timestamp: new Date()
        });
      } catch (error) {
        console.warn(`[ArchiveCleanup] archive_message_output_failed sessionId=${sessionId}:`, error);
      }

      // Kill all panel processes for this session before worktree cleanup
      // This prevents leaked node-pty processes and ensures worktree removal succeeds.
      // NOTE: must run BEFORE cleanupSessionPanelsInMemory because
      // getPanelsForSession has a DB-read side effect that repopulates
      // panelManager.panels; calling it after the in-memory cleanup would
      // re-insert the entries we just cleared.
      const panels = panelManager.getPanelsForSession(sessionId);
      for (const panel of panels) {
        try {
          if (panel.type === 'terminal') {
            terminalPanelManager.destroyTerminal(panel.id);
          }
        } catch (panelError) {
          console.error(`[Session IPC] Failed to cleanup panel ${panel.id} (${panel.type}):`, panelError);
        }
      }

      // Release in-memory panel state (does NOT hard-delete DB rows — archive-safe)
      try {
        await panelManager.cleanupSessionPanelsInMemory(sessionId);
      } catch (err) {
        console.error(`[Session IPC] cleanupSessionPanelsInMemory failed for ${sessionId}:`, err);
      }

      // Drain git status cache, pending events, timers, abort controllers, and file watcher
      try {
        gitStatusManager.clearSessionCache(sessionId);
      } catch (err) {
        console.error(`[Session IPC] clearSessionCache failed for ${sessionId}:`, err);
      }

      // Create cleanup callback for background operations
      const cleanupCallback = async () => {
        console.log(`[ArchiveCleanup] cleanup_started sessionId=${sessionId} sessionName=${JSON.stringify(dbSession.name)} worktreeName=${JSON.stringify(dbSession.worktree_name || '')}`);
        let cleanupMessage = '';

        // Stop any active run commands for this session so their file handles are released
        // before worktree removal. Must run before worktree-removal logic below.
        try {
          await runCommandManager.stopRunCommands(sessionId);
        } catch (err) {
          console.error(`[Session IPC] stopRunCommands failed for ${sessionId}:`, err);
        }

        // Clean up the worktree if session has one (but not for main repo sessions)
        if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo && dbSession.worktree_ownership !== 'external') {
          const project = databaseService.getProject(dbSession.project_id);
          if (project) {
            const ctx = sessionManager.getProjectContextByProjectId(dbSession.project_id);
            if (ctx) {
              try {
                // ── Archive script resolution ──────────────────────────────────────────
                // Before removing the worktree we give the project a chance to run
                // cleanup commands (e.g. stopping background servers, pushing branches,
                // uploading artefacts).
                //
                // Resolution chain (first match wins):
                //   1. DB `project.archive_script` — set explicitly in Project Settings.
                //   2. `detectProjectConfig(worktree_path)` → `archive` field — read from
                //      the *worktree path* (not the project root) so that branch-local
                //      config (pane.json / conductor.json) on the session's branch is used.
                //   3. Skip — no archive script runs, proceed directly to worktree removal.
                //
                // Failure of the archive script does NOT block worktree removal; the outer
                // try/catch swallows errors and appends a warning to `cleanupMessage` so
                // the user sees what happened without the session getting stuck.
                //
                // The progress status 'running-archive-script' is emitted to `ArchiveProgressManager`
                // so the frontend can display granular progress in the archive UI.
                let archiveScript = project.archive_script;
                if (!archiveScript) {
                  const detected = await detectProjectConfig(
                    dbSession.worktree_path || project.path,
                    ctx.pathResolver.environment,
                    ctx.commandRunner
                  );
                  archiveScript = detected?.archive ?? null;
                }
                if (archiveScript) {
                  try {
                    if (archiveProgressManager) {
                      archiveProgressManager.updateTaskStatus(sessionId, 'running-archive-script');
                    }
                    const commands = archiveScript.split('\n').filter((cmd: string) => cmd.trim());
                    const archiveResult = await sessionManager.runArchiveScript(
                      sessionId, commands, dbSession.worktree_path, ctx.commandRunner
                    );
                    if (archiveResult.success) {
                      cleanupMessage += `\x1b[32m✓ Archive script completed\x1b[0m\r\n`;
                    } else {
                      cleanupMessage += `\x1b[33m⚠ Archive script completed with errors\x1b[0m\r\n`;
                    }
                  } catch (archiveError) {
                    console.error(`[Main] Archive script failed for session ${sessionId}:`, archiveError);
                    cleanupMessage += `\x1b[33m⚠ Archive script failed (continuing cleanup)\x1b[0m\r\n`;
                  }
                }

                // Update progress: removing worktree
                if (archiveProgressManager) {
                  archiveProgressManager.updateTaskStatus(sessionId, 'removing-worktree');
                }

                // Pass session creation date for analytics tracking
                const sessionCreatedAt = dbSession.created_at ? new Date(dbSession.created_at) : undefined;
                console.log(`[WorktreeAudit] remove_requested source="session-delete" sessionId=${JSON.stringify(sessionId)} projectId=${dbSession.project_id} projectPath=${JSON.stringify(project.path)} worktreeName=${JSON.stringify(dbSession.worktree_name)} worktreePath=${JSON.stringify(dbSession.worktree_path || '')}`);
                await worktreeManager.removeWorktree(project.path, dbSession.worktree_name, project.worktree_folder || undefined, sessionCreatedAt, ctx.pathResolver, ctx.commandRunner, {
                  source: 'session-delete',
                  sessionId,
                  projectId: dbSession.project_id,
                });

                cleanupMessage += `\x1b[32m✓ Worktree removed successfully\x1b[0m\r\n`;
              } catch (worktreeError) {
                // Log the error but don't fail
                console.error(`[Main] Failed to remove worktree ${dbSession.worktree_name}:`, worktreeError);
                console.error(`[ArchiveCleanup] worktree_remove_failed sessionId=${sessionId} worktreeName=${dbSession.worktree_name}:`, worktreeError);
                cleanupMessage += `\x1b[33m⚠ Failed to remove worktree (manual cleanup may be needed)\x1b[0m\r\n`;

                // Update progress: failed
                if (archiveProgressManager) {
                  archiveProgressManager.updateTaskStatus(sessionId, 'failed', 'Failed to remove worktree');
                }
              }
            } else {
              console.warn(`[WorktreeAudit] remove_skipped source="session-delete" sessionId=${JSON.stringify(sessionId)} projectId=${dbSession.project_id} worktreeName=${JSON.stringify(dbSession.worktree_name)} reason="missing_project_context"`);
            }
          } else {
            console.warn(`[WorktreeAudit] remove_skipped source="session-delete" sessionId=${JSON.stringify(sessionId)} projectId=${dbSession.project_id} worktreeName=${JSON.stringify(dbSession.worktree_name)} reason="missing_project"`);
          }
        } else {
          console.log(`[WorktreeAudit] remove_skipped source="session-delete" sessionId=${JSON.stringify(sessionId)} worktreeName=${JSON.stringify(dbSession.worktree_name || '')} reason="no_session_worktree_cleanup_needed"`);
        }

        // Clean up session artifacts (images)
        const artifactsDir = getAppSubdirectory('artifacts', sessionId);
        if (existsSync(artifactsDir)) {
          try {
            // Update progress: cleaning artifacts
            if (archiveProgressManager) {
              archiveProgressManager.updateTaskStatus(sessionId, 'cleaning-artifacts');
            }
            
            await fs.rm(artifactsDir, { recursive: true, force: true });
            
            cleanupMessage += `\x1b[32m✓ Artifacts removed successfully\x1b[0m\r\n`;
          } catch (artifactsError) {
            console.error(`[Main] Failed to remove artifacts for session ${sessionId}:`, artifactsError);
            cleanupMessage += `\x1b[33m⚠ Failed to remove artifacts (manual cleanup may be needed)\x1b[0m\r\n`;
          }
        }

        // Clean up terminal-pasted images and dropped files
        for (const subdir of ['images', 'files'] as const) {
          const dir = getAppSubdirectory(subdir);
          if (existsSync(dir)) {
            try {
              const allFiles = await fs.readdir(dir);
              const sessionPrefix = `${sessionId}_`;
              const sessionFiles = allFiles.filter(f => f.startsWith(sessionPrefix));
              for (const file of sessionFiles) {
                await fs.unlink(path.join(dir, file)).catch(() => {});
              }
              if (sessionFiles.length > 0) {
                const label = subdir === 'images' ? 'pasted image(s)' : 'dropped file(s)';
                cleanupMessage += `\x1b[32m✓ ${sessionFiles.length} ${label} removed\x1b[0m\r\n`;
              }
            } catch (err) {
              console.error(`[Main] Failed to clean up ${subdir} for session ${sessionId}:`, err);
              cleanupMessage += `\x1b[33m⚠ Failed to remove ${subdir}\x1b[0m\r\n`;
            }
          }
        }

        // Clear in-memory image counter for this session
        sessionImageCounters.delete(sessionId);

        // If there were any cleanup messages, add them to the session output
        if (cleanupMessage) {
          try {
            sessionManager.addSessionOutput(sessionId, {
              type: 'stdout',
              data: cleanupMessage,
              timestamp: new Date()
            });
          } catch (error) {
            console.warn(`[ArchiveCleanup] cleanup_output_failed sessionId=${sessionId}:`, error);
          }
        }
        console.log(`[ArchiveCleanup] cleanup_completed sessionId=${sessionId}`);
      };

      // Queue the cleanup task if we have worktree cleanup to do
      if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo && dbSession.worktree_ownership !== 'external') {
        const project = databaseService.getProject(dbSession.project_id);
        if (project && archiveProgressManager) {
          console.log(`[ArchiveCleanup] archive_queued sessionId=${sessionId} sessionName=${JSON.stringify(dbSession.name)} worktreeName=${JSON.stringify(dbSession.worktree_name)} projectName=${JSON.stringify(project.name)}`);
          console.log(`[WorktreeAudit] remove_queued source="session-delete" sessionId=${JSON.stringify(sessionId)} projectId=${dbSession.project_id} projectPath=${JSON.stringify(project.path)} worktreeName=${JSON.stringify(dbSession.worktree_name)} worktreePath=${JSON.stringify(dbSession.worktree_path || '')}`);
          archiveProgressManager.addTask(
            sessionId,
            dbSession.name,
            dbSession.worktree_name,
            project.name,
            cleanupCallback
          );
        } else {
          console.warn(`[ArchiveCleanup] archive_queue_skipped sessionId=${sessionId} reason=${archiveProgressManager ? '"missing_project"' : '"missing_archive_progress_manager"'}`);
          setImmediate(() => cleanupCallback());
        }
      } else {
        // No worktree cleanup needed, just run artifact cleanup immediately
        setImmediate(() => cleanupCallback());
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to delete session:', error);
      return { success: false, error: 'Failed to delete session' };
    }
  });

  commandRegistry.register('sessions:permanent-delete', async (sessionId: string) => {
    try {
      const session = databaseService.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.archived) {
        return { success: false, error: 'Session must be archived before permanent deletion' };
      }

      try {
        gitStatusManager.clearSessionCache(sessionId);
      } catch (err) {
        console.error(`[Session IPC] clearSessionCache failed for permanently deleted session ${sessionId}:`, err);
      }

      try {
        await panelManager.cleanupSessionPanelsInMemory(sessionId);
      } catch (err) {
        console.error(`[Session IPC] cleanupSessionPanelsInMemory failed for permanently deleted session ${sessionId}:`, err);
      }

      await cleanupPermanentDeleteFiles(session);

      const deleted = databaseService.deleteArchivedSessionPermanently(sessionId);
      if (!deleted) {
        return { success: false, error: 'Session not found or not archived' };
      }

      const allSessions = sessionManager.getAllSessions();
      sessionManager.emit('sessions-loaded', allSessions);
      return { success: true };
    } catch (error) {
      console.error('Failed to permanently delete session:', error);
      return { success: false, error: 'Failed to permanently delete session' };
    }
  });

  commandRegistry.register('sessions:permanent-delete-archived', async () => {
    try {
      const archivedSessions = databaseService.getArchivedSessions();
      for (const session of archivedSessions) {
        try {
          gitStatusManager.clearSessionCache(session.id);
        } catch (err) {
          console.error(`[Session IPC] clearSessionCache failed for permanently deleted session ${session.id}:`, err);
        }

        try {
          await panelManager.cleanupSessionPanelsInMemory(session.id);
        } catch (err) {
          console.error(`[Session IPC] cleanupSessionPanelsInMemory failed for permanently deleted session ${session.id}:`, err);
        }

        await cleanupPermanentDeleteFiles(session);
      }

      const deletedCount = databaseService.deleteArchivedSessionsPermanently();
      const allSessions = sessionManager.getAllSessions();
      sessionManager.emit('sessions-loaded', allSessions);
      return { success: true, data: { deletedCount } };
    } catch (error) {
      console.error('Failed to permanently delete archived sessions:', error);
      return { success: false, error: 'Failed to permanently delete archived sessions' };
    }
  });

  commandRegistry.register('sessions:input', async (sessionId: string, input: string) => {
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:input', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Interactive Claude mode: user replied to a prompt, flip back to running.
      const currentSession = sessionManager.getSession(sessionId);
      if (currentSession && currentSession.status === 'waiting') {
        await sessionManager.updateSession(sessionId, { status: 'running' });
      }

      // Store user input in session outputs for persistence
      const userInputDisplay = `> ${input.trim()}\n`;
      await sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: userInputDisplay,
        timestamp: new Date()
      });

      // Get session to determine tool type
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Determine which tool type to use
      const sessionToolType = session.toolType || 'claude'; // Default to claude for backward compatibility

      if (sessionToolType === 'none') {
        console.log(`[IPC] Session ${sessionId} has no tool type - cannot send input`);
        return { success: false, error: 'Session has no tool configured' };
      }

      // Use session-based methods for all tool types
      console.log(`[IPC] Sending input to session ${sessionId} via claudeCodeManager session methods`);

      // Check if Claude Code is running for this session
      const isClaudeRunning = claudeCodeManager.isSessionRunning(sessionId);

      if (!isClaudeRunning) {
        console.log(`[IPC] Claude Code not running for session ${sessionId}, starting it now...`);

        // Start Claude Code with the input as the initial prompt
        await claudeCodeManager.startSession(
          sessionId,
          session.worktreePath,
          input,
          session.permissionMode
        );

        // Update session status to running
        await sessionManager.updateSession(sessionId, { status: 'running' });
      } else {
        // Claude Code is already running, just send the input using virtual panel ID
        claudeCodeManager.sendInput(`session-${sessionId}`, input);
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to send input:', error);
      return { success: false, error: 'Failed to send input' };
    }
  });

  commandRegistry.register('sessions:get-or-create-main-repo', async (projectId: number) => {
    try {
      console.log('[IPC] sessions:get-or-create-main-repo handler called with projectId:', projectId);

      // Get or create the main repo session
      const session = await sessionManager.getOrCreateMainRepoSession(projectId);

      // If it's a newly created session, just emit the created event
      const dbSession = databaseService.getSession(session.id);
      if (dbSession && dbSession.status === 'pending') {
        console.log('[IPC] New main repo session created:', session.id);

        // Emit session created event
        sessionManager.emitSessionCreated(session);

        // Set the status to stopped since Claude Code isn't running yet
        sessionManager.updateSession(session.id, { status: 'stopped' });
      }

      return { success: true, data: session };
    } catch (error) {
      console.error('Failed to get or create main repo session:', error);
      return { success: false, error: 'Failed to get or create main repo session' };
    }
  });

  commandRegistry.register('sessions:continue', async (sessionId: string, prompt?: string, model?: string) => {
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:continue', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get session details
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Determine tool type for this session
      const sessionToolType = session.toolType || 'claude'; // Default to claude for backward compatibility

      if (sessionToolType === 'none') {
        console.log(`[IPC] Session ${sessionId} has no tool type - cannot continue`);
        return { success: false, error: 'Session has no tool configured' };
      }

      // Check if Claude is already running for this session to prevent duplicate starts
      if (claudeCodeManager.isSessionRunning(sessionId)) {
        console.log(`[IPC] Session ${sessionId} is already running, preventing duplicate continue`);
        return { success: false, error: 'Session is already processing a request' };
      }

      // Always use session-based conversation history
      const conversationHistory = sessionManager.getConversationMessages(sessionId);

      // If no prompt provided, use empty string (for resuming)
      const continuePrompt = prompt || '';

      // Check if this is a main repo session that hasn't started Claude Code yet
      const dbSession = databaseService.getSession(sessionId);
      const isMainRepoFirstStart = dbSession?.is_main_repo && conversationHistory.length === 0 && continuePrompt;

      // Update session status to initializing and clear run_started_at
      sessionManager.updateSession(sessionId, {
        status: 'initializing',
        run_started_at: null // Clear previous run time
      });

      if (isMainRepoFirstStart && continuePrompt) {
        // First message in main repo session - start Claude Code without --resume
        console.log(`[IPC] Starting Claude Code for main repo session ${sessionId} with first prompt`);

        // Add initial prompt marker
        sessionManager.addInitialPromptMarker(sessionId, continuePrompt);

        // Add initial prompt to conversation messages
        sessionManager.addConversationMessage(sessionId, 'user', continuePrompt);

        // Add the prompt to output so it's visible
        const timestamp = new Date().toLocaleTimeString();
        const initialPromptDisplay = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
                                     `\x1b[1m\x1b[92m${continuePrompt}\x1b[0m\r\n\r\n`;
        await sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: initialPromptDisplay,
          timestamp: new Date()
        });

        // ── Build script for main-repo sessions ───────────────────────────────
        // Main-repo sessions (is_main_repo = true) share the project root rather
        // than a dedicated worktree, so we read the config from project.path.
        //
        // Resolution chain (first match wins):
        //   1. DB `project.build_script` — set explicitly in Project Settings.
        //   2. `detectProjectConfig(project.path)` → `setup` field from pane.json,
        //      conductor.json, .gitpod.yml, or devcontainer.json.
        //   3. Skip — no build script runs.
        //
        // This mirrors the same fallback used in `taskQueue.ts` for worktree sessions
        // and in `cleanupCallback` above for archive scripts.
        const project = dbSession?.project_id ? databaseService.getProject(dbSession.project_id) : null;
        let mainRepoBuildScript = project?.build_script;
        if (!mainRepoBuildScript && project) {
          const ctx = sessionManager.getProjectContextByProjectId(project.id);
          if (ctx) {
            const detected = await detectProjectConfig(
              project.path,
              ctx.pathResolver.environment,
              ctx.commandRunner
            );
            mainRepoBuildScript = detected?.setup;
          }
        }
        if (mainRepoBuildScript) {
          console.log(`[IPC] Running build script for main repo session ${sessionId}`);

          const buildWaitingMessage = `\x1b[36m[${new Date().toLocaleTimeString()}]\x1b[0m \x1b[1m\x1b[33m⏳ Waiting for build script to complete...\x1b[0m\r\n\r\n`;
          await sessionManager.addSessionOutput(sessionId, {
            type: 'stdout',
            data: buildWaitingMessage,
            timestamp: new Date()
          });

          const buildCommands = mainRepoBuildScript.split('\n').filter(cmd => cmd.trim());
          const buildContext = sessionManager.getProjectContext(sessionId);
          if (!buildContext) throw new Error('Project context not found for setup script');
          const buildResult = await sessionManager.runBuildScript(sessionId, buildCommands, session.worktreePath, buildContext.commandRunner);
          console.log(`[IPC] Build script completed. Success: ${buildResult.success}`);
        }

        // Use session-based start method
        console.log(`[IPC] Starting Claude via session-based method for main repo session ${sessionId}`);
        await claudeCodeManager.startSession(
          sessionId,
          session.worktreePath,
          continuePrompt,
          dbSession?.permission_mode,
          model
        );
      } else {
        // Normal continue for existing sessions
        if (continuePrompt) {
          await sessionManager.continueConversation(sessionId, continuePrompt);
        }

        // Use session-based continue method
        console.log(`[IPC] Continuing Claude via session-based method for session ${sessionId}`);
        await claudeCodeManager.continueSession(
          sessionId,
          session.worktreePath,
          continuePrompt,
          conversationHistory,
          model
        );
      }

      // The session manager will update status based on Claude output
      return { success: true };
    } catch (error) {
      console.error('Failed to continue conversation:', error);
      return { success: false, error: 'Failed to continue conversation' };
    }
  });

  commandRegistry.register('sessions:get-output', async (sessionId: string, limit?: number) => {
    try {
      // Validate session exists
      const sessionValidation = validateSessionExists(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:get-output', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Performance optimization: Default to loading only recent outputs.
      // Left at the pre-fix value of 5000 for this PR; lowering risks
      // silently truncating long sessions on reopen because callers do
      // not yet pass a pagination-aware limit. Revisit when the
      // deprecated JSON / non-terminal output pipeline is deleted at
      // source in the L6 follow-up.
      const DEFAULT_OUTPUT_LIMIT = 5000;
      const outputLimit = limit || DEFAULT_OUTPUT_LIMIT;

      console.log(`[IPC] sessions:get-output called for session: ${sessionId} with limit: ${outputLimit}`);

      // Refresh git status when session is loaded/viewed
      const session = await sessionManager.getSession(sessionId);
      if (session && !session.archived) {
        gitStatusManager.refreshSessionGitStatus(sessionId, false).catch(error => {
          console.error(`[IPC] Failed to refresh git status for session ${sessionId}:`, error);
        });
      }

      // Always use session-based output retrieval
      const outputs = await sessionManager.getSessionOutputs(sessionId, outputLimit);
      console.log(`[IPC] Retrieved ${outputs.length} outputs for session ${sessionId}`);

      // Performance optimization: Process outputs in batches to avoid blocking
      const { formatJsonForOutputEnhanced } = await import('../utils/toolFormatter');
      const BATCH_SIZE = 100;
      const transformedOutputs = [];

      for (let i = 0; i < outputs.length; i += BATCH_SIZE) {
        const batch = outputs.slice(i, Math.min(i + BATCH_SIZE, outputs.length));

        const transformedBatch = batch.map(output => {
          if (output.type === 'json') {
            // Generate formatted output from JSON
            const outputText = formatJsonForOutputEnhanced(
              decodeBoundary(output.data, boundary.jsonObject),
            );
            if (outputText) {
              // Return as stdout for the Output view
              return {
                ...output,
                type: 'stdout' as const,
                data: outputText
              };
            }
            // If no output format can be generated, skip this JSON message
            return null;
          }
          // Pass through all other output types including 'error'
          return output;
        }).filter(Boolean);

        transformedOutputs.push(...transformedBatch);
      }
      return { success: true, data: transformedOutputs };
    } catch (error) {
      console.error('Failed to get session outputs:', error);
      return { success: false, error: 'Failed to get session outputs' };
    }
  });

  commandRegistry.register('sessions:get-conversation', async (sessionId: string) => {
    try {
      // Always use session-based conversation retrieval
      const messages = await sessionManager.getConversationMessages(sessionId);
      return { success: true, data: messages };
    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return { success: false, error: 'Failed to get conversation messages' };
    }
  });

  commandRegistry.register('sessions:get-conversation-messages', async (sessionId: string) => {
    try {
      // Always use session-based conversation retrieval
      const messages = await sessionManager.getConversationMessages(sessionId);
      return { success: true, data: messages };
    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return { success: false, error: 'Failed to get conversation messages' };
    }
  });

  commandRegistry.register(
    'sessions:get-conversation-message-count',
    async (sessionId: string) => {
      try {
        const count = sessionManager.getConversationMessageCount(sessionId);
        return { success: true, data: count };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // Panel-based handlers for Claude panels
  commandRegistry.register('panels:get-output', async (panelId: string, limit?: number) => {
    try {
      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:get-output', panelValidation);
        return createValidationError(panelValidation);
      }

      const outputLimit = limit && limit > 0 ? Math.min(limit, 10000) : undefined;
      console.log(`[IPC] panels:get-output called for panel: ${panelId} (session: ${panelValidation.sessionId}) with limit: ${outputLimit}`);
      
      if (!sessionManager.getPanelOutputs) {
        console.error('[IPC] Panel-based output methods not available on sessionManager');
        return { success: false, error: 'Panel-based output methods not available' };
      }
      
      const outputs = await sessionManager.getPanelOutputs(panelId, outputLimit);
      console.log(`[IPC] Returning ${outputs.length} outputs for panel ${panelId}`);
      return { success: true, data: outputs };
    } catch (error) {
      console.error('Failed to get panel outputs:', error);
      return { success: false, error: 'Failed to get panel outputs' };
    }
  });

  commandRegistry.register('panels:get-conversation-messages', async (panelId: string) => {
    try {
      if (!sessionManager.getPanelConversationMessages) {
        console.error('[IPC] Panel-based conversation methods not available on sessionManager');
        return { success: false, error: 'Panel-based conversation methods not available' };
      }

      const messages = await sessionManager.getPanelConversationMessages(panelId);
      // Ensure timestamps are in ISO format for proper sorting with JSON messages
      const messagesWithIsoTimestamps = messages.map(msg => ({
        ...msg,
        timestamp: msg.timestamp.includes('T') || msg.timestamp.includes('Z')
          ? msg.timestamp  // Already ISO format
          : msg.timestamp + 'Z'  // SQLite format, append Z for UTC
      }));
      return { success: true, data: messagesWithIsoTimestamps };
    } catch (error) {
      console.error('Failed to get panel conversation messages:', error);
      return { success: false, error: 'Failed to get panel conversation messages' };
    }
  });

  commandRegistry.register('panels:get-json-messages', async (panelId: string) => {
    try {
      console.log(`[IPC] panels:get-json-messages called for panel: ${panelId}`);

      if (!sessionManager.getPanelOutputs) {
        console.error('[IPC] Panel-based output methods not available on sessionManager');
        return { success: false, error: 'Panel-based output methods not available' };
      }

      // Get all outputs and filter for JSON messages only
      const outputs = await sessionManager.getPanelOutputs(panelId);
      const jsonMessages = outputs
        .filter(output => output.type === 'json')
        .map(output => {
          const timestamp = output.timestamp instanceof Date
            ? output.timestamp.toISOString()
            : output.timestamp;
          try {
            return {
              ...decodeBoundary(output.data, boundary.jsonObject),
              timestamp,
            };
          } catch {
            try {
              const serialized = decodeBoundary(output.data, boundary.string);
              return {
                ...decodeBoundary(JSON.parse(serialized), boundary.jsonObject),
                timestamp,
              };
            } catch {
              return { data: String(output.data), timestamp };
            }
          }
        });

      console.log(`[IPC] Returning ${jsonMessages.length} JSON messages for panel ${panelId}`);
      return { success: true, data: jsonMessages };
    } catch (error) {
      console.error('Failed to get panel JSON messages:', error);
      return { success: false, error: 'Failed to get panel JSON messages' };
    }
  });

  commandRegistry.register('panels:get-prompts', async (panelId: string) => {
    try {
      console.log(`[IPC] panels:get-prompts called for panel: ${panelId}`);
      
      // Get all conversation messages to find assistant responses
      const allMessages = databaseService.getPanelConversationMessages(panelId);
      
      // Build prompts with assistant response timestamps
      const prompts = allMessages
        .map((msg, index) => {
          if (msg.message_type === 'user') {
            // Find the next assistant message for completion timestamp
            const nextAssistantMsg = allMessages
              .slice(index + 1)
              .find(m => m.message_type === 'assistant');
            
            return {
              id: msg.id,
              session_id: msg.session_id,
              panel_id: panelId,
              prompt_text: msg.content,
              output_index: index,
              timestamp: msg.timestamp,
              // Use the assistant's response timestamp as completion
              completion_timestamp: nextAssistantMsg?.timestamp
            };
          }
          return null;
        })
        .filter(Boolean); // Remove nulls (assistant messages)
      
      console.log(`[IPC] Returning ${prompts.length} user prompts for panel ${panelId}`);
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get panel prompts:', error);
      return { success: false, error: 'Failed to get panel prompts' };
    }
  });

  // Generic panel input handlers that route to specific panel type handlers
  commandRegistry.register('panels:send-input', async (panelId: string, _input: string) => {
    try {
      console.log(`[IPC] panels:send-input called for panel: ${panelId}`);

      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:send-input', panelValidation);
        return createValidationError(panelValidation);
      }

      // Additional validation that the session is active
      const sessionValidation = validateSessionIsActive(panelValidation.sessionId!);
      if (!sessionValidation.valid) {
        logValidationFailure('panels:send-input session check', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get the panel to determine its type
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      console.log(`[IPC] Validated panel ${panelId} belongs to session ${panel.sessionId}`);

      // Route to appropriate panel type handler
      switch (panel.type) {
        case 'terminal':
          // Terminal panels don't have input handlers - they use runTerminalCommand
          return { success: false, error: 'Terminal panels use different input methods' };
        default:
          return { success: false, error: `Unsupported panel type: ${panel.type}` };
      }
    } catch (error) {
      console.error('Failed to send input to panel:', error);
      return { success: false, error: 'Failed to send input to panel' };
    }
  });

  commandRegistry.register('panels:continue', async (panelId: string, _input: string, _model?: string) => {
    try {
      console.log(`[IPC] panels:continue called for panel: ${panelId}`);

      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:continue', panelValidation);
        return createValidationError(panelValidation);
      }

      // Additional validation that the session is active
      const sessionValidation = validateSessionIsActive(panelValidation.sessionId!);
      if (!sessionValidation.valid) {
        logValidationFailure('panels:continue session check', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get the panel to determine its type
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      console.log(`[IPC] Validated panel ${panelId} belongs to session ${panel.sessionId}`);

      // Panel-based handlers removed - panels should not be used for AI operations
      return { success: false, error: `Panel type ${panel.type} does not support continue operation` };
    } catch (error) {
      console.error('Failed to continue panel conversation:', error);
      return { success: false, error: 'Failed to continue panel conversation' };
    }
  });

  commandRegistry.register('sessions:generate-compacted-context', async (sessionId: string) => {
    try {
      console.log('[IPC] sessions:generate-compacted-context called for sessionId:', sessionId);

      // Get all the data we need for compaction
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Get the database session for the compactor (it expects the database model)
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found in database' };
      }

      // Always use session-based data retrieval
      const conversationMessages = await sessionManager.getConversationMessages(sessionId);
      const promptMarkers = databaseService.getPromptMarkers(sessionId);
      const executionDiffs = databaseService.getExecutionDiffs(sessionId);
      const sessionOutputs = await sessionManager.getSessionOutputs(sessionId);

      // Import the compactor utility
      const { ProgrammaticCompactor } = await import('../utils/contextCompactor');
      const compactor = new ProgrammaticCompactor(databaseService);

      // Generate the compacted summary
      const summary = await compactor.generateSummary(sessionId, {
        session: dbSession,
        conversationMessages,
        promptMarkers,
        executionDiffs,
        sessionOutputs: sessionOutputs
      });

      // Set flag to skip --resume on the next execution
      console.log('[IPC] Setting skip_continue_next flag to true for session:', sessionId);
      await sessionManager.updateSession(sessionId, { skip_continue_next: true });

      // Verify the flag was set
      const updatedSession = databaseService.getSession(sessionId);
      console.log('[IPC] Verified skip_continue_next flag after update:', {
        raw_value: updatedSession?.skip_continue_next,
        is_truthy: !!updatedSession?.skip_continue_next
      });
      console.log('[IPC] Generated compacted context summary and set skip_continue_next flag');

      // Add a system message to the session outputs so it appears in rich output view
      const contextCompactionMessage = {
        type: 'system',
        subtype: 'context_compacted',
        timestamp: new Date().toISOString(),
        summary: summary,
        message: 'Context has been compacted. You can continue chatting - your next message will automatically include the context summary above.'
      };

      await sessionManager.addSessionOutput(sessionId, {
        type: 'json',
        data: contextCompactionMessage,
        timestamp: new Date()
      });

      return { success: true, data: { summary } };
    } catch (error) {
      console.error('Failed to generate compacted context:', error);
      return { success: false, error: 'Failed to generate compacted context' };
    }
  });

  commandRegistry.register('sessions:get-json-messages', async (sessionId: string) => {
    try {
      console.log(`[IPC] sessions:get-json-messages called for session: ${sessionId}`);

      // Always use session-based output retrieval
      const outputs = await sessionManager.getSessionOutputs(sessionId);
      console.log(`[IPC] Retrieved ${outputs.length} total outputs for session ${sessionId}`);

      // Helper function to check if stdout/stderr contains git operation output
      const isGitOperation = (data: string): boolean => {
        return data.includes('🔄 GIT OPERATION') ||
               data.includes('Successfully rebased') ||
               data.includes('Successfully squashed and rebased') ||
               data.includes('Successfully pulled latest changes') ||
               data.includes('Successfully pushed changes to remote') ||
               data.includes('Rebase failed:') ||
               data.includes('Squash and rebase failed:') ||
               data.includes('Pull failed:') ||
               data.includes('Push failed:') ||
               data.includes('Aborted rebase successfully');
      };

      // Filter to JSON messages, error messages, and git operation stdout/stderr messages
      const jsonMessages = outputs
        .filter(output => {
          if (output.type === 'json' || output.type === 'error') return true;
          if (output.type !== 'stdout' && output.type !== 'stderr') return false;
          try {
            return isGitOperation(decodeBoundary(output.data, boundary.string));
          } catch {
            return false;
          }
        })
        .map(output => {
          if (output.type === 'error') {
            // Transform error outputs to a format that RichOutputView can handle
            const errorData = decodeBoundary(output.data, boundary.object({
              error: boundary.string,
              details: boundary.optional(boundary.string),
            }));
            return {
              type: 'system',
              subtype: 'error',
              timestamp: output.timestamp.toISOString(),
              error: errorData.error,
              details: errorData.details,
              message: `${errorData.error}${errorData.details ? '\n\n' + errorData.details : ''}`
            };
          } else if (output.type === 'stdout' || output.type === 'stderr') {
            // Transform git operation stdout/stderr to system messages that RichOutputView can display
            const outputText = decodeBoundary(output.data, boundary.string);
            const isError = output.type === 'stderr' || outputText.includes('failed:') || outputText.includes('✗');
            return {
              type: 'system',
              subtype: isError ? 'git_error' : 'git_operation',
              timestamp: output.timestamp.toISOString(),
              message: outputText,
              // Add raw data for processing
              raw_output: outputText
            };
          } else {
            // Regular JSON messages - safe to spread since we know it's a Record
            const jsonData = decodeBoundary(output.data, boundary.jsonObject);
            return {
              ...jsonData,
              timestamp: output.timestamp.toISOString()
            };
          }
        });

      console.log(`[IPC] Found ${jsonMessages.length} messages (including git operations) for session ${sessionId}`);
      return { success: true, data: jsonMessages };
    } catch (error) {
      console.error('Failed to get JSON messages:', error);
      return { success: false, error: 'Failed to get JSON messages' };
    }
  });

  commandRegistry.register('sessions:mark-viewed', async (sessionId: string) => {
    try {
      await sessionManager.markSessionAsViewed(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to mark session as viewed:', error);
      return { success: false, error: 'Failed to mark session as viewed' };
    }
  });

  commandRegistry.register('sessions:stop', async (sessionId: string) => {
    try {
      // Use session-based stop
      console.log(`[IPC] Stopping session ${sessionId} via session-based method`);
      await claudeCodeManager.stopSession(sessionId);

      const timestamp = new Date();
      const cancellationMessage = {
        type: 'session',
        data: {
          status: 'cancelled',
          message: 'Cancelled by user',
          source: 'user'
        }
      };

      try {
        sessionManager.addSessionOutput(sessionId, {
          type: 'json',
          data: cancellationMessage,
          timestamp
        });
      } catch (loggingError) {
        console.warn('[IPC] Failed to record cancellation message for session stop:', loggingError);
      }

      sessionManager.stopSession(sessionId);

      return { success: true };
    } catch (error) {
      console.error('Failed to stop session:', error);
      return { success: false, error: 'Failed to stop session' };
    }
  });

  commandRegistry.register('sessions:generate-name', async (prompt: string) => {
    try {
      const name = await worktreeNameGenerator.generateWorktreeName(prompt);
      return { success: true, data: name };
    } catch (error) {
      console.error('Failed to generate session name:', error);
      return { success: false, error: 'Failed to generate session name' };
    }
  });

  commandRegistry.register('sessions:rename', async (sessionId: string, newName: string) => {
    try {
      // Update the session name in the database
      const updatedSession = databaseService.updateSession(sessionId, { name: newName });
      if (!updatedSession) {
        return { success: false, error: 'Session not found' };
      }

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.name = newName;
        sessionManager.emit('session-updated', session);
      }

      return { success: true, data: updatedSession };
    } catch (error) {
      console.error('Failed to rename session:', error);
      return { success: false, error: 'Failed to rename session' };
    }
  });

  commandRegistry.register('sessions:toggle-favorite', async (sessionId: string) => {
    try {
      console.log('[IPC] sessions:toggle-favorite called for sessionId:', sessionId);
      
      // Get current session to check current favorite status
      const currentSession = databaseService.getSession(sessionId);
      if (!currentSession) {
        console.error('[IPC] Session not found in database:', sessionId);
        return { success: false, error: 'Session not found' };
      }
      
      console.log('[IPC] Current session favorite status:', currentSession.is_favorite);

      // Toggle the favorite status
      const newFavoriteStatus = !currentSession.is_favorite;
      console.log('[IPC] Toggling favorite status to:', newFavoriteStatus);
      
      const updatedSession = databaseService.updateSession(sessionId, {
        is_favorite: newFavoriteStatus,
        favorite_pinned_at: newFavoriteStatus ? 'CURRENT_TIMESTAMP' : null,
      });
      if (!updatedSession) {
        console.error('[IPC] Failed to update session in database');
        return { success: false, error: 'Failed to update session' };
      }
      
      console.log('[IPC] Database updated successfully. Updated session:', updatedSession.is_favorite);

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.isFavorite = newFavoriteStatus;
        session.favoritePinnedAt = updatedSession.favorite_pinned_at ?? undefined;
        console.log('[IPC] Emitting session-updated event with favorite status:', session.isFavorite);
        sessionManager.emit('session-updated', session);
      } else {
        console.warn('[IPC] Session not found in session manager:', sessionId);
      }

      return { success: true, data: { isFavorite: newFavoriteStatus, favoritePinnedAt: updatedSession.favorite_pinned_at } };
    } catch (error) {
      console.error('Failed to toggle favorite status:', error);
      if (error instanceof Error) {
        console.error('Error stack:', error.stack);
      }
      return { success: false, error: 'Failed to toggle favorite status' };
    }
  });

  commandRegistry.register('sessions:reorder', async (sessionOrders: Array<{ id: string; displayOrder: number }>) => {
    try {
      databaseService.reorderSessions(sessionOrders);
      return { success: true };
    } catch (error) {
      console.error('Failed to reorder sessions:', error);
      return { success: false, error: 'Failed to reorder sessions' };
    }
  });

  // Save images for a session
  commandRegistry.register('sessions:save-images', async (sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>) => {
    try {
      // For pending sessions (those created before the actual session), we still need to save the files
      // Check if this is a pending session ID (starts with 'pending_')
      const isPendingSession = sessionId.startsWith('pending_');
      
      if (!isPendingSession) {
        // For real sessions, verify it exists
        const session = await sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
      }

      // Create images directory in PANE_DIR/artifacts/{sessionId}
      const imagesDir = getAppSubdirectory('artifacts', sessionId);
      if (!existsSync(imagesDir)) {
        await fs.mkdir(imagesDir, { recursive: true });
      }

      const savedPaths: string[] = [];
      
      for (const image of images) {
        // Generate unique filename
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const extension = image.type.split('/')[1] || 'png';
        const filename = `${timestamp}_${randomStr}.${extension}`;
        const filePath = path.join(imagesDir, filename);

        // Extract base64 data
        const base64Data = image.dataUrl.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        // Save the image
        await fs.writeFile(filePath, buffer);
        
        // Return the absolute path that Claude Code can access
        savedPaths.push(filePath);
      }

      return savedPaths;
    } catch (error) {
      console.error('Failed to save images:', error);
      throw error;
    }
  });

  // Save large text for a session
  commandRegistry.register('sessions:save-large-text', async (sessionId: string, text: string) => {
    try {
      // For pending sessions (those created before the actual session), we still need to save the files
      // Check if this is a pending session ID (starts with 'pending_')
      const isPendingSession = sessionId.startsWith('pending_');
      
      if (!isPendingSession) {
        // For real sessions, verify it exists
        const session = await sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
      }

      // Create text directory in PANE_DIR/artifacts/{sessionId}
      const textDir = getAppSubdirectory('artifacts', sessionId);
      if (!existsSync(textDir)) {
        await fs.mkdir(textDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 9);
      const filename = `text_${timestamp}_${randomStr}.txt`;
      const filePath = path.join(textDir, filename);

      // Save the text content
      await fs.writeFile(filePath, text, 'utf8');
      
      console.log(`[Large Text] Saved ${text.length} characters to ${filePath}`);
      
      // Return the absolute path that Claude Code can access
      return filePath;
    } catch (error) {
      console.error('Failed to save large text:', error);
      throw error;
    }
  });

  commandRegistry.register('sessions:restore', async (sessionId: string) => {
    try {
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession || !dbSession.archived) {
        return { success: false, error: 'Session not found or already active' };
      }

      // Archiving removes the worktree directory on disk (see the archive
      // cleanup callback above), so restoring only the `archived` flag leaves
      // `worktree_path` dangling and every panel spawn fails with ENOENT.
      // Recreate the worktree before un-archiving; if that fails, leave the
      // session archived and report why.
      if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo && dbSession.worktree_ownership !== 'external' && !existsSync(dbSession.worktree_path)) {
        const project = databaseService.getProject(dbSession.project_id);
        const ctx = project ? sessionManager.getProjectContextByProjectId(dbSession.project_id) : null;
        if (!project || !ctx) {
          return { success: false, error: 'Cannot restore session: its project is no longer available' };
        }
        try {
          console.log(`[WorktreeAudit] create_requested source="session-restore" sessionId=${JSON.stringify(sessionId)} projectId=${dbSession.project_id} worktreeName=${JSON.stringify(dbSession.worktree_name)} worktreePath=${JSON.stringify(dbSession.worktree_path)}`);
          // `createWorktree` reuses the session's branch when it still exists and
          // otherwise recreates it from the recorded base branch.
          const { worktreePath } = await worktreeManager.createWorktree(
            project.path,
            dbSession.worktree_name,
            undefined,
            dbSession.base_branch || undefined,
            project.worktree_folder || undefined,
            ctx.pathResolver,
            ctx.commandRunner,
          );
          if (worktreePath !== dbSession.worktree_path) {
            databaseService.updateSession(sessionId, { worktree_path: worktreePath });
          }
        } catch (worktreeError) {
          const message = worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
          console.error(`[Session IPC] Failed to recreate worktree while restoring session ${sessionId}:`, worktreeError);
          return { success: false, error: `Failed to recreate worktree for session: ${message}` };
        }
      }

      const restored = databaseService.restoreSession(sessionId);
      if (!restored) {
        return { success: false, error: 'Session not found or already active' };
      }
      // Reload sessions so the frontend store updates
      const allSessions = sessionManager.getAllSessions();
      sessionManager.emit('sessions-loaded', allSessions);
      return { success: true };
    } catch (error) {
      console.error('Failed to restore session:', error);
      return { success: false, error: 'Failed to restore session' };
    }
  });

  // Debug handler to check table structure
  ipcMain.handle('debug:get-table-structure', async (_event, tableName: 'folders' | 'sessions') => {
    try {
      const structure = databaseService.getTableStructure(tableName);
      return { success: true, data: structure };
    } catch (error) {
      console.error('Failed to get table structure:', error);
      return { success: false, error: 'Failed to get table structure' };
    }
  });

  // Archive progress handler
  ipcMain.handle('archive:get-progress', async () => {
    try {
      if (!archiveProgressManager) {
        return { success: true, data: { tasks: [], activeCount: 0, totalCount: 0 } };
      }
      
      const tasks = archiveProgressManager.getActiveTasks();
      const activeCount = tasks.filter((t: SerializedArchiveTask) => 
        t.status !== 'completed' && t.status !== 'failed'
      ).length;
      
      return { 
        success: true, 
        data: { 
          tasks, 
          activeCount, 
          totalCount: tasks.length 
        } 
      };
    } catch (error) {
      console.error('Failed to get archive progress:', error);
      return { success: false, error: 'Failed to get archive progress' };
    }
  });

  // Session statistics handler
  commandRegistry.register('sessions:get-statistics', async (sessionId: string) => {
    try {
      console.log('[IPC] sessions:get-statistics called for sessionId:', sessionId);
      
      // Get session details
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Calculate session duration
      const startTime = new Date(session.createdAt).getTime();
      const endTime = session.status === 'stopped'
        ? (session.lastActivity ? new Date(session.lastActivity).getTime() : Date.now())
        : Date.now();
      const duration = endTime - startTime;

      // Get token usage from session_outputs with type 'json'
      const tokenUsageData = databaseService.getSessionTokenUsage(sessionId);
      
      // Get execution diffs for file changes
      const executionDiffs = databaseService.getExecutionDiffs(sessionId);
      
      // Calculate file statistics
      let totalLinesAdded = 0;
      let totalLinesDeleted = 0;
      const filesModified = new Set<string>();
      
      executionDiffs.forEach(diff => {
        totalLinesAdded += diff.stats_additions || 0;
        totalLinesDeleted += diff.stats_deletions || 0;
        
        // Track unique files
        if (diff.files_changed) {
          try {
            const files = Array.isArray(diff.files_changed) 
              ? diff.files_changed 
              : JSON.parse(diff.files_changed);
            files.forEach((file: string) => filesModified.add(file));
          } catch {
            // Ignore parse errors
          }
        }
      });

      // Always use session-based methods for statistics
      const promptMarkers = databaseService.getPromptMarkers(sessionId);
      const messageCount = databaseService.getConversationMessageCount(sessionId);
      
      // Get session outputs count by type
      const outputCounts = databaseService.getSessionOutputCounts(sessionId);
      
      // Get tool usage statistics
      const toolUsage = databaseService.getSessionToolUsage(sessionId);

      const statistics = {
        session: {
          id: session.id,
          name: session.name,
          status: session.status,
          // Model is now managed at panel level, not session level
          createdAt: session.createdAt,
          updatedAt: session.lastActivity || session.createdAt,
          duration: duration,
          worktreePath: session.worktreePath,
          branch: session.baseBranch || 'main'
        },
        tokens: {
          totalInputTokens: tokenUsageData.totalInputTokens,
          totalOutputTokens: tokenUsageData.totalOutputTokens,
          totalCacheReadTokens: tokenUsageData.totalCacheReadTokens,
          totalCacheCreationTokens: tokenUsageData.totalCacheCreationTokens,
          messageCount: tokenUsageData.messageCount
        },
        files: {
          totalFilesChanged: filesModified.size,
          totalLinesAdded,
          totalLinesDeleted,
          filesModified: Array.from(filesModified),
          executionCount: executionDiffs.length
        },
        activity: {
          promptCount: promptMarkers.length,
          messageCount: messageCount,
          outputCounts: outputCounts,
          lastActivity: session.lastActivity || session.createdAt
        },
        toolUsage: {
          tools: toolUsage.tools,
          totalToolCalls: toolUsage.totalToolCalls
        }
      };

      return { success: true, data: statistics };
    } catch (error) {
      console.error('Failed to get session statistics:', error);
      return { success: false, error: 'Failed to get session statistics' };
    }
  });

  commandRegistry.register(ACTIVE_SESSION_HINT_CHANNEL, async (sessionId: string | null) => {
    try {
      // Notify GitStatusManager about the active session change
      gitStatusManager.setActiveSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to set active session:', error);
      return { success: false, error: 'Failed to set active session' };
    }
  });

  // Set active session for smart git status polling. In remote mode the daemon
  // needs this same visibility hint so it can prioritize the visible session.
  ipcMain.handle(ACTIVE_SESSION_HINT_CHANNEL, async (_event, sessionId: string | null) => {
    return remotePaneClientController.invoke(
      ACTIVE_SESSION_HINT_CHANNEL,
      [sessionId],
      () => commandRegistry.invoke(ACTIVE_SESSION_HINT_CHANNEL, [sessionId]),
    );
  });

  // Resume session handlers
  commandRegistry.register('sessions:get-resumable', async () => {
    try {
      const activeProject = sessionManager.getActiveProject();
      if (!activeProject) {
        return { success: true, data: [] };
      }
      const resumable = sessionManager.getResumableSessions(activeProject.id);
      return { success: true, data: resumable };
    } catch (error) {
      console.error('Failed to get resumable sessions:', error);
      return { success: false, error: 'Failed to get resumable sessions' };
    }
  });

  commandRegistry.register('sessions:resume-interrupted', async (sessionIds: string[]) => {
    try {
      await sessionManager.resumeInterruptedSessions(sessionIds);
      return { success: true };
    } catch (error) {
      console.error('Failed to resume interrupted sessions:', error);
      return { success: false, error: 'Failed to resume interrupted sessions' };
    }
  });

  commandRegistry.register('sessions:dismiss-interrupted', async (sessionIds: string[]) => {
    try {
      await sessionManager.dismissInterruptedSessions(sessionIds);
      return { success: true };
    } catch (error) {
      console.error('Failed to dismiss interrupted sessions:', error);
      return { success: false, error: 'Failed to dismiss interrupted sessions' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_SESSION_CHANNELS);
  commandRegistry.bindChannels(ipcMain, DAEMON_SESSION_PANEL_CHANNELS);

} 
