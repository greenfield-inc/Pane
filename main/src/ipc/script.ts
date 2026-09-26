import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { getShellPath, findExecutableInPath } from '../utils/shellPath';
import { logsManager } from '../services/panels/logPanel/logsManager';
import { panelManager } from '../services/panelManager';
import { exec, type ExecException } from 'child_process';
import { scriptExecutionTracker } from '../services/scriptExecutionTracker';

const DAEMON_SCRIPT_CHANNELS = [
  'sessions:has-run-script',
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

export function registerScriptHandlers(
  ipcMain: IpcMain,
  { sessionManager }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  // Script execution handlers
  commandRegistry.register('sessions:has-run-script', async (sessionId: string) => {
    try {
      const runScript = sessionManager.getProjectRunScript(sessionId);
      return { success: true, data: !!runScript };
    } catch (error) {
      console.error('Failed to check run script:', error);
      return { success: false, error: 'Failed to check run script' };
    }
  });

  commandRegistry.register('sessions:run-script', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const commands = sessionManager.getProjectRunScript(sessionId);
      if (!commands) {
        return { success: false, error: 'No run script configured for this project' };
      }

      // Check if there's already a running script (any type) and stop it
      const runningScript = scriptExecutionTracker.getRunningScript();
      if (runningScript) {
        console.log(`[Script] Stopping currently running ${runningScript.type} script for ${runningScript.type}:${runningScript.id} before starting new script for session ${sessionId}`);

        // Mark the old script as closing
        scriptExecutionTracker.markClosing(runningScript.type, runningScript.id);

        // Stop the script based on its type
        if (runningScript.type === 'session') {
          console.log('[Script] Stopping session script via logs panel');
          // Find and stop the logs panel for this session
          const sessionScriptId = decodeBoundary(runningScript.id, boundary.string);
          const panels = await panelManager.getPanelsForSession(sessionScriptId);
          const logsPanel = panels?.find((p: { type: string }) => p.type === 'logs');
          if (logsPanel) {
            console.log('[Script] Found logs panel, stopping:', logsPanel.id);
            await logsManager.stopScript(logsPanel.id);
          }
          // Ensure tracker is updated
          scriptExecutionTracker.stop('session', runningScript.id);
          console.log('[Script] Session script stopped and tracker updated');
        } else if (runningScript.type === 'project') {
          // Stop project script through logs panel
          if (runningScript.sessionId) {
            const panels = await panelManager.getPanelsForSession(runningScript.sessionId);
            const logsPanel = panels?.find((p: { type: string }) => p.type === 'logs');
            if (logsPanel) {
              await logsManager.stopScript(logsPanel.id);
            }
          }
          // Mark as stopped
          scriptExecutionTracker.stop('project', runningScript.id);
        }
      }

      console.log(`[Script] Starting new script for session ${sessionId}`);

      // Use logs panel instead of old script running mechanism
      const commandString = commands.join(' && ');
      const ctx = sessionManager.getProjectContext(sessionId);
      await logsManager.runScript(sessionId, commandString, session.worktreePath, ctx?.commandRunner.wslContext || null);

      console.log(`[Script] Script started successfully for session ${sessionId}`);

      // Track this session script as running
      scriptExecutionTracker.start('session', sessionId);

      return { success: true };
    } catch (error) {
      console.error('Failed to run script:', error);

      // Clear running state on error
      scriptExecutionTracker.stop('session', sessionId);

      return { success: false, error: 'Failed to run script' };
    }
  });

  commandRegistry.register('sessions:stop-script', async (sessionId?: string) => {
    try {
      // If sessionId provided, stop that session's logs panel
      // Otherwise resolve the active session from the script tracker
      if (sessionId) {
        const panels = await panelManager.getPanelsForSession(sessionId);
        const logsPanel = panels?.find((p: { type: string }) => p.type === 'logs');
        if (logsPanel) {
          await logsManager.stopScript(logsPanel.id);
        }
      } else {
        // Get running script info before stopping
        const runningScript = scriptExecutionTracker.getRunningScript();

        console.log('[Script] Stopping script (no sessionId provided), running script:', runningScript);

        // If it's a session script, stop the logs panel process (critical!)
        if (runningScript && runningScript.type === 'session') {
          console.log('[Script] Finding logs panel for session:', runningScript.id);
          const sessionScriptId = decodeBoundary(runningScript.id, boundary.string);
          const panels = await panelManager.getPanelsForSession(sessionScriptId);
          const logsPanel = panels?.find((p: { type: string }) => p.type === 'logs');
          if (logsPanel) {
            console.log('[Script] Stopping logs panel:', logsPanel.id);
            await logsManager.stopScript(logsPanel.id);
            console.log('[Script] Logs panel stopped successfully');
          } else {
            console.log('[Script] No logs panel found for session');
          }
        }

        // Update the tracker after stopping the logs process
        if (runningScript && runningScript.type === 'session') {
          console.log('[Script] Updating tracker to stopped state for session:', runningScript.id);
          scriptExecutionTracker.stop('session', runningScript.id);
        }

        console.log('[Script] Stop script completed');
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to stop script:', error);
      return { success: false, error: 'Failed to stop script' };
    }
  });

  commandRegistry.register('sessions:run-terminal-command', async (sessionId: string, command: string) => {
    try {
      await sessionManager.runTerminalCommand(sessionId, command);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to run terminal command';
      
      // Don't log error for archived sessions - this is expected
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to run terminal command:', error);
      }
      
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:send-terminal-input', async (sessionId: string, data: string) => {
    try {
      await sessionManager.sendTerminalInput(sessionId, data);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send terminal input';
      
      // Don't log error for archived sessions - this is expected
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to send terminal input:', error);
      }
      
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:pre-create-terminal', async (sessionId: string) => {
    try {
      await sessionManager.preCreateTerminalSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to pre-create terminal session:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to pre-create terminal session' };
    }
  });

  commandRegistry.register('sessions:resize-terminal', async (sessionId: string, cols: number, rows: number) => {
    try {
      sessionManager.resizeTerminal(sessionId, cols, rows);
      return { success: true };
    } catch (error) {
      console.error('Failed to resize terminal:', error);
      return { success: false, error: 'Failed to resize terminal' };
    }
  });

  // Allowlist of known IDE commands keyed by identifier
  interface IdeCommandLookup {
    [ide: string]: string;
  }

  const IDE_COMMANDS: IdeCommandLookup = {
    vscode: 'code .',
    cursor: 'cursor .',
  };

  // Opening a local IDE is a client-local adapter action, not daemon-owned runtime behavior.
  ipcMain.handle('sessions:open-ide', async (_event, sessionId: string, ideKey?: PaneCommandValue) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      // Resolve command: use allowlisted key, fall back to project config
      let safeKey: string | undefined;
      try {
        safeKey = decodeBoundary(ideKey, boundary.optional(boundary.string));
      } catch {
        safeKey = undefined;
      }
      const ideCommand = (safeKey && IDE_COMMANDS[safeKey]) || project?.open_ide_command;
      if (!ideCommand) {
        return { success: false, error: 'No IDE command configured for this project' };
      }

      // Execute the IDE command in the worktree directory
      // Get enhanced shell PATH for packaged apps
      const shellPath = getShellPath();

      console.log(`[IDE] Opening IDE with command: ${ideCommand}`);
      console.log(`[IDE] Working directory: ${session.worktreePath}`);
      console.log(`[IDE] Using PATH: ${shellPath.split(':').slice(0, 5).join(':')}...`);

      // Wrap exec in a Promise to wait for completion
      return new Promise((resolve) => {
        exec(
          ideCommand,
          {
            cwd: session.worktreePath,
            env: {
              ...process.env,
              PATH: shellPath  // Use enhanced PATH that includes user's shell PATH
            }
          },
          (error: ExecException | null, stdout: string, stderr: string) => {
            if (error) {
              console.error('Failed to open IDE:', error);
              console.error('stdout:', stdout);
              console.error('stderr:', stderr);
              
              let errorMessage = 'Failed to open IDE';
              
              // Provide more specific error messages
              if (error.code === 127 || stderr.includes('command not found')) {
                // Try to extract just the command name (e.g., "code" from "code .")
                const commandParts = ideCommand.trim().split(/\s+/);
                const commandName = commandParts[0];
                
                // Try to find the executable in PATH
                const foundPath = findExecutableInPath(commandName);
                
                if (foundPath) {
                  errorMessage = `IDE command not found: ${ideCommand}.\n\nThe command '${commandName}' was found at: ${foundPath}\n\nTry updating your project settings to use the full path:\n${foundPath} .`;
                } else {
                  errorMessage = `IDE command not found: ${ideCommand}.\n\nMake sure the command is in your PATH or use a full path.\n\nFor VS Code, try: /Applications/Visual\\ Studio\\ Code.app/Contents/Resources/app/bin/code .`;
                }
              } else if (error.code) {
                errorMessage = `IDE command failed with exit code ${error.code}: ${stderr || error.message}`;
              } else {
                errorMessage = `Failed to open IDE: ${error.message}`;
              }
              
              resolve({ success: false, error: errorMessage });
            } else {
              console.log('Successfully opened IDE for session:', sessionId);
              if (stdout) console.log('IDE command output:', stdout);
              resolve({ success: true });
            }
          }
        );
      });
    } catch (error) {
      console.error('Failed to open IDE:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open IDE' };
    }
  });

  // Logs panel specific handlers
  commandRegistry.register('logs:runScript', async (sessionId: string, command: string, cwd: string) => {
    try {
      const ctx = sessionManager.getProjectContext(sessionId);
      await logsManager.runScript(sessionId, command, cwd, ctx?.commandRunner.wslContext || null);
      return { success: true };
    } catch (error) {
      console.error('Failed to run script in logs panel:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run script' };
    }
  });

  commandRegistry.register('logs:stopScript', async (panelId: string) => {
    try {
      await logsManager.stopScript(panelId);
      return { success: true };
    } catch (error) {
      console.error('Failed to stop script in logs panel:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop script' };
    }
  });

  commandRegistry.register('logs:isRunning', async (sessionId: string) => {
    try {
      const isRunning = await logsManager.isRunning(sessionId);
      return { success: true, data: isRunning };
    } catch (error) {
      console.error('Failed to check if script is running:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check script status' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_SCRIPT_CHANNELS);
}
