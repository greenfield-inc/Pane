import { shell } from 'electron';
import { execFile } from 'child_process';
import { PaneError } from '../../../shared/paneError';
import { appLinkOrNull, toExternalUrl, toLocalPageFile } from './externalUrl';

/** Opens an http, https or mailto URL with the OS handler; throws `ERR_EXTERNAL_URL_BLOCKED` for anything else. */
export async function openExternalUrl(value: string): Promise<void> {
  const url = toExternalUrl(value);
  if (process.platform === 'darwin') return openOnMac(url);
  await shell.openExternal(url);
}

/**
 * Opens an app link a browser tab's page asked for (zoommtg:, slack:) with the app the OS has for
 * it, once the person pressed Open. Throws `ERR_APP_LINK_BLOCKED` for web links and refused schemes.
 */
export async function openAppLink(value: string): Promise<void> {
  const url = appLinkOrNull(value);
  if (url === null) {
    throw new PaneError('ERR_APP_LINK_BLOCKED', 'Pane did not open this link: it is a web link or reaches files or programs directly. Nothing was opened.', 'Copy the link and open it yourself if you trust it.');
  }
  if (process.platform === 'darwin') return openOnMac(url);
  await shell.openExternal(url);
}

/** Opens a local `.html` or `.htm` page, given as a `file:` URL, in the app the OS opens web pages with: the default browser. */
export async function openLocalPage(fileUrl: string): Promise<void> {
  const real = await toLocalPageFile(fileUrl);
  if (process.platform === 'darwin') return openOnMac(real);
  const error = await shell.openPath(real);
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
