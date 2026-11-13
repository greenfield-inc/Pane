import { constants } from 'fs';
import { access } from 'fs/promises';
import path from 'path';
import { getShellPath } from './shellPath';

/**
 * Whether `name` is an executable on the PATH terminal agent tabs use, checked without blocking
 * the main process (findExecutableInPath runs a shell per PATH folder).
 */
export async function isOnPath(name: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const folders = (platform === 'linux' ? process.env.PATH ?? '' : getShellPath()).split(path.delimiter).filter(Boolean);
  const names = platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  const candidates = folders.flatMap(folder => names.map(file => path.join(folder, file)));
  const results = await Promise.all(candidates.map(file => access(file, platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false)));
  return results.some(Boolean);
}
