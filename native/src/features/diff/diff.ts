import type { QueryClient } from '@tanstack/react-query';

import type { ChangedFileSummary, ChangeKind, DiffRequestErrorCode, DiffScope, ResolvedDiffEndpoint } from '@shared/types/gitDiff';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

/** A diff the computer refused, with its reason code (`diff-too-large`, `archived`, …). */
export class DiffError extends Error {
  constructor(message: string, readonly code: DiffRequestErrorCode | null) {
    super(message);
  }
}

const responseSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.json),
  error: boundary.optional(boundary.string),
  code: boundary.optional(boundary.string),
});

/** The diff channels' answer: `data`, or a `DiffError` carrying the computer's code. */
export function decodeDiffResponse(response: unknown): unknown {
  const decoded = decodeOptionalBoundary(response, responseSchema);
  if (decoded?.success) return decoded.data;
  throw new DiffError(decoded?.error ?? 'The computer sent a diff Pane can’t read.', (decoded?.code as DiffRequestErrorCode | undefined) ?? null);
}

const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'unmerged'] as const;
const fileSchema = boundary.object({
  path: boundary.string,
  previousPath: boundary.optional(boundary.string),
  kind: boundary.enumeration(...CHANGE_KINDS),
  additions: boundary.nullable(boundary.number),
  deletions: boundary.nullable(boundary.number),
  isBinary: boundary.boolean,
});
const endpointSchema = boundary.object({
  kind: boundary.enumeration('comparison-base', 'commit', 'empty-tree', 'working-tree'),
  hash: boundary.optional(boundary.string),
  ref: boundary.optional(boundary.string),
});
const manifestSchema = boundary.object({
  files: boundary.array(fileSchema),
  resolvedBase: endpointSchema,
  stats: boundary.object({ additions: boundary.number, deletions: boundary.number, filesChanged: boundary.number }),
});
const fileDiffSchema = boundary.object({
  patch: boundary.string,
  status: boundary.enumeration('changed', 'no-longer-changed'),
});

export interface ChangeList {
  files: ChangedFileSummary[];
  resolvedBase: ResolvedDiffEndpoint;
  stats: { additions: number; deletions: number; filesChanged: number };
}

/** `sessions:get-diff-manifest`: the branch's changed files and their counts. */
export function decodeManifest(response: unknown): ChangeList {
  const manifest = decodeOptionalBoundary(decodeDiffResponse(response), manifestSchema);
  if (!manifest) throw new DiffError('The computer sent a list of changes Pane can’t read.', null);
  return manifest;
}

/** `sessions:get-file-diff`: one file's patch. */
export function decodeFileDiff(response: unknown): { patch: string; status: 'changed' | 'no-longer-changed' } {
  const diff = decodeOptionalBoundary(decodeDiffResponse(response), fileDiffSchema);
  if (!diff) throw new DiffError('The computer sent a diff Pane can’t read.', null);
  return diff;
}

export interface PatchRow {
  kind: 'hunk' | 'added' | 'removed' | 'unchanged' | 'note';
  text: string;
}

/** A unified patch as rows to draw, from its first hunk on; the `diff`, `index`, `---` and `+++` headers are left out. */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'added', text: line });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'removed', text: line });
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line });
    } else if (line.startsWith('diff --git')) {
      inHunk = false;
    } else if (line !== '' || rows.length > 0) {
      rows.push({ kind: 'unchanged', text: line });
    }
  }
  // A patch ends with a newline, which splits into one empty trailing row.
  while (rows.at(-1)?.kind === 'unchanged' && rows.at(-1)?.text === '') rows.pop();
  return rows;
}

const BADGES: Record<ChangeKind, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', 'type-changed': 'T', unmerged: 'U',
};

export function changeBadge(kind: ChangeKind): string {
  return BADGES[kind];
}

/** What the changes are compared with, as the Diff tab's header says it. */
export function versusLabel(base: ResolvedDiffEndpoint): string {
  if (base.ref) return `vs ${base.ref.replace(/^(?:refs\/heads\/|refs\/remotes\/)?(?:origin\/)?/, '')}`;
  if (base.hash) return `vs ${base.hash.slice(0, 7)}`;
  return '';
}

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
