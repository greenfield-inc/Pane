import fs from 'fs';
import type { IpcMain } from 'electron';

/** Register before loading the first renderer; a reload must not replay the notice. */
export function registerStartupNotice(ipc: Pick<IpcMain, 'handle'>, sentinelPath: string): void {
  let pending = false;
  try {
    pending = fs.existsSync(sentinelPath);
    if (pending) console.warn('[Main] Unclean shutdown detected — crash sentinel was still present');
    // Clean shutdown removes this sentinel in the app lifecycle handler.
    fs.writeFileSync(sentinelPath, `${process.pid}\n${new Date().toISOString()}`);
  } catch (error) {
    console.warn('[Main] Failed to manage crash sentinel:', error);
  }
  ipc.handle('app:consume-unclean-shutdown', () => {
    const detected = pending;
    pending = false;
    return detected;
  });
}
