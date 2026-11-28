import fs from 'fs';

/**
 * Creates a Session folder as only its owner may read it (0700, and its missing parents too), and
 * refuses one that is a symbolic link. Recursive mkdir leaves an existing folder's mode alone, so
 * whoever makes the folder first must make it private (#1762 F-5).
 */
export function ensurePrivateFolder(folder: string, label = 'Session workspace'): void {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(folder).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${folder}`);
}
