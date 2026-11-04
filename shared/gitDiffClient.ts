import type { ChangedFileSummary, ChangeKind, DiffRequestErrorCode, DiffScope, ResolvedDiffEndpoint } from './types/gitDiff';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from './validation/boundaryDecoder';

// The branch's changes as remote clients (the phone and the PWA) read them, read-only,
// from `sessions:get-diff-manifest` and `sessions:get-file-diff`.

/** The branch's changes, as the desktop's Changes panel shows them by default. */
export const BRANCH_SCOPE: DiffScope = { kind: 'session' };

/** A diff the computer refused, with its reason code (`diff-too-large`, `archived`, …). */
export class DiffError extends Error {
  constructor(message: string, readonly code: DiffRequestErrorCode | null) {
    super(message);
  }
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

const ERROR_CODES = ['session-not-found', 'archived', 'invalid-scope', 'unknown-commit', 'invalid-path', 'diff-too-large', 'git-error'] as const satisfies readonly DiffRequestErrorCode[];
const failureSchema = boundary.object({
  success: boundary.literal(false),
  error: boundary.optional(boundary.string),
  code: boundary.optional(boundary.string),
});
const answerOf = <Data>(data: BoundarySchema<Data>) => boundary.union(boundary.object({ success: boundary.literal(true), data }), failureSchema);
const manifestAnswer = answerOf(manifestSchema);
const fileDiffAnswer = answerOf(fileDiffSchema);

/** The diff channels' answer: `data`, or a `DiffError` carrying the computer's reason and code. */
function dataOf<Data>(answer: { success: true; data: Data } | { success: false; error?: string; code?: string } | undefined, what: string): Data {
  if (answer?.success) return answer.data;
  const code = ERROR_CODES.find(known => known === answer?.code) ?? null;
  throw new DiffError(answer?.error ?? `The computer sent ${what} Pane can’t read.`, code);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The host's answer is decoded immediately with the manifest schema.
export function decodeManifest(response: unknown): ChangeList {
  return dataOf(decodeOptionalBoundary(response, manifestAnswer), 'a list of changes');
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The host's answer is decoded immediately with the file diff schema.
export function decodeFileDiff(response: unknown): { patch: string; status: 'changed' | 'no-longer-changed' } {
  return dataOf(decodeOptionalBoundary(response, fileDiffAnswer), 'a diff');
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

const BADGES = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', 'type-changed': 'T', unmerged: 'U',
} satisfies Record<ChangeKind, string>;

export function changeBadge(kind: ChangeKind): string {
  return BADGES[kind];
}

/** What the changes are compared with, as the Diff tab's header says it. */
export function versusLabel(base: ResolvedDiffEndpoint): string {
  if (base.ref) return `vs ${base.ref.replace(/^(?:refs\/heads\/|refs\/remotes\/)?(?:origin\/)?/, '')}`;
  if (base.hash) return `vs ${base.hash.slice(0, 7)}`;
  return '';
}
