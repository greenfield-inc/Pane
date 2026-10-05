import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API } from '../../utils/api';
import type { GitCommitFilesResult } from '../../../../shared/types/git';
import { readCommitFileCache, writeCommitFileCache } from './commitFileCache';
import { FileChangeList } from './FileChangeList';

export interface CommitFileListProps {
  sessionId: string;
  /** Commit hash, or `index` for uncommitted working-tree changes. */
  commitRef: string;
  /** Called when a file row is activated; wire this to reveal the file's diff. */
  onFileClick?: (commitRef: string, path: string) => void;
  className?: string;
}

/**
 * Lazily loads and renders the files a single commit touched, with per-file
 * change kind and +/- counts. Mounted only when a commit row is expanded, so
 * a 50-commit history costs nothing until the user asks for detail.
 */
export function CommitFileList({ sessionId, commitRef, onFileClick, className = '' }: CommitFileListProps) {
  const [result, setResult] = useState<GitCommitFilesResult | null>(
    () => readCommitFileCache(sessionId, commitRef) ?? null
  );
  const [loading, setLoading] = useState(!result);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = readCommitFileCache(sessionId, commitRef);
    if (cached) {
      setResult(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    API.sessions.getCommitFiles(sessionId, commitRef)
      .then(response => {
        if (cancelled) return;
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Failed to load changed files');
        }
        writeCommitFileCache(sessionId, commitRef, response.data);
        setResult(response.data);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load changed files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [commitRef, sessionId]);

  if (loading) {
    return (
      <div className={`flex items-center gap-1.5 py-1 pl-6 text-[10px] text-text-muted ${className}`}>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Loading files…
      </div>
    );
  }

  if (error) {
    return (
      <div className={`py-1 pl-6 pr-2 text-[10px] text-status-error ${className}`}>{error}</div>
    );
  }

  if (!result || result.files.length === 0) {
    return (
      <div className={`py-1 pl-6 pr-2 text-[10px] text-text-muted ${className}`}>No files changed</div>
    );
  }

  return (
    <div className={`pb-1 ${className}`}>
      {result.isMergeAgainstFirstParent && (
        <div className="py-0.5 pl-6 pr-2 text-[10px] italic text-text-muted">
          Merge commit — showing changes against the first parent
        </div>
      )}
      <FileChangeList
        files={result.files}
        onFileClick={onFileClick ? path => onFileClick(commitRef, path) : undefined}
      />
      {result.truncated && (
        <div className="py-0.5 pl-6 pr-2 text-[10px] text-text-muted">
          Showing {result.files.length} of {result.totalFiles} files
        </div>
      )}
    </div>
  );
}
