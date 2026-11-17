import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { getShellPath } from '../../utils/shellPath';

const run = promisify(execFile);

/** Where a moved Pane's ignored files wait in its repository until Restore here (`.git/pane-moved/<pane id>`). */
async function keptFolder(worktreePath: string, paneId: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktreePath, env: { ...process.env, PATH: getShellPath() } });
  return path.join(stdout.trim(), 'pane-moved', paneId);
}

async function moveEntry(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch {
    // Another volume: copy, then remove.
    await fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: true });
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

/**
 * Retiring a Pane that moved away removes its worktree. Its ignored files (`.env`, local config,
 * dependencies) never travel, so they move into the repository's git folder first, where Restore
 * here finds them. All or nothing: if any entry can't be set aside, the ones already moved go back,
 * an earlier kept copy stays as it was, and it throws so the caller keeps the worktree. A file that
 * can't go back either stays in the staging folder, named in the error, and a later retire refuses
 * to start until that folder is emptied: staging is never deleted while it holds the only copy.
 * Returns the entries kept.
 */
export async function keepIgnoredFiles(worktreePath: string, paneId: string, entries: readonly string[]): Promise<string[]> {
  if (entries.length === 0) return [];
  const kept = await keptFolder(worktreePath, paneId);
  const staging = `${kept}.incoming`;
  const previous = `${kept}.previous`;
  for (const leftover of [staging, previous]) {
    if (fs.existsSync(leftover)) {
      throw new PaneError('ERR_MOVE_IGNORED_STAGED', `files from an earlier attempt to set this Pane's ignored files aside are still in ${leftover}`, `Move what you need from ${leftover} back into ${worktreePath}, delete that folder, then archive the Pane.`);
    }
  }
  const moved: string[] = [];
  try {
    for (const entry of entries) {
      const relative = entry.replace(/\/+$/, '');
      if (!relative || relative.split('/').some(part => part === '..')) continue;
      const from = path.join(worktreePath, ...relative.split('/'));
      if (!fs.existsSync(from)) continue;
      await moveEntry(from, path.join(staging, ...relative.split('/')));
      moved.push(relative);
    }
  } catch (error) {
    const stranded: string[] = [];
    for (const relative of moved) {
      await moveEntry(path.join(staging, ...relative.split('/')), path.join(worktreePath, ...relative.split('/'))).catch(() => stranded.push(relative));
    }
    if (stranded.length === 0) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    throw new PaneError('ERR_MOVE_IGNORED_STRANDED', `${reasonOf(error)}; ${stranded.join(', ')} couldn't go back into the worktree and ${stranded.length === 1 ? 'is' : 'are'} kept in ${staging}`, `Move ${stranded.join(', ')} from ${staging} back into ${worktreePath}, delete that folder, then archive the Pane.`);
  }
  if (!fs.existsSync(staging)) return moved;
  // Swap without a gap: the earlier kept copy is set aside, not deleted, until the new one is in place.
  const hadKept = fs.existsSync(kept);
  if (hadKept) await fs.promises.rename(kept, previous);
  try {
    await fs.promises.rename(staging, kept);
  } catch (error) {
    if (hadKept) await fs.promises.rename(previous, kept).catch(() => undefined);
    throw new PaneError('ERR_MOVE_IGNORED_STRANDED', `${reasonOf(error)}; ${moved.join(', ')} ${moved.length === 1 ? 'is' : 'are'} kept in ${staging}`, `Move ${moved.join(', ')} from ${staging} back into ${worktreePath}, delete that folder, then archive the Pane.`);
  }
  if (hadKept) await fs.promises.rm(previous, { recursive: true, force: true }).catch(error => console.warn(`[SessionMove] The earlier kept ignored files in ${previous} weren't removed:`, error));
  return moved;
}

/** Restore here: puts back the ignored files a move kept. Nothing already in the worktree is overwritten. */
export async function bringBackIgnoredFiles(worktreePath: string, paneId: string): Promise<void> {
  const kept = await keptFolder(worktreePath, paneId).catch(() => undefined);
  if (!kept || !fs.existsSync(kept)) return;
  const walk = async (relative: string): Promise<void> => {
    const source = path.join(kept, relative);
    const target = path.join(worktreePath, relative);
    const stat = await fs.promises.lstat(source);
    if (!fs.existsSync(target)) { await moveEntry(source, target); return; }
    if (stat.isDirectory()) for (const name of await fs.promises.readdir(source)) await walk(path.join(relative, name));
  };
  for (const name of await fs.promises.readdir(kept)) await walk(name);
  await fs.promises.rm(kept, { recursive: true, force: true });
}
