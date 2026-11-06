import type { QueryClient } from '@tanstack/react-query';

import type { DiffScope } from '@shared/types/gitDiff';

export { changeBadge, decodeFileDiff, decodeManifest, DiffError, parsePatch, versusLabel, type PatchRow } from '@shared/gitDiffClient';
import type { PatchRow } from '@shared/gitDiffClient';

/** Scopes whose patches change with the worktree; a commit's or a commit range's never do. */
const LIVE_SCOPES: ReadonlySet<DiffScope['kind']> = new Set(['session', 'working-tree', 'working-tree-range']);

/**
 * Rereads a Pane's change list and the patches open for it, after its git status changes or on
 * pull to refresh, so an open patch never lags behind the counts above it.
 */
export function refreshChanges(queryClient: QueryClient, profileId: string, sessionId: string): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: [profile, channel, session, scope] }) => profile === profileId && session === sessionId && (
      channel === 'sessions:get-diff-manifest'
      || (channel === 'sessions:get-file-diff' && LIVE_SCOPES.has((scope as DiffScope | undefined)?.kind ?? 'commit'))
    ),
  });
}

/** Rows of a patch drawn inside the file list; a longer patch opens whole in its own scrolling view. */
export const INLINE_PATCH_ROWS = 200;

/** The rows to draw inside the file list, and how many more the full view has. */
export function inlinePatch(rows: readonly PatchRow[]): { rows: readonly PatchRow[]; hidden: number } {
  return rows.length > INLINE_PATCH_ROWS ? { rows: rows.slice(0, INLINE_PATCH_ROWS), hidden: rows.length - INLINE_PATCH_ROWS } : { rows, hidden: 0 };
}
