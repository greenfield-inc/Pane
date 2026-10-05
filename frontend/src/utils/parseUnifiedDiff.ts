import type { FileDiff } from '../types/diff';

/**
 * Count added/removed lines without allocating a match array.
 *
 * `chunk.match(/^\+(?!\+\+)/gm).length` builds an array with one entry per
 * changed line — on a 50k-line uncommitted diff that is 50k throwaway strings
 * per file, on the UI thread. Scanning line starts directly costs nothing.
 */
function countChangedLines(chunk: string) {
  let additions = 0;
  let deletions = 0;
  let lineStart = 0;

  while (lineStart < chunk.length) {
    let lineEnd = chunk.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = chunk.length;

    const first = chunk[lineStart];
    if (first === '+') {
      // Skip the `+++ b/path` file header.
      if (!(chunk[lineStart + 1] === '+' && chunk[lineStart + 2] === '+')) additions++;
    } else if (first === '-') {
      // Skip the `--- a/path` file header.
      if (!(chunk[lineStart + 1] === '-' && chunk[lineStart + 2] === '-')) deletions++;
    }

    lineStart = lineEnd + 1;
  }

  return { additions, deletions };
}

/**
 * Split a unified diff into one {@link FileDiff} per `diff --git` chunk.
 *
 * Single pass, no allocation per hunk: each chunk keeps its raw patch text so
 * the renderer can hand it straight to `@git-diff-view/react`.
 */
export function parseUnifiedDiffToFiles(diff: string): FileDiff[] {
  if (!diff?.trim()) return [];

  const fileChunks = diff.match(/diff --git[\s\S]*?(?=diff --git|$)/g);
  if (!fileChunks) return [];

  return fileChunks.flatMap(chunk => {
    const nameMatch = chunk.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
    if (!nameMatch) return [];
    const oldPath = nameMatch[1];
    const newPath = nameMatch[2];
    const isBinary = chunk.includes('Binary files') || chunk.includes('GIT binary patch');

    let type: FileDiff['type'] = 'modified';
    if (chunk.includes('new file mode')) type = 'added';
    else if (chunk.includes('deleted file mode')) type = 'deleted';
    else if (chunk.includes('rename from') && chunk.includes('rename to')) type = 'renamed';

    const { additions, deletions } = countChangedLines(chunk);

    return [{ path: newPath || oldPath, oldPath, type, isBinary, additions, deletions, rawDiff: chunk }];
  });
}
