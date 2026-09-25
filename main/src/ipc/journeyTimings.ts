import { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

const journeyTimingSchema = boundary.object({
  journey: boundary.enumeration('create_pane', 'switch_pane', 'send_prompt'),
  durationMs: boundary.number,
});

export function registerJourneyTimingHandlers(ipcMain: IpcMain, { databaseService }: AppServices): void {
  let launchRecorded = false;

  // Launch runs from process start, which only main knows; a renderer reload is not a launch.
  ipcMain.handle('journeys:app-ready', () => {
    if (launchRecorded) return;
    launchRecorded = true;
    databaseService.recordJourneyTiming('app_launch', process.uptime() * 1000);
  });

  ipcMain.handle('journeys:record', (_event, request: PaneCommandValue) => {
    const timing = decodeOptionalBoundary(request, journeyTimingSchema);
    if (timing && Number.isFinite(timing.durationMs) && timing.durationMs >= 0) {
      databaseService.recordJourneyTiming(timing.journey, timing.durationMs);
    }
  });

  ipcMain.handle('journeys:summary', () => ({ success: true, data: databaseService.getJourneyTimingSummary() }));
}
