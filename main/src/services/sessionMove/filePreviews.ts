import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { hasFileProtocol } from '../../../../shared/utils/browserUrl';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { MoveTab } from './manifest';

/**
 * What the target does with an arriving browser tab that shows a host file (`runpane panels open
 * --file`). A file:// URL is a host grant, which a remote call may not make
 * (assertHostBrowserFileNavigation), so the build makes it itself, and only for a file the move
 * itself brought: one the build placed in a worktree from the source's snapshot, or restored in the
 * Session folder. Any other preview stays behind with a note; it never stops the move (T-42).
 */
export type ArrivingPreview =
  | { kind: 'carried'; currentUrl: string }
  | { kind: 'notCarried'; note: string };

/**
 * A folder the build placed: its source path, its path here, and the files (relative, `/`-separated)
 * the move brought into it. `same`, when given, says whether the file there now is still the one the
 * move brought (setup may have replaced it).
 */
export interface MovedRoot {
  from: string;
  to: string;
  files: ReadonlySet<string>;
  same?: (relative: string, file: string) => Promise<boolean>;
}

const browserUrlSchema = boundary.object({ currentUrl: boundary.optional(boundary.string) });

/** `file` relative to `root` with `/` separators, or null when it is not strictly inside. */
export function relativeInside(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function fileUrlOf(tab: MoveTab): string | null {
  if (tab.type !== 'browser') return null;
  const url = decodeBoundary(tab.state, browserUrlSchema).currentUrl;
  return url && hasFileProtocol(url) ? url : null;
}

/** The source path a file preview tab shows, or null for any other tab. */
export function previewSourcePath(tab: MoveTab): string | null {
  const url = fileUrlOf(tab);
  if (!url) return null;
  try {
    return fileURLToPath(new URL(url));
  } catch {
    return null;
  }
}

/**
 * Null for any tab that is not a file preview. `roots` are what the build placed, each with the
 * files it brought, listed as it placed them (before setup ran); `source` names the source machine.
 */
export async function arrivingPreview(tab: MoveTab, roots: readonly MovedRoot[], source: string): Promise<ArrivingPreview | null> {
  const url = fileUrlOf(tab);
  if (!url) return null;
  const sourcePath = previewSourcePath(tab);
  if (!sourcePath) return { kind: 'notCarried', note: `${tab.title} (${url}): not carried, the link is not a file path` };
  // The innermost placed folder holding it on the source.
  const root = [...roots].sort((a, b) => b.from.length - a.from.length).find(candidate => relativeInside(candidate.from, sourcePath) !== null);
  const relative = root ? relativeInside(root.from, sourcePath) : null;
  if (!root || !relative) {
    return { kind: 'notCarried', note: `${tab.title} (${sourcePath}): not carried, the file is outside the Session's worktrees and folder, so it stayed on ${source}` };
  }
  const gone: ArrivingPreview = { kind: 'notCarried', note: `${tab.title} (${sourcePath}): not carried, the file didn't come with the move (ignored, or gone from ${source})` };
  if (!root.files.has(relative)) return gone;
  // Still there now, a regular file whose real path stays inside the placed folder.
  const mapped = path.join(root.to, ...relative.split('/'));
  const real = await fs.promises.realpath(mapped).catch(() => null);
  const realRoot = await fs.promises.realpath(root.to).catch(() => null);
  const isFile = real ? (await fs.promises.stat(real).catch(() => null))?.isFile() : false;
  if (!real || !realRoot || !isFile || (root.same && !(await root.same(relative, mapped)))) return gone;
  if (relativeInside(realRoot, real) === null) {
    return { kind: 'notCarried', note: `${tab.title} (${sourcePath}): not carried, the file links outside the Session's worktrees and folder` };
  }
  const parsed = new URL(url);
  const carried = pathToFileURL(mapped);
  carried.search = parsed.search;
  carried.hash = parsed.hash;
  return { kind: 'carried', currentUrl: carried.href };
}
