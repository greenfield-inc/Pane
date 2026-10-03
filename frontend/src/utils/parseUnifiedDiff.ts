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

const GIT_ESCAPE_BYTES = new Map([
  ['a', 0x07],
  ['b', 0x08],
  ['t', 0x09],
  ['n', 0x0a],
  ['v', 0x0b],
  ['f', 0x0c],
  ['r', 0x0d],
  ['"', 0x22],
  ['\\', 0x5c],
]);

function decodeGitQuotedPath(token: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const content = token.slice(1, -1);

  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character !== '\\') {
      bytes.push(...encoder.encode(character));
      continue;
    }

    const escaped = content[++index];
    if (escaped === undefined) break;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(content[index + 1] ?? '')) {
        octal += content[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(GIT_ESCAPE_BYTES.get(escaped) ?? escaped.charCodeAt(0));
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function parseDiffHeaderPaths(chunk: string): { oldPath: string; newPath: string } | null {
  const lineEnd = chunk.indexOf('\n');
  const header = chunk.slice('diff --git '.length, lineEnd < 0 ? chunk.length : lineEnd);

  if (header.startsWith('"')) {
    const separator = header.indexOf('" "', 1);
    if (separator < 0 || !header.endsWith('"')) return null;
    const oldToken = header.slice(0, separator + 1);
    const newToken = header.slice(separator + 2);
    const oldPath = decodeGitQuotedPath(oldToken);
    const newPath = decodeGitQuotedPath(newToken);
    if (!oldPath.startsWith('a/') || !newPath.startsWith('b/')) return null;
    return { oldPath: oldPath.slice(2), newPath: newPath.slice(2) };
  }

  const match = header.match(/^a\/(.*?) b\/(.*)$/);
  if (!match) return null;
  return { oldPath: match[1], newPath: match[2] };
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
    const paths = parseDiffHeaderPaths(chunk);
    if (!paths) return [];
    const { oldPath, newPath } = paths;
    const isBinary = chunk.includes('Binary files') || chunk.includes('GIT binary patch');

    let type: FileDiff['type'] = 'modified';
    if (chunk.includes('new file mode')) type = 'added';
    else if (chunk.includes('deleted file mode')) type = 'deleted';
    else if (chunk.includes('rename from') && chunk.includes('rename to')) type = 'renamed';

    const { additions, deletions } = countChangedLines(chunk);

    return [{ path: newPath || oldPath, oldPath, type, isBinary, additions, deletions, rawDiff: chunk }];
  });
}
