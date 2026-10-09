import { promises as nodeFs } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

// SAFETY: Electron original-fs has the same API, without ASAR virtualization.
const archiveFs: typeof nodeFs = process.versions.electron
  ? (createRequire(__filename)('original-fs') as typeof import('fs')).promises
  : nodeFs;

export { archiveFs };

export function archiveErrorCode(cause: unknown): string | undefined {
  return decodeOptionalBoundary(cause, boundary.object({ code: boundary.string }))?.code;
}

export function archivePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Identity survives rename; bigint avoids loss of Windows file-index precision. */
export async function directoryIdentity(target: string): Promise<string | undefined> {
  try {
    const stat = await archiveFs.lstat(target, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Cleanup path is not a physical directory: ${target}`);
    if (stat.ino === 0n) throw new Error(`Filesystem does not provide directory identity: ${target}`);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch (error) {
    if (archiveErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** A cooperative batch, with no recursive fs.rm or descendant retry loops.
 * Every operation is awaited: yielding never abandons a live deletion. Links
 * are unlinked, never traversed. The host owns all I/O, so no orphan helper can
 * survive a host crash and race restart recovery.
 */
export interface ArchivePurgeCursor {
  stack: Array<{ target: string; identity: string }>;
}

export async function purgeArchiveBatch(root: string, identity: string, cursor: ArchivePurgeCursor = { stack: [] }, budgetMs = 250): Promise<boolean> {
  const actual = await directoryIdentity(root);
  if (actual === undefined) return true;
  if (actual !== identity) throw new Error(`Cleanup directory identity changed: ${root}`);
  const stack = cursor.stack;
  if (stack.length === 0) stack.push({ target: root, identity });
  const deadline = Date.now() + budgetMs;
  let operations = 0;
  while (stack.length > 0 && operations < 256 && (operations === 0 || Date.now() < deadline)) {
    const current = stack[stack.length - 1];
    if (await directoryIdentity(current.target) !== current.identity) throw new Error('Cleanup directory changed during traversal');
    if (archivePathKey(await archiveFs.realpath(current.target)) !== archivePathKey(current.target)) {
      throw new Error('Cleanup traversal encountered a redirected directory');
    }
    const directory = await archiveFs.opendir(current.target);
    let entry;
    try { entry = await directory.read(); } finally { await directory.close(); }
    if (!entry) {
      await archiveFs.rmdir(current.target);
      stack.pop();
    } else {
      const target = path.join(current.target, entry.name);
      const stat = await archiveFs.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const childIdentity = await directoryIdentity(target);
        if (childIdentity) stack.push({ target, identity: childIdentity });
      } else {
        await archiveFs.unlink(target);
      }
    }
    operations++;
  }
  return stack.length === 0;
}
