import { shell } from 'electron';
import { execFile } from 'child_process';
import { toExternalUrl } from './externalUrl';

/** Opens an http, https or mailto URL with the OS handler; throws `ERR_EXTERNAL_URL_BLOCKED` for anything else. */
export async function openExternalUrl(value: string): Promise<void> {
  const url = toExternalUrl(value);
  if (process.platform === 'darwin') {
    // On macOS, shell.openExternal can fail silently due to permission/entitlement issues.
    // Use the native `open` command which works reliably. `--` keeps the URL from being read as a flag.
    await new Promise<void>((resolve, reject) => {
      execFile('open', ['--', url], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  await shell.openExternal(url);
}
