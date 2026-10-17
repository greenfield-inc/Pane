import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { SessionManager } from '../services/sessionManager';
import { getSessionLogs, clearSessionLogs } from '../services/session-logs';

const DAEMON_LOG_CHANNELS = ['sessions:get-logs', 'sessions:clear-logs'] as const;

export function setupLogHandlers(
  ipcMain: IpcMain,
  _sessionManager: SessionManager,
  commandRegistry: PaneCommandRegistry,
) {
  // Get logs for a session
  commandRegistry.register('sessions:get-logs', async (sessionId: string) => {
    try {
      const logs = getSessionLogs(sessionId);
      return { success: true, data: logs };
    } catch (error) {
      console.error('Failed to get logs:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to get logs' 
      };
    }
  });

  // Clear logs for a session
  commandRegistry.register('sessions:clear-logs', async (sessionId: string) => {
    try {
      clearSessionLogs(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to clear logs:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to clear logs' 
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_LOG_CHANNELS);
}
