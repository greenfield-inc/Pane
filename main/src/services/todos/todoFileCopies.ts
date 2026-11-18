import fs from 'node:fs';
import path from 'node:path';

/**
 * Pane's own copy of each file attached to a to-do (T-21), so findings, plans and reports still open after the
 * worker's Pane (its worktree and scratch folder) is archived, and from other machines. The original stays the
 * source while it exists; the copy is refreshed from it and used once it is gone. Links are never copied.
 * Copies live under `<root>/T-<n>/<attachment id>-<file name>` and go with the to-do when it is pruned.
 */
export const KEPT_COPY_MAX_BYTES = 25 * 1024 * 1024;

export type KeepOutcome = 'kept' | 'current' | 'too-large' | 'not-a-file';

function copyPathOf(root: string, todoNumber: number, attachmentId: number, original: string): string {
  return path.join(root, `T-${todoNumber}`, `${attachmentId}-${path.basename(original)}`);
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** Copies the original (or refreshes the copy when the original changed). */
export function keepCopy(root: string, todoNumber: number, attachmentId: number, original: string): KeepOutcome {
  const source = statOrNull(original);
  if (!source?.isFile()) return 'not-a-file';
  if (source.size > KEPT_COPY_MAX_BYTES) return 'too-large';
  const copy = copyPathOf(root, todoNumber, attachmentId, original);
  const kept = statOrNull(copy);
  // Timestamps are copied at millisecond precision, so allow under a millisecond's difference.
  if (kept && kept.size === source.size && kept.mtimeMs + 1 >= source.mtimeMs) return 'current';
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  // Written beside it, then renamed: a reader never sees half a copy.
  const partial = `${copy}.partial`;
  fs.copyFileSync(original, partial);
  fs.utimesSync(partial, source.atime, source.mtime);
  fs.renameSync(partial, copy);
  return 'kept';
}

/** The kept copy of an attachment's file, if Pane has one. */
export function keptCopy(root: string, todoNumber: number, attachmentId: number, original: string): string | null {
  const copy = copyPathOf(root, todoNumber, attachmentId, original);
  return statOrNull(copy)?.isFile() ? copy : null;
}

/** Deletes the copies of to-dos that were pruned. */
export function forgetCopies(root: string, todoNumbers: readonly number[]): void {
  for (const number of todoNumbers) fs.rmSync(path.join(root, `T-${number}`), { recursive: true, force: true });
}
