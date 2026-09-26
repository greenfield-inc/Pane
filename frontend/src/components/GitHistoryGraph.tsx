import { useState, useEffect, useCallback, memo } from 'react';
import { API } from '../utils/api';
import { subscribeToSessionGitChanges } from '../utils/session-git-events';
import { Loader2, GitCommitHorizontal, FileText, Plus, Minus, User, Clock, Hash, GitFork } from 'lucide-react';
import { Tooltip } from './ui/Tooltip';
import { CopyableField } from './ui/CopyableField';

interface GitGraphCommitData {
  hash: string;
  parents: string[];
  branch: string;
  message: string;
  committerDate: string;
  author: string;
  authorEmail?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

interface GitGraphResponse {
  entries: GitGraphCommitData[];
  currentBranch: string;
}

interface GitHistoryGraphProps {
  sessionId: string;
  baseBranch: string;
  layout?: 'compact' | 'wide';
  onCommitClick?: (hash: string) => void;
}

function CommitTooltipContent({ entry }: { entry: GitGraphCommitData }) {
  const date = new Date(entry.committerDate);
  const fullDate = date.toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  if (entry.hash === 'index') {
    return <span className="text-[11px] text-status-warning/80 italic">Uncommitted changes</span>;
  }

  const hasStats = entry.filesChanged != null && entry.filesChanged > 0;

  return (
    <div className="max-w-xs space-y-1.5">
      {/* Commit message */}
      <p className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-snug font-medium">{entry.message}</p>

      <div className="border-t border-border-primary" />

      {/* Metadata rows — click to copy */}
      <div className="space-y-0.5 text-[10px]">
        <CopyableField icon={User} value={`${entry.author}${entry.authorEmail ? ` <${entry.authorEmail}>` : ''}`} />
        <CopyableField icon={Hash} value={entry.hash} mono />
        <CopyableField icon={Clock} value={fullDate} />
        {entry.parents.length > 0 && (
          <CopyableField icon={GitFork} value={entry.parents.join(', ')} mono />
        )}
      </div>

      {/* File change stats */}
      {hasStats && (
        <>
          <div className="border-t border-border-primary" />
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1 text-text-secondary">
              <FileText className="w-3 h-3 text-text-tertiary" />
              {entry.filesChanged} {entry.filesChanged === 1 ? 'file' : 'files'}
            </span>
            {(entry.additions ?? 0) > 0 && (
              <span className="flex items-center gap-0.5 text-status-success">
                <Plus className="w-3 h-3" />
                {entry.additions}
              </span>
            )}
            {(entry.deletions ?? 0) > 0 && (
              <span className="flex items-center gap-0.5 text-status-error">
                <Minus className="w-3 h-3" />
                {entry.deletions}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  entry,
  isLast,
  layout = 'compact',
  onClick,
}: {
  entry: GitGraphCommitData;
  isLast: boolean;
  layout?: 'compact' | 'wide';
  onClick?: (hash: string) => void;
}) {
  const isIndex = entry.hash === 'index';
  const date = new Date(entry.committerDate);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hasStats = entry.filesChanged != null && entry.filesChanged > 0;
  const Row = onClick ? 'button' : 'div';

  const row = (
      <Row
        {...(onClick ? { type: 'button' as const } : {})}
        className={`flex items-stretch gap-1.5 w-full text-left rounded-sm min-w-0 ${layout === 'wide' ? (onClick ? 'hover:bg-surface-secondary cursor-pointer transition-colors' : '') : `hover:bg-surface-secondary ${onClick ? 'cursor-pointer' : 'cursor-default'} transition-colors`}`}
        onClick={onClick ? () => onClick(entry.hash) : undefined}
      >
        {/* Graph rail: vertical line with commit node */}
        <div className="flex flex-col items-center flex-shrink-0 w-3 ml-1">
          <div className={`w-px flex-1 ${isIndex ? 'bg-transparent' : 'bg-border-secondary'}`} />
          <GitCommitHorizontal
            className={`w-3 h-3 flex-shrink-0 rotate-90 ${
              isIndex ? 'text-status-warning' : 'text-interactive'
            }`}
          />
          <div className={`w-px flex-1 ${isLast ? 'bg-transparent' : 'bg-border-secondary'}`} />
        </div>
        {/* Content */}
        <div className="min-w-0 flex-1 py-0.5 pr-1">
          {isIndex ? (
            <>
              <div className="text-[10px] text-status-warning/70 italic truncate leading-snug">
                {entry.message}
              </div>
              {hasStats && (
                <div className="flex items-center gap-1.5 text-[10px] leading-snug">
                  <span className="text-text-tertiary">
                    {entry.filesChanged} {entry.filesChanged === 1 ? 'file' : 'files'}
                  </span>
                  {(entry.additions ?? 0) > 0 && (
                    <span className="text-status-success">+{entry.additions}</span>
                  )}
                  {(entry.deletions ?? 0) > 0 && (
                    <span className="text-status-error">-{entry.deletions}</span>
                  )}
                </div>
              )}
            </>
          ) : layout === 'wide' ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-text-primary truncate leading-snug flex-1 min-w-0">
                  {entry.message}
                </span>
                {hasStats && (
                  <span className="flex items-center gap-1.5 text-[10px] flex-shrink-0">
                    <span className="text-text-tertiary">
                      {entry.filesChanged} {entry.filesChanged === 1 ? 'file' : 'files'}
                    </span>
                    {(entry.additions ?? 0) > 0 && (
                      <span className="text-status-success">+{entry.additions}</span>
                    )}
                    {(entry.deletions ?? 0) > 0 && (
                      <span className="text-status-error">-{entry.deletions}</span>
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary leading-snug">
                <span className="font-mono">{entry.hash.slice(0, 7)}</span>
                <span>&middot;</span>
                <span>{entry.author}</span>
                <span>&middot;</span>
                <span>{dateStr}</span>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-text-primary truncate leading-snug">
                {entry.message}
              </div>
              <div className="text-[10px] text-text-tertiary leading-snug font-mono truncate">
                {entry.hash}<span className="mx-0.5">&middot;</span><span className="font-sans">{dateStr}</span>
              </div>
            </>
          )}
        </div>
      </Row>
  );

  if (layout === 'wide') return row;

  return (
    <Tooltip content={<CommitTooltipContent entry={entry} />} side="left" interactive>
      {row}
    </Tooltip>
  );
});

export function GitHistoryGraph({ sessionId, baseBranch, layout = 'compact', onCommitClick }: GitHistoryGraphProps) {
  const [rawEntries, setRawEntries] = useState<GitGraphCommitData[]>([]);
  const [currentBranch, setCurrentBranch] = useState(baseBranch);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGraph = useCallback(async () => {
    try {
      setError(null);
      const response = await API.sessions.getGitGraph(sessionId);
      if (response.success && response.data) {
        // SAFETY: The named IPC/API channel contract establishes this response payload type.
        const data = response.data as GitGraphResponse;
        setRawEntries(data.entries);
        setCurrentBranch(data.currentBranch);
      } else {
        setError(response.error || 'Failed to load history');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    fetchGraph();
  }, [fetchGraph]);

  useEffect(() => subscribeToSessionGitChanges(sessionId, fetchGraph, ['git:operation_completed']), [sessionId, fetchGraph]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-4 h-4 animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-text-tertiary px-1 py-2">
        Unable to load commit history
      </div>
    );
  }

  if (rawEntries.length === 0) {
    return (
      <div className="text-xs text-text-tertiary px-1 py-2">
        No commits yet
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col">
        {rawEntries.map((entry, i) => (
          <CommitRow
            key={entry.hash}
            entry={entry}
            isLast={i === rawEntries.length - 1}
            layout={layout}
            onClick={onCommitClick}
          />
        ))}
      </div>
      {currentBranch && (
        <div className="text-[10px] text-text-tertiary px-1 pt-1.5 pb-0.5 font-mono truncate">
          on {currentBranch}
        </div>
      )}
    </div>
  );
}
