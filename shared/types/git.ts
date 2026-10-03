/**
 * Wire types for per-file git change details.
 *
 * These describe *which* files a commit (or the working tree) touched and by
 * how much, without carrying the patch text. The diff panel loads them lazily
 * per commit so expanding one commit never costs a full `git show`.
 */

export type GitFileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'unknown';

/** Pseudo-ref used to address uncommitted working-tree changes. */
export const WORKING_TREE_REF = 'index';

export interface GitCommitFileChange {
  /** Post-change path (the new path for renames/copies). */
  path: string;
  /** Pre-change path; equals `path` unless renamed or copied. */
  oldPath: string;
  status: GitFileChangeStatus;
  /** null for binary files — git numstat prints `-` for those. */
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
}

export interface GitCommitFilesResult {
  /** Commit hash, or `index` for uncommitted working-tree changes. */
  ref: string;
  files: GitCommitFileChange[];
  /** Total files touched before truncation. */
  totalFiles: number;
  /** True when the commit exceeded the per-commit cap and `files` was clipped. */
  truncated: boolean;
  /**
   * True when `ref` is a merge commit and the listing is the diff against the
   * first parent only. Surfaced in the UI so the numbers are not misread.
   */
  isMergeAgainstFirstParent: boolean;
}

/** Hard cap on files returned for a single commit. */
export const MAX_FILES_PER_COMMIT = 500;
