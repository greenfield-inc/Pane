import { useEffect, useMemo, useState } from 'react';
import { Loader2, User, Clock, Hash, GitFork } from 'lucide-react';
import { API } from '../../utils/api';
import { parseUnifiedDiffToFiles } from '../../utils/parseUnifiedDiff';
import { GitGraphPatchView } from './GitGraphPatchView';
import { CopyableField } from '../ui/CopyableField';
import { Badge } from '../ui/Badge';
import type { GitGraphNode } from '../../../../shared/types/gitGraph';
import type { GitDiffResult } from '../../types/diff';

interface GitGraphCommitDetailProps {
  projectId: number;
  node: GitGraphNode;
}

/**
 * Right-hand pane of the graph view: metadata for the selected commit plus its
 * full patch, rendered with the same diff library the editor diff tabs use so
 * expand/collapse, split view and syntax highlighting behave identically.
 */
export function GitGraphCommitDetail({ projectId, node }: GitGraphCommitDetailProps) {
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);

    API.projects.getCommitDetail(projectId, node.hash)
      .then(response => {
        if (cancelled) return;
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Failed to load commit');
        }
        setDiff(response.data);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load commit');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [projectId, node.hash]);

  const files = useMemo(() => (diff ? parseUnifiedDiffToFiles(diff.diff) : []), [diff]);

  const fullDate = useMemo(() => {
    const date = new Date(node.authorDate);
    return Number.isNaN(date.getTime())
      ? node.authorDate
      : date.toLocaleString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
  }, [node.authorDate]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex-shrink-0 border-b border-border-primary bg-surface-secondary px-4 py-3">
        <h2 className="mb-2 whitespace-pre-wrap break-words text-sm font-medium leading-snug text-text-primary">
          {node.subject}
        </h2>

        {node.refs.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {node.refs.map(ref => (
              <Badge
                key={`${ref.kind}-${ref.name}`}
                size="sm"
                variant={ref.kind === 'tag' ? 'warning' : ref.isCurrent ? 'primary' : 'default'}
              >
                {ref.name}
              </Badge>
            ))}
          </div>
        )}

        <div className="space-y-0.5 text-[11px]">
          <CopyableField icon={User} value={`${node.authorName} <${node.authorEmail}>`} />
          <CopyableField icon={Hash} value={node.hash} mono />
          <CopyableField icon={Clock} value={fullDate} />
          {node.parents.length > 0 && (
            <CopyableField icon={GitFork} value={node.parents.join(', ')} mono />
          )}
        </div>

        {diff && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="font-semibold text-status-success">+{diff.stats.additions}</span>
            <span className="font-semibold text-status-error">-{diff.stats.deletions}</span>
            <span className="text-text-muted">
              {diff.stats.filesChanged} {diff.stats.filesChanged === 1 ? 'file' : 'files'}
            </span>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading commit…
          </div>
        ) : error ? (
          <div className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
            {error}
          </div>
        ) : files.length === 0 ? (
          <div className="p-4 text-center text-sm text-text-secondary">
            This commit has no file changes.
          </div>
        ) : (
          <GitGraphPatchView files={files} />
        )}
      </div>
    </div>
  );
}
