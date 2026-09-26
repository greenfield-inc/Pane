import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import type { DiffHighlighter } from '@git-diff-view/shiki';
import { ExternalLink, FileDiff as FileDiffIcon, RefreshCw } from 'lucide-react';
import type { EditorDiffRef } from '../../../../../shared/types/panels';
import type { FileDiffResult } from '../../../../../shared/types/gitDiff';
import { isLightTheme, useTheme } from '../../../contexts/ThemeContext';
import { openFileInEditor } from '../../../services/openFileInEditor';
import { API } from '../../../utils/api';
import { subscribeToSessionGitChanges } from '../../../utils/session-git-events';
import { diffRefLabel, isMutableScope, normalizeEditorDiffRef, scopeKey } from './diffScope';
import { getShikiHighlighter } from './diffSource';
import '@git-diff-view/react/styles/diff-view.css';

interface DiffTabViewProps { sessionId: string; filePath: string; diffRef: EditorDiffRef }
const resultCache = new Map<string, FileDiffResult>();
const MAX_CACHE_ENTRIES = 50;

interface FileDiffLoadState {
  key: string;
  result: FileDiffResult | null;
  loading: boolean;
  error: string | null;
}

const readViewType = (): DiffModeEnum => localStorage.getItem('diffViewType') === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified;

export function DiffTabView({ sessionId, filePath, diffRef }: DiffTabViewProps) {
  const { theme } = useTheme();
  const normalized = useMemo(() => normalizeEditorDiffRef(diffRef), [diffRef]);
  const requestKey = normalized
    ? `${sessionId}:${scopeKey(normalized.scope)}:${filePath}:${normalized.previousPath ?? ''}`
    : `${sessionId}:legacy:${filePath}`;
  const [loadState, setLoadState] = useState<FileDiffLoadState>({ key: '', result: null, loading: true, error: null });
  const ownedState = loadState.key === requestKey
    ? loadState
    : { key: requestKey, result: null, loading: true, error: null };
  const { result, loading, error } = ownedState;
  const [highlighter, setHighlighter] = useState<DiffHighlighter | null>(null);
  const [viewType, setViewType] = useState<DiffModeEnum>(readViewType);
  const [reloadTick, setReloadTick] = useState(0);
  const requestId = useRef(0);

  useEffect(() => { void getShikiHighlighter().then(setHighlighter); }, []);

  useEffect(() => {
    const owned = ++requestId.current;
    if (!normalized) {
      setLoadState({
        key: requestKey,
        result: null,
        loading: false,
        error: 'This diff tab was saved by an earlier Pane version — reopen it from Changes.',
      });
      return;
    }
    const cached = resultCache.get(requestKey);
    if (cached && !isMutableScope(normalized.scope)) {
      setLoadState({ key: requestKey, result: cached, loading: false, error: null });
      return;
    }
    setLoadState({ key: requestKey, result: null, loading: true, error: null });
    void API.sessions.getFileDiff(sessionId, normalized.scope, { path: filePath, previousPath: normalized.previousPath }).then(response => {
      if (owned !== requestId.current) return;
      if (!response.success || !response.data) throw new Error(`${response.code ? `${response.code}: ` : ''}${response.error || 'Failed to load diff'}`);
      setLoadState({ key: requestKey, result: response.data, loading: false, error: null });
      if (!isMutableScope(normalized.scope)) {
        resultCache.set(requestKey, response.data);
        while (resultCache.size > MAX_CACHE_ENTRIES) resultCache.delete(resultCache.keys().next().value!);
      }
    }).catch(cause => {
      if (owned === requestId.current) {
        setLoadState({
          key: requestKey,
          result: null,
          loading: false,
          error: cause instanceof Error ? cause.message : 'Failed to load diff',
        });
      }
    });
  }, [filePath, normalized, reloadTick, requestKey, sessionId]);

  useEffect(() => {
    if (!normalized || !isMutableScope(normalized.scope)) return;
    return subscribeToSessionGitChanges(sessionId, () => setReloadTick(value => value + 1));
  }, [normalized, sessionId]);

  const handleViewTypeChange = useCallback((mode: DiffModeEnum) => {
    setViewType(mode);
    localStorage.setItem('diffViewType', mode === DiffModeEnum.Split ? 'split' : 'inline');
  }, []);

  const diffData = useMemo(() => {
    if (!result || result.status !== 'changed' || result.file.isBinary || !result.patch.includes('@@')) return null;
    return {
      oldFile: { fileName: result.file.previousPath ?? result.file.path },
      newFile: { fileName: result.file.path },
      hunks: [result.patch],
    };
  }, [result]);
  const canOpenFile = result !== null && result.file.kind !== 'deleted';

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <div className="flex min-w-0 items-center gap-2"><FileDiffIcon className="h-4 w-4 flex-shrink-0 text-text-tertiary" /><span className="truncate text-sm text-text-primary">{filePath}</span><span className="text-xs text-text-tertiary">{diffRefLabel(diffRef)}</span>{result && <span className="text-xs tabular-nums"><span className="text-status-success">+{result.file.additions ?? '—'}</span> <span className="text-status-error">-{result.file.deletions ?? '—'}</span></span>}</div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {canOpenFile && <button type="button" onClick={() => { void openFileInEditor({ sessionId, filePath, pin: true }); }} className="flex items-center gap-1 rounded-md border border-border-primary bg-surface-tertiary px-2 py-1 text-xs text-text-secondary" aria-label={`Open ${filePath} in Editor`}><ExternalLink className="h-3 w-3" />Open file</button>}
          <div className="inline-flex rounded-md border border-border-primary bg-surface-primary"><button type="button" onClick={() => handleViewTypeChange(DiffModeEnum.Unified)} aria-pressed={viewType === DiffModeEnum.Unified} className="px-2.5 py-1 text-xs">Unified</button><button type="button" onClick={() => handleViewTypeChange(DiffModeEnum.Split)} aria-pressed={viewType === DiffModeEnum.Split} className="px-2.5 py-1 text-xs">Split</button></div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !result ? <div className="flex items-center gap-2 p-4 text-sm text-text-secondary"><RefreshCw className="h-3.5 w-3.5 animate-spin" />Loading diff…</div>
          : error ? <div role="alert" className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">{error}</div>
            : !result || result.status === 'no-longer-changed' ? <div className="p-4 text-sm text-text-tertiary">{filePath} is no longer changed in {diffRefLabel(diffRef)}.</div>
              : result.file.isBinary ? <div className="p-4 text-sm text-text-secondary">Binary file</div>
                : diffData ? <DiffView data={diffData} diffViewMode={viewType} diffViewTheme={isLightTheme(theme) ? 'light' : 'dark'} diffViewHighlight={Boolean(highlighter)} registerHighlighter={highlighter ?? undefined} diffViewWrap={true} diffViewFontSize={13} />
                  : <div className="p-4 text-sm text-text-tertiary">{result.file.kind === 'renamed' ? `Renamed from ${result.file.previousPath} → ${result.file.path}, no content changes` : 'No content changes'}</div>}
      </div>
    </div>
  );
}
