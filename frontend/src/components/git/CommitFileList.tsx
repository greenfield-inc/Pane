import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API } from '../../utils/api';
import type { GitCommitFileChange, GitCommitFilesResult, GitFileChangeStatus } from '../../../../shared/types/git';
import { readCommitFileCache, writeCommitFileCache } from './commitFileCache';

const STATUS_META = {
  added: { label: 'A', className: 'text-status-success', title: 'Added' },
  modified: { label: 'M', className: 'text-interactive', title: 'Modified' },
  deleted: { label: 'D', className: 'text-status-error', title: 'Deleted' },
  renamed: { label: 'R', className: 'text-interactive', title: 'Renamed' },
  copied: { label: 'C', className: 'text-interactive', title: 'Copied' },
  typechange: { label: 'T', className: 'text-status-warning', title: 'Type changed' },
  unmerged: { label: 'U', className: 'text-status-warning', title: 'Unmerged' },
  unknown: { label: '?', className: 'text-text-muted', title: 'Unknown change' },
} satisfies Record<GitFileChangeStatus, { label: string; className: string; title: string }>;

function splitPath(path: string) {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

function FileRow({
  file,
  onClick,
}: {
  file: GitCommitFileChange;
  onClick?: () => void;
}) {
  const { dir, name } = splitPath(file.path);
  const status = STATUS_META[file.status];
  const title = file.status === 'renamed' || file.status === 'copied'
    ? `${status.title} from ${file.oldPath} to ${file.path}`
    : `${status.title}: ${file.path}`;

  const body = (
    <>
      <span
        className={`w-3 flex-shrink-0 font-mono text-[10px] leading-none ${status.className}`}
        aria-hidden="true"
      >
        {status.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-[11px] leading-snug">
        {dir && <span className="text-text-muted">{dir}</span>}
        <span className="text-text-secondary">{name}</span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-1 font-mono text-[10px] leading-none">
        {file.isBinary ? (
          <span className="text-text-muted">bin</span>
        ) : (
          <>
            {(file.additions ?? 0) > 0 && <span className="text-status-success">+{file.additions}</span>}
            {(file.deletions ?? 0) > 0 && <span className="text-status-error">-{file.deletions}</span>}
            {file.additions === null && file.deletions === null && (
              <span className="text-text-muted">new</span>
            )}
          </>
        )}
      </span>
    </>
  );

  if (!onClick) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 pl-6 pr-2" title={title}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`${status.title}: ${file.path}. Show diff.`}
      className="flex w-full items-center gap-1.5 rounded-sm py-0.5 pl-6 pr-2 transition-colors hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-inset focus:ring-interactive"
    >
      {body}
    </button>
  );
}

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
      {result.files.map(file => (
        <FileRow
          key={`${file.status}-${file.oldPath}-${file.path}`}
          file={file}
          onClick={onFileClick ? () => onFileClick(commitRef, file.path) : undefined}
        />
      ))}
      {result.truncated && (
        <div className="py-0.5 pl-6 pr-2 text-[10px] text-text-muted">
          Showing {result.files.length} of {result.totalFiles} files
        </div>
      )}
    </div>
  );
}
