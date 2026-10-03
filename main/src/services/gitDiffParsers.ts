import type { GitCommitFileChange, GitFileChangeStatus } from '../../../shared/types/git';
import { parseNumstatZ as parseScopeNumstatZ, parseNameStatusZ as parseScopeNameStatusZ } from './gitDiffScope';

function legacyFileStatus(code: string): GitFileChangeStatus {
  switch (code[0]) {
    case 'A': return 'added'; case 'M': return 'modified'; case 'D': return 'deleted';
    case 'R': return 'renamed'; case 'C': return 'copied'; case 'T': return 'typechange';
    case 'U': return 'unmerged'; default: return 'unknown';
  }
}

export function parseNumstatZ(raw: string) {
  return parseScopeNumstatZ(raw).map(file => ({ oldPath: file.previousPath ?? file.path, path: file.path, additions: file.additions, deletions: file.deletions, isBinary: file.additions === null || file.deletions === null }));
}

export function parseNameStatusZ(raw: string) {
  return parseScopeNameStatusZ(raw).map(file => ({ oldPath: file.previousPath ?? file.path, path: file.path, status: legacyFileStatus(file.status) }));
}

export function mergeFileChanges(numstat: ReturnType<typeof parseNumstatZ>, names: ReturnType<typeof parseNameStatusZ>): GitCommitFileChange[] {
  const byPath = new Map(names.map(file => [file.path, file]));
  return numstat.map(file => { const name = byPath.get(file.path); return { ...file, oldPath: name?.oldPath ?? file.oldPath, status: name?.status ?? 'modified' }; });
}

export function splitNulSeparated(raw: string): string[] {
  return raw.split('\0').filter(entry => entry.length > 0);
}
