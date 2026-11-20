import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { hasFileProtocol } from '../../../../shared/utils/browserUrl';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { mapPath, type PathMap } from './pathMap';
import type { MoveTab } from './manifest';

/**
 * What the target does with an arriving browser tab that shows a host file (`runpane panels open
 * --file`). A file:// URL is a host grant, which a remote call may not make
 * (assertHostBrowserFileNavigation), so the build makes it itself, and only for a file that moved
 * with the Session: inside a worktree it placed or the Session folder it restored, and there now.
 * Any other preview stays behind with a note; it never stops the move (T-42).
 */
export type ArrivingPreview =
  | { kind: 'carried'; currentUrl: string }
  | { kind: 'notCarried'; note: string };

const browserUrlSchema = boundary.object({ currentUrl: boundary.optional(boundary.string) });

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Null for any tab that is not a file preview. `movedRoots` are this machine's paths of what the
 * move placed; `source` is the source machine's name, for the note.
 */
export async function arrivingPreview(tab: MoveTab, map: PathMap, movedRoots: readonly string[], source: string): Promise<ArrivingPreview | null> {
  if (tab.type !== 'browser') return null;
  const url = decodeBoundary(tab.state, browserUrlSchema).currentUrl;
  if (!url || !hasFileProtocol(url)) return null;
  const parsed = new URL(url);
  let sourcePath: string;
  try {
    sourcePath = fileURLToPath(parsed);
  } catch {
    return { kind: 'notCarried', note: `${tab.title} (${url}): not carried, the link is not a file path` };
  }
  const mapped = mapPath(map, sourcePath);
  const root = mapped ? movedRoots.find(candidate => within(candidate, mapped)) : undefined;
  if (!mapped || !root) {
    return { kind: 'notCarried', note: `${tab.title} (${sourcePath}): not carried, the file is outside the Session's worktrees and folder, so it stayed on ${source}` };
  }
  // The file itself, symlinks resolved, must be a regular file still inside what moved.
  const real = await fs.promises.realpath(mapped).catch(() => null);
  const realRoot = await fs.promises.realpath(root).catch(() => null);
  const isFile = real ? (await fs.promises.stat(real).catch(() => null))?.isFile() : false;
  if (!real || !realRoot || !isFile) {
    return { kind: 'notCarried', note: `${tab.title} (${sourcePath}): not carried, the file didn't come with the move (ignored, or gone from ${source})` };
  }
  if (!within(realRoot, real)) {
    return { kind: 'notCarried', note: `${tab.title} (${sourcePath}): not carried, the file links outside the Session's worktrees and folder` };
  }
  const carried = pathToFileURL(mapped);
  carried.search = parsed.search;
  carried.hash = parsed.hash;
  return { kind: 'carried', currentUrl: carried.href };
}
