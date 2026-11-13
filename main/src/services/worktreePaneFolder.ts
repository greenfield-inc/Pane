import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * `<worktree>/<folder>/` (a `PANE_*_FOLDER` constant), created readable only by
 * the user and hidden from git by the repository's `info/exclude` (never a
 * committed `.gitignore`). Undefined when the path is not the top of a local
 * git checkout. Throws `symlinkError(path)` when a component of the folder is a
 * symbolic link, which would bypass the lexical git exclusion.
 */
export async function worktreePaneFolder(
  worktreePath: string,
  folder: string,
  symlinkError: (candidate: string) => Error,
): Promise<{ root: string; directory: string } | undefined> {
  let top: string;
  let exclude: string;
  try {
    if (!(await fs.stat(worktreePath)).isDirectory()) return undefined;
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], { cwd: worktreePath, timeout: 10_000 });
    const [topLine, excludeLine] = stdout.split(/\r?\n/u);
    if (!topLine || !excludeLine) return undefined;
    // A Session folder or other non-repo folder can sit inside a repository (a tracked home directory).
    if (await fs.realpath(topLine) !== await fs.realpath(worktreePath)) return undefined;
    top = topLine;
    exclude = path.resolve(worktreePath, excludeLine);
  } catch {
    return undefined;
  }
  // Check each repository-controlled component before mkdir/chmod can follow it.
  const parts = folder.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const candidate = path.join(top, ...parts.slice(0, index));
    const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw symlinkError(candidate);
  }
  // No trailing slash: the line also hides a link (or file) put in the folder's place, so it never reads as untracked work.
  const line = `/${folder}`;
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (!current.split(/\r?\n/u).includes(line)) {
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  const directory = path.join(top, ...parts);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return { root: path.normalize(top), directory };
}

/**
 * Whether `folder` is a real folder exactly where it sits below `root`: no
 * symbolic link or Windows junction anywhere between them can point it
 * elsewhere. Pane reads, moves or deletes only confined folders.
 */
export async function isConfinedFolder(root: string, folder: string): Promise<boolean> {
  const relative = path.relative(root, folder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    if (!(await fs.lstat(folder)).isDirectory()) return false;
    return await fs.realpath(folder) === path.join(await fs.realpath(root), relative);
  } catch {
    return false;
  }
}

/** A confined folder (see `isConfinedFolder`) and the bytes in it, without following links; undefined otherwise. */
export async function folderUsage(root: string, directory: string): Promise<{ path: string; bytes: number } | undefined> {
  if (!(await isConfinedFolder(root, directory))) return undefined;
  let bytes = 0;
  const pending = [directory];
  for (let current = pending.pop(); current; current = pending.pop()) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else bytes += (await fs.lstat(child).catch(() => undefined))?.size ?? 0;
    }
  }
  return { path: directory, bytes };
}
