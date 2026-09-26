import { getPaneEventSink } from './core/runtime';
import type { AppServices } from './ipc/types';
import type { VersionInfo } from './services/versionChecker';
import { addSessionLog } from './services/session-logs';
import { panelManager } from './services/panelManager';
import { terminalPanelManager } from './services/terminalPanelManager';
import {
  validateEventContext,
  validatePanelEventContext,
  logValidationFailure
} from './utils/sessionValidation';
import type { GitCommit } from './services/gitDiffManager';
import type { Project } from './database/models';
import type { GitStatus } from './types/session';
import { resourceMonitorService } from './services/resourceMonitorService';
import type { ResourceSnapshot } from '../../shared/types/resourceMonitor';
import type { PaneEventArgument } from './core/eventSink';
import type { AgentState } from '../../shared/types/agentStatus';

function isArchivedSessionOutputValidation(validation: { error?: string; sessionId?: string }): boolean {
  return Boolean(
    validation.sessionId &&
    validation.error === `Session ${validation.sessionId} is archived`
  );
}

function sendRendererEvent(channel: string, ...args: PaneEventArgument[]): void {
  try {
    getPaneEventSink().send(channel, ...args);
  } catch (error) {
    console.error(`[Main] Failed to send ${channel} event:`, error);
  }
}

export function setupEventListeners(services: AppServices): void {
  const {
    sessionManager,
    claudeCodeManager,
    executionTracker,
    runCommandManager,
    gitDiffManager,
    gitStatusManager,
    worktreeManager,
    archiveProgressManager,
    analyticsManager,
    orchestrationSessionManager,
  } = services;

  orchestrationSessionManager?.on('changed', (change: { sessionId: string; kind: string; selectionChanged?: boolean }) => {
    sendRendererEvent('orchestration-sessions:changed', change);
  });
  orchestrationSessionManager?.on('overview-updated', (change: { panelId: string; state: string }) => {
    sendRendererEvent('orchestration-sessions:overview-updated', change);
  });
  terminalPanelManager.on('agent-status', (change: { panelId: string; state: AgentState }) => {
    void orchestrationSessionManager?.notifyLiveActivity(change.panelId, change.state).catch(error => {
      console.error('[Sessions] Failed to persist live activity:', error);
    });
  });

  async function appendSessionSummary(sessionId: string, failed: boolean): Promise<void> {
    try {
      const session = sessionManager.getSession(sessionId);
      if (session && session.worktreePath) {
        const timestamp = new Date().toLocaleTimeString();
        let commitInfo = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m${failed ? '\x1b[41m' : '\x1b[44m'}\x1b[37m 📊 SESSION SUMMARY${failed ? ' (ERROR)' : ''} \x1b[0m\r\n\r\n`;

        // Get project context for this session
        const summaryCtx = sessionManager.getProjectContext(session.id);
        if (!summaryCtx) {
          console.error(`[Events] No project context for session ${session.id}`);
          return;
        }

        // Check for uncommitted changes
        const statusOutput = (await summaryCtx.commandRunner.execAsync('git status --porcelain', session.worktreePath)).stdout.trim();

        if (statusOutput) {
          const uncommittedFiles = statusOutput.split('\n').length;
          commitInfo += `\x1b[1m\x1b[33m⚠️  Uncommitted Changes:\x1b[0m ${uncommittedFiles} file${uncommittedFiles > 1 ? 's' : ''}\r\n`;

          // Show first few uncommitted files
          const filesToShow = statusOutput.split('\n').slice(0, 5);
          filesToShow.forEach(file => {
            const [status, ...nameParts] = file.trim().split(/\s+/);
            const fileName = nameParts.join(' ');
            commitInfo += `   \x1b[2m${status}\x1b[0m ${fileName}\r\n`;
          });

          if (uncommittedFiles > 5) {
            commitInfo += `   \x1b[2m... and ${uncommittedFiles - 5} more\x1b[0m\r\n`;
          }
          commitInfo += '\r\n';
        }

        // Get commit history for this branch
        const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, summaryCtx);

        let commits: GitCommit[] = [];
        try {
          commits = await gitDiffManager.getCommitHistory(session.worktreePath, 10, comparisonBranch, summaryCtx.commandRunner);
        } catch (error) {
          console.error(`[Events] Error getting commit history:`, error);
        }

        if (commits.length > 0) {
          commitInfo += `\x1b[1m\x1b[32m📝 Commits ${failed ? 'before error' : 'in this session'}:\x1b[0m\r\n`;
          commits.forEach((commit, index) => {
            const shortHash = commit.hash.substring(0, 7);
            const date = commit.date.toLocaleString();
            const stats = commit.stats;
            commitInfo += `\r\n  \x1b[1m${index + 1}.\x1b[0m \x1b[33m${shortHash}\x1b[0m - ${commit.message}\r\n`;
            commitInfo += `     \x1b[2mby ${commit.author} on ${date}\x1b[0m\r\n`;
            if (stats.filesChanged > 0) {
              commitInfo += `     \x1b[32m+${stats.additions}\x1b[0m \x1b[31m-${stats.deletions}\x1b[0m (${stats.filesChanged} file${stats.filesChanged > 1 ? 's' : ''})\r\n`;
            }
          });
        } else if (!statusOutput) {
          commitInfo += `\x1b[2mNo commits were made ${failed ? 'before the error' : 'in this session'}.\x1b[0m\r\n`;
        }

        commitInfo += `\r\n\x1b[2m─────────────────────────────────────────\x1b[0m\r\n`;

        // Add this summary to the session output
        sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: commitInfo,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error(`Failed to generate session summary for ${sessionId}:`, error);
    }
  }

  // Wire up analytics manager to panel managers
  if (analyticsManager) {
    panelManager.setAnalyticsManager(analyticsManager);
    terminalPanelManager.setAnalyticsManager(analyticsManager);
  }

  // Bridge resource monitor events to renderer
  resourceMonitorService.on('resource-update', (snapshot: ResourceSnapshot) => {
    sendRendererEvent('resource-monitor:update', snapshot);
  });









  // Listen to sessionManager events and broadcast to renderer
  sessionManager.on('session-created', async (session) => {
    sendRendererEvent('session:created', session);

    if (session.createDefaultTerminalOnCreate !== false) {
      try {
        await panelManager.createPanel({
          sessionId: session.id,
          type: 'terminal',
          title: 'Terminal',
        });
      } catch (error) {
        console.error(`[Events] Failed to auto-create terminal panel for session ${session.id}:`, error);
      }
    }

    // Refresh git status for newly created session (non-blocking for UI responsiveness)
    if (session.id && !session.archived) {
      // Add a small delay for newly created sessions to prevent overwhelming git operations
      // when multiple sessions are created rapidly
      setTimeout(() => {
        gitStatusManager.refreshSessionGitStatus(session.id, false).catch(error => {
          console.error(`[Main] Failed to refresh git status for new session ${session.id}:`, error);
        });
      }, 1000); // 1 second delay to allow session creation UI to complete
    }
  });

  sessionManager.on('session-updated', (session) => {
    console.log(`[Main] session-updated event received for ${session.id} with status ${session.status}`);
    console.log(`[Main] Sending session:updated to renderer for ${session.id}`);
    sendRendererEvent('session:updated', session);
  });

  sessionManager.on('session-deleted', (session) => {
    sendRendererEvent('session:deleted', session);
  });

  sessionManager.on('sessions-loaded', (sessions) => {
    sendRendererEvent('sessions:loaded', sessions);
  });

  sessionManager.on('zombie-processes-detected', (data) => {
    console.error('[Main] Zombie processes detected:', data);
    sendRendererEvent('zombie-processes-detected', data);
  });

  sessionManager.on('session-output', (output) => {
    // Validate the output has valid session context
    const validation = validateEventContext(output);
    if (!validation.valid) {
      if (isArchivedSessionOutputValidation(validation)) {
        console.log(`[Validation] Dropping late session-output for archived session ${validation.sessionId}`);
        return;
      }

      logValidationFailure('session-output event', validation);
      return; // Don't broadcast invalid events
    }

    sendRendererEvent('session:output', output);
  });

  sessionManager.on('session-output-available', (info) => {
    sendRendererEvent('session:output-available', info);
  });

  // Listen for new prompts being added to panels
  sessionManager.on('panel-prompt-added', (data) => {
    sendRendererEvent('panel:prompt-added', data);
  });

  // Listen for assistant responses being added to panels
  sessionManager.on('panel-response-added', (data) => {
    console.log('[Events] Received panel-response-added event for panel:', data.panelId);
    console.log('[Events] Sending panel:response-added to renderer for panel:', data.panelId);
    sendRendererEvent('panel:response-added', data);
  });

  // Listen for project update events from sessionManager (since it extends EventEmitter)
  sessionManager.on('project:updated', (project: Project) => {
    console.log(`[Main] Project updated: ${project.id}`);
    sendRendererEvent('project:updated', project);
  });

  // Listen to claudeCodeManager events
  claudeCodeManager.on('output', (output: {
    panelId: string;
    sessionId: string;
    type: 'json' | 'stdout' | 'stderr';
    data: unknown;
    timestamp: Date
  }) => {
    // Validate the output has valid context
    const validation = output.panelId
      ? validatePanelEventContext(output, output.panelId, output.sessionId)
      : validateEventContext(output, output.sessionId);

    if (!validation.valid) {
      logValidationFailure('claudeCodeManager output event', validation);
      return; // Don't process invalid events
    }

    // Persist output: let ClaudePanelManager handle panel-based storage to avoid duplicates
    if (!output.panelId) {
      console.log(`[Events] Saving Claude output for session ${output.sessionId} (legacy mode)`);

      sessionManager.addSessionOutput(output.sessionId, {
        type: output.type,
        data: output.data,
        timestamp: output.timestamp
      });
    }

    // Send real-time updates to renderer
    // Always send the output as-is, without formatting
    // JSON messages will be formatted when loaded from the database via sessions:get-output
    // This prevents duplicate formatted messages in the Output view
    sendRendererEvent('session:output', output);
  });

  claudeCodeManager.on('spawned', async ({ panelId, sessionId }: { panelId?: string; sessionId: string }) => {
    // Validate the event context
    const validation = panelId
      ? validatePanelEventContext({ panelId, sessionId }, panelId, sessionId)
      : validateEventContext({ sessionId }, sessionId);

    if (!validation.valid) {
      logValidationFailure('claudeCodeManager spawned event', validation);
      return; // Don't process invalid events
    }

    // Add a small delay to ensure the session is fully initialized
    await new Promise(resolve => setTimeout(resolve, 100));

    await sessionManager.updateSession(sessionId, {
      status: 'running',
      run_started_at: 'CURRENT_TIMESTAMP'
    });

    // Start execution tracking
    try {
      const session = await sessionManager.getSession(sessionId);
      if (session && session.worktreePath) {
        // Get the latest prompt from prompt markers or use the session prompt
        const promptMarkers = sessionManager.getPromptMarkers(sessionId);
        const latestPrompt = promptMarkers.length > 0
          ? promptMarkers[promptMarkers.length - 1].prompt_text
          : session.prompt;

        await executionTracker.startExecution(sessionId, session.worktreePath, undefined, latestPrompt);

        // NOTE: Run commands are NOT started automatically when Claude spawns
        // They should only run when the user clicks the play button
      }
    } catch (error) {
      console.error(`Failed to start execution tracking for session ${sessionId}:`, error);
    }
  });

  claudeCodeManager.on('exit', async ({ panelId, sessionId }: { panelId?: string; sessionId: string; exitCode: number; signal: string }) => {
    const validation = panelId
      ? validatePanelEventContext({ panelId, sessionId }, panelId, sessionId)
      : validateEventContext({ sessionId }, sessionId);

    if (!validation.valid) {
      logValidationFailure('claudeCodeManager exit event', validation);
      return;
    }

    // Refresh git status after Claude exits, as it may have made commits
    // Also invalidate PR cache since Claude may have pushed/created PRs
    try {
      const project = sessionManager.getProjectForSession(sessionId);
      if (project?.path) {
        gitStatusManager.invalidatePrCache(project.path);
      }
      await gitStatusManager.refreshSessionGitStatus(sessionId);
    } catch (error) {
      console.error(`Failed to refresh git status for session ${sessionId} after exit:`, error);
    }

    await appendSessionSummary(sessionId, false);
  });

  claudeCodeManager.on('error', async ({ panelId, sessionId, error }: { panelId?: string; sessionId: string; error: string }) => {
    // Validate the event context
    const validation = panelId
      ? validatePanelEventContext({ panelId, sessionId }, panelId, sessionId)
      : validateEventContext({ sessionId }, sessionId);

    if (!validation.valid) {
      logValidationFailure('claudeCodeManager error event', validation);
      return; // Don't process invalid events
    }

    console.log(`Session ${sessionId} encountered an error: ${error}`);
    await sessionManager.updateSession(sessionId, { status: 'error', error });

    // Stop run commands on error
    try {
      await runCommandManager.stopRunCommands(sessionId);
    } catch (stopError) {
      console.error(`Failed to stop run commands for session ${sessionId}:`, stopError);
    }

    // Cancel execution tracking on error
    try {
      if (executionTracker.isTracking(sessionId)) {
        executionTracker.cancelExecution(sessionId);
      }
    } catch (trackingError) {
      console.error(`Failed to cancel execution tracking for session ${sessionId}:`, trackingError);
    }

    await appendSessionSummary(sessionId, true);
  });

  // Listen to terminal output events (independent terminal, not run scripts)
  sessionManager.on('terminal-output', (output) => {
    // Broadcast terminal output to renderer
    sendRendererEvent('terminal:output', output);
  });

  // Listen to run command manager events (these should go to logs, not terminal)
  runCommandManager.on('output', (output) => {
    // Send run command output to logs
    if (output.sessionId && output.data) {
      // Split by lines and add to logs
      const lines = output.data.split('\n').filter((line: string) => line.trim());
      lines.forEach((line: string) => {
        addSessionLog(output.sessionId, 'info', line, 'RunCommand');
      });
    }
  });

  runCommandManager.on('error', (error) => {
    console.error(`Run command error for session ${error.sessionId}:`, error.error);
    // Add error to logs
    if (error.sessionId) {
      addSessionLog(error.sessionId, 'error', `${error.displayName}: ${error.error}`, 'RunCommand');
    }
  });

  runCommandManager.on('exit', (info) => {
    console.log(`Run command exited: ${info.displayName}, exitCode: ${info.exitCode}`);
    // Add exit info to logs
    if (info.sessionId && info.exitCode !== 0) {
      addSessionLog(info.sessionId, 'warn', `${info.displayName} exited with code ${info.exitCode}`, 'RunCommand');
    }
  });

  runCommandManager.on('zombie-processes-detected', (data) => {
    console.error('[Main] Zombie processes detected from run command:', data);
    sendRendererEvent('zombie-processes-detected', data);
  });

  // Listen for version update events
  process.on('version-update-available', (versionInfo: VersionInfo) => {
    // Only send to renderer for custom dialog - no native dialogs
    sendRendererEvent('version:update-available', versionInfo);
  });

  // Listen to gitStatusManager events and broadcast to renderer
  // Only broadcast for active sessions or recent updates to reduce EventEmitter load
  gitStatusManager.on('git-status-updated', (sessionId: string, gitStatus: GitStatus) => {
    sendRendererEvent('git-status-updated', { sessionId, gitStatus });
  });

  // Listen for git status loading events
  gitStatusManager.on('git-status-loading', (sessionId: string) => {
    sendRendererEvent('git-status-loading', { sessionId });
  });

  // Listen for archive progress events
  if (archiveProgressManager) {
    archiveProgressManager.on('archive-progress', (progress) => {
      sendRendererEvent('archive:progress', progress);
    });
  }
} 
