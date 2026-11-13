import type { App } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { isPackagedOnDefaultDirectory } from './appDirectory';

const LINUX_AUTOSTART_FILENAME = 'com.dcouple.pane.desktop';

function quoteDesktopExecArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function syncLinuxAutoStart(enabled: boolean): void {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopFilePath = path.join(autostartDir, LINUX_AUTOSTART_FILENAME);

  if (!enabled) {
    try {
      fs.unlinkSync(desktopFilePath);
    } catch (error) {
      let code: string | undefined;
      try {
        code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
      } catch {
        code = undefined;
      }
      if (code !== 'ENOENT') {
        console.warn('[AutoStart] Failed to remove Linux autostart entry:', error);
      }
    }
    return;
  }

  try {
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(desktopFilePath, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Pane',
      'Comment=Terminal-first AI code assistant manager',
      `Exec=${quoteDesktopExecArg(process.execPath)}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  } catch (error) {
    console.warn('[AutoStart] Failed to write Linux autostart entry:', error);
  }
}

/**
 * Login items are per user, not per data directory: only the installed Pane on
 * ~/.pane changes them. A dev build would register Electron itself, and a
 * PANE_DIR instance would apply its own config's setting to the real install.
 */
export function syncAutoStartOnBoot(
  app: Pick<App, 'setLoginItemSettings'>,
  enabled: boolean,
  options: { installed?: boolean; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = options.env ?? process.env;
  if (env.PANE_DISABLE_OS_INTEGRATION === '1' || !(options.installed ?? isPackagedOnDefaultDirectory())) {
    return;
  }

  if (process.platform === 'linux') {
    syncLinuxAutoStart(enabled);
    return;
  }

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
    });
  } catch (error) {
    console.warn('[AutoStart] Failed to update login item settings:', error);
  }
}
