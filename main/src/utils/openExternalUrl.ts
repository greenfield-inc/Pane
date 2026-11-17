import { shell } from 'electron';
import { execFile } from 'child_process';
import { access } from 'fs/promises';
import { PaneError } from '../../../shared/paneError';
import { toExternalUrl, toLocalPagePath } from './externalUrl';

/** Opens an http, https or mailto URL with the OS handler; throws `ERR_EXTERNAL_URL_BLOCKED` for anything else. */
export async function openExternalUrl(value: string): Promise<void> {
  const url = toExternalUrl(value);
  if (process.platform === 'darwin') return openOnMac(url);
  await shell.openExternal(url);
}

/** Opens a local `.html` or `.htm` page, given as a `file:` URL, in the app the OS opens web pages with: the default browser. */
export async function openLocalPage(fileUrl: string): Promise<void> {
  const path = toLocalPagePath(fileUrl);
  await access(path).catch(() => {
    throw new PaneError('ERR_LOCAL_PAGE_MISSING', `Pane did not open ${path} in your browser: the file no longer exists.`, 'Reload the tab, or open the page again.');
  });
  if (process.platform === 'darwin') return openOnMac(path);
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

/**
 * On macOS, shell.openExternal can fail silently due to permission/entitlement issues.
 * The native `open` command works reliably. `--` keeps the target from being read as a flag.
 */
function openOnMac(target: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile('open', ['--', target], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
