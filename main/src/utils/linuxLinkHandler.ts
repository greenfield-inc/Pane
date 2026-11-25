import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { quoteDesktopExecArg } from './autoStart';

const HANDLER_FILENAME = 'com.dcouple.pane-links.desktop';

interface AppImageLinkHandlerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: (command: string, args: string[]) => void;
}

/**
 * The deb installs a .desktop file that handles pane://, but an AppImage installs nothing, so the
 * desktop has no handler for its links. Write one that launches this AppImage file (its stable
 * path, which can change between versions) and make it the default for pane://.
 */
export function registerAppImageLinkHandler(options: AppImageLinkHandlerOptions = {}): void {
  const env = options.env ?? process.env;
  const appImage = env.APPIMAGE;
  if ((options.platform ?? process.platform) !== 'linux' || !appImage) return;
  if (appImage.includes('%')) {
    // GIO looks for the escaped name (%%) on disk and ignores the handler.
    console.warn('[PaneLinks] pane:// links need an AppImage path without "%":', appImage);
    return;
  }
  const run = options.run ?? ((command, args) => {
    execFile(command, args, (error) => {
      if (error) console.warn(`[PaneLinks] ${command} could not register pane:// links:`, error.message);
    });
  });
  try {
    const directory = path.join(options.home ?? os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, HANDLER_FILENAME), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Pane',
      `Exec=${quoteDesktopExecArg(appImage)} %U`,
      'MimeType=x-scheme-handler/pane;',
      'NoDisplay=true',
      'Terminal=false',
      '',
    ].join('\n'));
    run('xdg-mime', ['default', HANDLER_FILENAME, 'x-scheme-handler/pane']);
  } catch (error) {
    console.warn('[PaneLinks] Could not register pane:// links for this AppImage:', error);
  }
}
