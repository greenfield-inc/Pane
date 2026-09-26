import type { IpcMain } from 'electron';
import type { LeaderboardService } from '../services/leaderboardService';

export function registerLeaderboardHandlers(
  ipcMain: IpcMain,
  leaderboardService: LeaderboardService,
): void {
  ipcMain.handle('leaderboard:get-status', async () => {
    try {
      return { success: true, data: await leaderboardService.getStatus() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get leaderboard status',
      };
    }
  });

  ipcMain.handle('leaderboard:join', async () => {
    try {
      const result = await leaderboardService.join();
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to join leaderboard',
      };
    }
  });

  ipcMain.handle('leaderboard:leave', async () => {
    try {
      await leaderboardService.leave();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to leave leaderboard',
      };
    }
  });

  ipcMain.handle('leaderboard:send-now', async () => {
    try {
      const result = await leaderboardService.submit();
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to submit leaderboard data',
      };
    }
  });

  ipcMain.handle('leaderboard:fetch', async () => {
    try {
      const data = await leaderboardService.fetchLeaderboard();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch leaderboard',
      };
    }
  });
}
