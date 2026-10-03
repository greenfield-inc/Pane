import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Loader2 } from 'lucide-react';
import { API } from '../../utils/api';
import { parseUnifiedDiffToFiles } from '../../utils/parseUnifiedDiff';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import { isLightTheme, useTheme } from '../../contexts/ThemeContext';
import '@git-diff-view/react/styles/diff-view.css';
import { FileChangeList } from './FileChangeList';
import type { PullRequestChanges as Changes } from '../../../../shared/types/pullRequest';

/** Typing in the base field must not fire a git command per keystroke. */
const RELOAD_DEBOUNCE_MS = 350;

export interface PullRequestChangesProps {
  sessionId: string;
  /** Base the pull request would target; changing it reloads the comparison. */
  baseBranch: string;
}

/**
 * What the pull request actually contains, shown before it is opened.
 *
 * Two levels, because they cost very different things: the file list is a
 * numstat and loads with the dialog, while the patch is only fetched once the
 * diff is opened.
 */
export function PullRequestChanges({ sessionId, baseBranch }: PullRequestChangesProps) {
  const { theme } = useTheme();
  const [changes, setChanges] = useState<Changes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // A new base means a different comparison: whatever patch is on screen is
    // no longer the one that would be opened.
    setDiff(null);
    setDiffError(null);

    const timer = setTimeout(() => {
      API.pullRequests.getChanges(sessionId, baseBranch)
        .then(response => {
          if (cancelled) return;
          if (!response.success || !response.data) {
            throw new Error(response.error || 'Could not read the changed files');
          }
          setChanges(response.data);
        })
        .catch(err => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read the changed files');
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, RELOAD_DEBOUNCE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, baseBranch]);

  useEffect(() => {
    if (!showDiff) return;

    let cancelled = false;
    setDiff(null);
    setDiffLoading(true);
    setDiffError(null);

    API.pullRequests.getDiff(sessionId, baseBranch)
      .then(response => {
        if (cancelled) return;
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Could not read the diff');
        }
        setDiff({ text: response.data.diff, truncated: response.data.truncated });
      })
      .catch(err => {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : 'Could not read the diff');
      })
      .finally(() => { if (!cancelled) setDiffLoading(false); });

    return () => { cancelled = true; };
  }, [showDiff, sessionId, baseBranch]);

  const diffFiles = useMemo(() => (diff ? parseUnifiedDiffToFiles(diff.text) : []), [diff]);

  const fileCount = changes?.totalFiles ?? 0;

  return (
    <section className="rounded border border-border-secondary">
      <header className="flex items-center gap-2 border-b border-border-secondary px-2 py-1.5">
        <span className="text-[11px] uppercase tracking-wider text-text-muted">Changes</span>

        {loading ? (
          <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            comparing…
          </span>
        ) : error ? (
          <span className="text-xs text-status-error">{error}</span>
        ) : (
          <>
            <span className="text-xs text-text-secondary">
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </span>
            {changes && (changes.additions > 0 || changes.deletions > 0) && (
              <span className="font-mono text-xs">
                <span className="text-status-success">+{changes.additions}</span>{' '}
                <span className="text-status-error">-{changes.deletions}</span>
              </span>
            )}
            {changes?.baseRef && (
              <span className="truncate text-[11px] text-text-muted" title={`Compared against ${changes.baseRef}`}>
                vs {changes.baseRef}
              </span>
            )}
          </>
        )}

        {fileCount > 0 && (
          <button
            type="button"
            onClick={() => setShowDiff(current => !current)}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            {showDiff
              ? <ChevronDown className="h-3 w-3" aria-hidden="true" />
              : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            <FileDiff className="h-3 w-3" aria-hidden="true" />
            {showDiff ? 'Hide diff' : 'Show diff'}
          </button>
        )}
      </header>

      {!loading && !error && (
        changes && changes.files.length > 0 ? (
          <div className="max-h-40 overflow-y-auto py-1">
            <FileChangeList files={changes.files} indentClass="pl-2" />
            {changes.truncated && (
              <div className="px-2 py-0.5 text-[10px] text-text-muted">
                Showing {changes.files.length} of {changes.totalFiles} files
              </div>
            )}
          </div>
        ) : (
          <p className="px-2 py-2 text-xs text-text-muted">
            {changes?.baseRef
              ? 'This branch has no changes against the base — there would be nothing to review.'
              : `No ref for "${baseBranch}" exists locally, so the comparison could not run. The pull request itself is unaffected.`}
          </p>
        )
      )}

      {showDiff && (
        <div className="border-t border-border-secondary">
          {diffLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-tertiary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Reading the patch…
            </div>
          ) : diffError ? (
            <p className="p-2 text-xs text-status-error">{diffError}</p>
          ) : diffFiles.length === 0 ? (
            <p className="p-2 text-xs text-text-muted">The patch is empty.</p>
          ) : (
            <>
              {diff?.truncated && (
                <p className="border-b border-border-secondary px-2 py-1 text-[10px] text-status-warning">
                  This diff is too large to show in full — the rest is on GitHub once the pull request exists.
                </p>
              )}
              <div className="max-h-80 overflow-auto">
                <div className="space-y-3">{diffFiles.map(file => (
                  <section key={file.path} aria-label={file.path}>
                    <h4 className="px-2 py-1 text-xs text-text-secondary">{file.path}</h4>
                    {file.isBinary ? <p className="p-2 text-xs text-text-tertiary">Binary file</p> : <DiffView data={{ oldFile: { fileName: file.oldPath }, newFile: { fileName: file.path }, hunks: [file.rawDiff] }} diffViewMode={DiffModeEnum.Unified} diffViewTheme={isLightTheme(theme) ? 'light' : 'dark'} diffViewWrap={true} diffViewFontSize={13} />}
                  </section>
                ))}</div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
