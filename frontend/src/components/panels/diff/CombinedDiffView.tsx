import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { ChangedFileSummary, DiffManifest, DiffScope } from '../../../../../shared/types/gitDiff';
import type { CombinedDiffViewProps, ExecutionDiff } from '../../../types/diff';
import { API } from '../../../utils/api';
import { CommitDialog } from '../../CommitDialog';
import { editorPanelState, openFileInEditor } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
import { ChangesList } from './ChangesList';
import { buildChangesRows, type ChangesRow } from './changesListModel';
import { editorDiffRefForFile, isMutableScope, normalizeEditorDiffRef, sameScope, scopeKey, scopeLabel } from './diffScope';
import { clearPendingViewCommit, takePendingViewCommit } from './pendingViewCommit';

const SESSION_SCOPE: DiffScope = { kind: 'session' };

export interface CombinedDiffViewHandle { refresh: () => void }

/** One loaded scope: the request-side scope, its manifest, and the rows derived from it exactly once. */
interface LoadedScope { key: string; scope: DiffScope; manifest: DiffManifest; rows: ChangesRow[] }

const loadScope = (key: string, scope: DiffScope, manifest: DiffManifest): LoadedScope =>
  ({ key, scope, manifest, rows: buildChangesRows(manifest.files) });

const CombinedDiffView = memo(forwardRef<CombinedDiffViewHandle, CombinedDiffViewProps>(function CombinedDiffView({
  sessionId,
  isGitOperationRunning = false,
  isMainRepo = false,
  isVisible = true,
}, ref) {
  const [executions, setExecutions] = useState<ExecutionDiff[]>([]);
  // The mount site keys this component by session, so per-session state starts fresh on a switch.
  const [scope, setScope] = useState<DiffScope>(SESSION_SCOPE);
  const [display, setDisplay] = useState<LoadedScope | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [mainBranch, setMainBranch] = useState('main');
  const [historySource, setHistorySource] = useState<'remote' | 'local' | 'branch'>(isMainRepo ? 'remote' : 'branch');
  const scopeCache = useRef(new Map<string, LoadedScope>());
  const requestId = useRef(0);
  const executionRequestId = useRef(0);

  const key = `${sessionId}:${scopeKey(scope)}`;
  const visible = display?.key === key ? display : null;
  const visibleManifest = visible?.manifest ?? null;
  const loading = loadingKey === key || (visible === null && error === null);

  // Only a diff tab whose scope matches the list's scope counts as the active file.
  const activeDiffPath = usePanelStore((state) => {
    const activeId = state.activePanels[sessionId];
    const active = (state.panels[sessionId] || []).find(panel => panel.id === activeId);
    const editor = active ? editorPanelState(active) : undefined;
    if (!editor?.diff) return null;
    const normalized = normalizeEditorDiffRef(editor.diff);
    return normalized && sameScope(normalized.scope, scope) ? editor.filePath : null;
  });

  const refresh = useCallback(() => {
    for (const [cacheKey, cached] of scopeCache.current) {
      if (isMutableScope(cached.scope)) scopeCache.current.delete(cacheKey);
    }
    requestId.current += 1;
    setRefreshNonce(value => value + 1);
  }, []);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  useEffect(() => {
    let cancelled = false;
    void API.sessions.getGitCommands(sessionId).then(response => {
      if (cancelled) return;
      if (!response.success || !response.data) return;
      const branch = response.data.originBranch || response.data.comparisonBaseBranch || 'main';
      setMainBranch(branch);
      if (isMainRepo) setHistorySource(response.data.originBranch ? 'remote' : 'local');
    }).catch(cause => {
      if (!cancelled) console.error('Failed to load git commands:', cause);
    });
    return () => { cancelled = true; };
  }, [isMainRepo, sessionId]);

  useEffect(() => {
    if (!isVisible) return;
    const owned = ++executionRequestId.current;
    setExecutionsLoading(true);
    void API.sessions.getExecutions(sessionId).then(response => {
      if (owned !== executionRequestId.current) return;
      if (!response.success) throw new Error(response.error || 'Failed to load commits');
      const data: ExecutionDiff[] = response.data ?? [];
      setExecutions(data);
      const metadata = data.find(execution => execution.comparison_branch || execution.history_source) ?? data[0];
      if (metadata?.comparison_branch) setMainBranch(metadata.comparison_branch);
      if (metadata?.history_source) setHistorySource(metadata.history_source);
    }).catch(cause => {
      if (owned === executionRequestId.current) setError(cause instanceof Error ? cause.message : 'Failed to load commits');
    }).finally(() => {
      if (owned === executionRequestId.current) setExecutionsLoading(false);
    });
  }, [isVisible, refreshNonce, sessionId]);

  useEffect(() => {
    const pending = takePendingViewCommit(sessionId);
    if (pending !== null) setScope(pending === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: pending });
    const handler = (event: Event) => {
      // SAFETY: This listener is registered only for the app-owned diff:view-commit event.
      const detail = (event as CustomEvent<{ sessionId: string; commitHash: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      setScope(detail.commitHash === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: detail.commitHash });
      clearPendingViewCommit();
    };
    window.addEventListener('diff:view-commit', handler);
    return () => window.removeEventListener('diff:view-commit', handler);
  }, [sessionId, setScope]);

  useEffect(() => {
    if (!isVisible) return;
    const owned = ++requestId.current;
    const cached = scopeCache.current.get(key);
    if (cached) {
      setDisplay(cached);
      setLoadingKey(null);
      setError(null);
      return;
    }
    setLoadingKey(key);
    setError(null);
    void API.sessions.getDiffManifest(sessionId, scope).then(response => {
      if (owned !== requestId.current) return;
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to load changes');
      const loaded = loadScope(key, scope, response.data);
      scopeCache.current.set(key, loaded);
      setDisplay(loaded);
    }).catch(cause => {
      if (owned === requestId.current) setError(cause instanceof Error ? cause.message : 'Failed to load changes');
    }).finally(() => {
      if (owned === requestId.current) setLoadingKey(null);
    });
  }, [isVisible, key, refreshNonce, scope, sessionId]);

  const handleFileOpen = useCallback((file: ChangedFileSummary, pin: boolean) => {
    void openFileInEditor({ sessionId, filePath: file.path, pin, diff: editorDiffRefForFile(scope, file) });
  }, [scope, sessionId]);

  const handleCommit = useCallback(async (message: string) => {
    const response = await window.electronAPI.invoke('git:commit', { sessionId, message });
    if (!response.success) throw new Error(response.error || 'Failed to commit changes');
    refresh();
  }, [refresh, sessionId]);

  const handleRevert = useCallback(async (commitHash: string) => {
    if (!window.confirm(`Revert commit ${commitHash.slice(0, 7)}?`)) return;
    const response = await window.electronAPI.invoke('git:revert', { sessionId, commitHash });
    if (!response.success) throw new Error(response.error || 'Failed to revert commit');
    refresh();
  }, [refresh, sessionId]);

  const handleRestore = useCallback(async () => {
    if (!window.confirm('Restore all uncommitted changes?')) return;
    const response = await window.electronAPI.invoke('git:restore', { sessionId });
    if (!response.success) throw new Error(response.error || 'Failed to restore changes');
    refresh();
  }, [refresh, sessionId]);

  const label = scopeLabel(scope, { ref: visibleManifest?.resolvedBase.ref });
  const historyLabel = isMainRepo ? (historySource === 'local' ? 'Local commits' : mainBranch) : null;
  const headerLabel = historyLabel ? `${historyLabel} · ${label}` : label;
  const busy = loading || executionsLoading || isGitOperationRunning;
  const hasUncommitted = executions.some(execution => execution.id === 0 && execution.stats_files_changed > 0);
  const emptyMessage = isMainRepo && executions.length === 0
    ? historySource === 'remote'
      ? `No commits ahead of ${mainBranch}`
      : 'Origin remote not found; showing recent local commits'
    : 'No changes to review';

  return (
    <div className="combined-diff-view flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border-primary bg-surface-secondary px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-text-secondary">{headerLabel}</span>
          {visibleManifest && (
            <div className="flex flex-shrink-0 items-center gap-2 text-xs">
              <span className="font-semibold text-status-success">+{visibleManifest.stats.additions}</span>
              <span className="font-semibold text-status-error">-{visibleManifest.stats.deletions}</span>
              <span className="text-text-muted">{visibleManifest.stats.filesChanged}f</span>
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {scope.kind !== 'session' && (
            <button type="button" onClick={() => setScope({ kind: 'session' })} className="rounded px-1.5 py-0.5 text-[11px] font-medium text-text-tertiary hover:bg-surface-hover hover:text-text-primary">
              All changes
            </button>
          )}
          {hasUncommitted && (
            <>
              <button type="button" onClick={() => setShowCommitDialog(true)} className="rounded px-1.5 py-0.5 text-[11px] font-medium text-status-success hover:bg-status-success/15">Commit</button>
              <button type="button" onClick={handleRestore} title="Restore all uncommitted changes" className="rounded px-1.5 py-0.5 text-[11px] font-medium text-status-warning hover:bg-status-warning/15">Restore</button>
            </>
          )}
          {scope.kind === 'commit' && (
            <button type="button" onClick={() => handleRevert(scope.hash)} aria-label="Revert this commit" className="rounded p-1 text-text-muted hover:bg-status-error/10 hover:text-status-error">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button type="button" onClick={refresh} disabled={busy} className="rounded p-1 hover:bg-surface-hover" title="Refresh">
            <RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="diff-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary">
        {isGitOperationRunning ? (
          <div className="flex h-full flex-col items-center justify-center p-8">
            <RefreshCw className="mb-4 h-12 w-12 animate-spin text-interactive" />
            <div className="text-center text-text-secondary">
              <p className="font-medium">Git operation in progress</p>
              <p className="mt-1 text-sm text-text-tertiary">Please wait while the operation completes...</p>
            </div>
          </div>
        ) : loading && !visibleManifest ? <div className="animate-pulse p-4 text-sm text-text-secondary">Loading {label}…</div>
          : error ? <div role="alert" className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">{error}</div>
            : visible && visible.manifest.files.length > 0 ? <ChangesList sessionId={sessionId} rows={visible.rows} scopeKey={scopeKey(scope)} activePath={activeDiffPath} onFileOpen={handleFileOpen} />
              : <div className="flex h-full items-center justify-center text-sm text-text-secondary"><div className="space-y-2 text-center"><p>{emptyMessage}</p>{isMainRepo && historySource === 'remote' && <p className="text-sm text-text-tertiary">Create new commits to see them here.</p>}</div></div>}
      </div>
      <CommitDialog isOpen={showCommitDialog} onClose={() => setShowCommitDialog(false)} onCommit={handleCommit} fileCount={visibleManifest?.stats.filesChanged ?? 0} />
    </div>
  );
}));

CombinedDiffView.displayName = 'CombinedDiffView';
export default CombinedDiffView;
