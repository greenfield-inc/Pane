import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Copy, GitBranch, Hash, Loader2, MoreHorizontal, PanelRight, RefreshCw, Search, Tag, X,
} from 'lucide-react';
import { API } from '../../utils/api';
import { Dropdown } from '../ui/Dropdown';
import { computeGitGraphLayout } from '../../utils/gitGraphLayout';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { GitGraphCanvas } from './GitGraphCanvas';
import { LANE_WIDTH, ROW_HEIGHT, laneColor } from './graphColors';
import { GitGraphCommitDetail } from './GitGraphCommitDetail';
import {
  GRAPH_REMOTE_ALL,
  GRAPH_REMOTE_NONE,
  MAX_GRAPH_LIMIT,
  type GitGraphNode,
  type PaneWorktreeRef,
  type RepoGitGraph,
  type RepoGitGraphRequest,
} from '../../../../shared/types/gitGraph';

/** Rows rendered outside the viewport on each side, to hide scroll seams. */
const VIRTUALIZE_OVERSCAN = 8;
/** Below this many commits, virtualisation costs more than it saves. */
const VIRTUALIZE_THRESHOLD = 200;
/** A repo-wide `--all` log is expensive; coalesce refresh triggers. */
const REFRESH_DEBOUNCE_MS = 2000;

const LIMIT_OPTIONS = [100, 300, 1000] as const;
/**
 * Ref chips shown inline before a subject. Past this many the row is all
 * chips and no commit message — the rest collapse into a "+N" pill.
 */
const INLINE_REFS = 2;
/**
 * Lanes the gutter reserves. A repository with thirty concurrent branches
 * would otherwise push the commit text halfway across the window.
 */
const MAX_GUTTER_LANES = 8;
const DETAIL_MIN_PERCENT = 25;
const DETAIL_MAX_PERCENT = 70;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * "2h", "3d" — a fixed-width age, so the right-hand column lines up and the
 * eye can scan down it. The exact timestamp lives in the row's tooltip.
 */
function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable colour per author, so the same person keeps the same badge. */
function authorColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return laneColor(Math.abs(hash));
}

function RefChip({
  name,
  kind,
  isCurrent,
  ahead,
  behind,
  worktree,
  isFocused,
  onFocus,
}: {
  name: string;
  kind: string;
  isCurrent: boolean;
  ahead?: number;
  behind?: number;
  worktree?: PaneWorktreeRef;
  isFocused: boolean;
  onFocus: (ref: string) => void;
}) {
  const Icon = kind === 'tag' ? Tag : GitBranch;
  const tone = isFocused
    ? 'border-interactive bg-interactive/25 text-interactive'
    : kind === 'tag'
      ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
      : worktree
        ? 'border-interactive/50 bg-interactive/15 text-interactive'
        : isCurrent
          ? 'border-status-success/40 bg-status-success/10 text-status-success'
          : 'border-border-secondary bg-surface-tertiary text-text-secondary';

  // The session name is only worth appending when it says something the branch
  // name does not — otherwise the chip reads "archive · archive".
  const sessionLabel = worktree?.sessionName && worktree.sessionName.toLowerCase() !== name.toLowerCase()
    ? worktree.sessionName
    : null;

  const divergence = [
    ahead ? `${ahead} ahead` : null,
    behind ? `${behind} behind` : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      onClick={event => { event.stopPropagation(); onFocus(name); }}
      aria-pressed={isFocused}
      className={`pointer-events-auto inline-flex max-w-[14rem] flex-shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] leading-tight transition-colors hover:brightness-125 ${tone}`}
      title={[
        worktree ? `${name} — checked out in Pane session "${worktree.sessionName ?? worktree.path}"` : name,
        divergence ? `${divergence} vs the current branch` : null,
        'Click to show only this history',
      ].filter(Boolean).join('\n')}
    >
      <Icon className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
      <span className="truncate font-mono">{name}</span>
      {sessionLabel && <span className="truncate opacity-80">{sessionLabel}</span>}
      {(ahead || behind) && (
        <span className="flex-shrink-0 tabular-nums opacity-80">
          {ahead ? `↑${ahead}` : ''}{behind ? `↓${behind}` : ''}
        </span>
      )}
    </button>
  );
}

type SessionWorktree = PaneWorktreeRef & { sessionId: string };

function hasSessionId(worktree: PaneWorktreeRef | undefined): worktree is SessionWorktree {
  return worktree?.sessionId !== undefined;
}

export interface GitGraphViewProps {
  projectId: number;
  projectName?: string;
}

/**
 * Repository-wide commit graph: every branch and tag in one lane diagram,
 * with Pane's own worktrees highlighted and a per-commit detail pane.
 *
 * Scoped to a project rather than a session, which is why it is a top-level
 * view instead of a `ToolPanelType` — panels are session-keyed.
 */
export function GitGraphView({ projectId, projectName }: GitGraphViewProps) {
  const [graph, setGraph] = useState<RepoGitGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(LIMIT_OPTIONS[1]);
  /**
   * Which remote's branches are graphed. Undefined until the first response
   * says which one the repository defaulted to.
   */
  const [remoteScope, setRemoteScope] = useState<string | undefined>(undefined);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  /** Free-text filter over subject, author and hash. */
  const [query, setQuery] = useState('');
  /** Ref the history is narrowed to, if any. */
  const [focusRef, setFocusRef] = useState<string | undefined>(undefined);
  const [detailPercent, setDetailPercent] = useState(46);
  const [detailHidden, setDetailHidden] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const sessions = useSessionStore(state => state.sessions);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    const requestId = ++requestIdRef.current;
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);

    try {
      const request: RepoGitGraphRequest = { projectId, limit };
      if (remoteScope !== undefined) request.remoteScope = remoteScope;
      if (focusRef) request.focusRef = focusRef;
      const response = await API.projects.getGitGraph(request);
      if (requestId !== requestIdRef.current) return;
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to load repository graph');
      }
      setGraph(response.data);
      // Adopt whatever the repository defaulted to, so the picker agrees with
      // what is on screen.
      setRemoteScope(response.data.remoteScope);
      setError(null);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load repository graph');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [projectId, limit, remoteScope, focusRef]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  // Git operations elsewhere in the app invalidate the graph. A repo-wide
  // `--all` log per event would be far too heavy, so refreshes are debounced.
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void load('refresh'); }, REFRESH_DEBOUNCE_MS);
    };

    window.addEventListener('git-status-updated', schedule);
    window.addEventListener('panel:event', schedule);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('git-status-updated', schedule);
      window.removeEventListener('panel:event', schedule);
    };
  }, [load]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [graph]);

  const layout = useMemo(() => computeGitGraphLayout(graph?.nodes ?? []), [graph]);

  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, PaneWorktreeRef>();
    for (const worktree of graph?.paneWorktrees ?? []) {
      if (worktree.branch) map.set(worktree.branch, worktree);
    }
    return map;
  }, [graph]);

  /**
   * Rows matching the filter.
   *
   * Filtering hides rows, which would leave the lane edges pointing at commits
   * that are no longer there — so a filtered list drops the lane drawing and
   * shows a plain marker instead. Honest, and what a search result should look
   * like anyway.
   */
  const isFiltering = query.trim().length > 0;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return layout.rows;
    return layout.rows.filter(row =>
      row.node.subject.toLowerCase().includes(needle)
      || row.node.authorName.toLowerCase().includes(needle)
      || row.node.authorEmail.toLowerCase().includes(needle)
      || row.node.hash.toLowerCase().startsWith(needle)
      || row.node.refs.some(ref => ref.name.toLowerCase().includes(needle))
    );
  }, [layout.rows, query]);

  const selectedNode: GitGraphNode | null = useMemo(
    () => layout.rows.find(row => row.node.hash === selectedHash)?.node ?? null,
    [layout.rows, selectedHash]
  );

  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD && viewportHeight > 0;
  const firstVisible = shouldVirtualize
    ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRTUALIZE_OVERSCAN)
    : 0;
  const lastVisible = shouldVirtualize
    ? Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + VIRTUALIZE_OVERSCAN)
    : rows.length;
  const visibleRows = rows.slice(firstVisible, lastVisible);

  const gutterWidth = Math.min(Math.max(layout.laneCount, 1), MAX_GUTTER_LANES) * LANE_WIDTH;

  const openSession = useCallback((sessionId: string) => {
    void setActiveSession(sessionId).then(() => navigateToSessions());
  }, [setActiveSession, navigateToSessions]);

  /**
   * Sessions of this project with uncommitted work.
   *
   * Git knows nothing about them — they are the rows above the newest commit
   * that every other client calls "WIP", and the reason Pane can draw them at
   * all is that it tracks each worktree's status itself.
   */
  const dirtySessions = useMemo(() => sessions.filter(session =>
    session.projectId === projectId
    && !session.archived
    && session.gitStatus
    && ['modified', 'untracked', 'conflict'].includes(session.gitStatus.state)
  ), [sessions, projectId]);

  /** Newest commit is selected on arrival: an empty detail pane says nothing. */
  useEffect(() => {
    if (!selectedHash && layout.rows.length > 0) setSelectedHash(layout.rows[0].node.hash);
  }, [selectedHash, layout.rows]);

  const moveSelection = useCallback((delta: number | 'first' | 'last') => {
    if (rows.length === 0) return;
    const current = rows.findIndex(row => row.node.hash === selectedHash);
    const next = delta === 'first'
      ? 0
      : delta === 'last'
        ? rows.length - 1
        : Math.min(Math.max((current === -1 ? 0 : current) + delta, 0), rows.length - 1);

    setSelectedHash(rows[next].node.hash);

    // Keep the cursor inside the viewport; the list is virtualised, so this is
    // arithmetic on the scroll offset rather than a DOM lookup.
    const element = scrollRef.current;
    if (!element) return;
    const top = next * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  }, [rows, selectedHash]);

  /**
   * Arrow keys walk the history, `/` jumps to the filter, Escape backs out of
   * a filter or a focused branch. Bound on the document because the list is a
   * stack of buttons — without this the only way through 300 commits is the
   * mouse.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');

      if (typing) {
        if (event.key === 'Escape' && target === searchRef.current) {
          setQuery('');
          searchRef.current?.blur();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      switch (event.key) {
        case 'ArrowDown': case 'j': event.preventDefault(); moveSelection(1); break;
        case 'ArrowUp': case 'k': event.preventDefault(); moveSelection(-1); break;
        case 'PageDown': event.preventDefault(); moveSelection(10); break;
        case 'PageUp': event.preventDefault(); moveSelection(-10); break;
        case 'Home': event.preventDefault(); moveSelection('first'); break;
        case 'End': event.preventDefault(); moveSelection('last'); break;
        case '/': event.preventDefault(); searchRef.current?.focus(); break;
        case 'Escape':
          if (query) { event.preventDefault(); setQuery(''); }
          else if (focusRef) { event.preventDefault(); setFocusRef(undefined); }
          break;
        default: break;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [moveSelection, query, focusRef]);

  /** Drag the divider between the list and the detail pane. */
  const startDetailDrag = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    const container = splitRef.current;
    if (!container) return;

    const onMove = (move: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      const percent = ((rect.right - move.clientX) / rect.width) * 100;
      setDetailPercent(Math.min(Math.max(percent, DETAIL_MIN_PERCENT), DETAIL_MAX_PERCENT));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const copyToClipboard = useCallback((value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />
          <h1 className="truncate text-sm font-medium text-text-primary">Commit graph</h1>
          {/* One repository at a time — say which, always. */}
          <span className="truncate rounded bg-surface-tertiary px-1.5 py-px text-[11px] text-text-secondary">
            {projectName ?? 'this repository'}
          </span>
          {graph?.currentBranch && (
            <span className="truncate font-mono text-[11px] text-text-tertiary">on {graph.currentBranch}</span>
          )}
          {focusRef && (
            <button
              type="button"
              onClick={() => setFocusRef(undefined)}
              title="Show the whole repository again (Escape)"
              className="flex flex-shrink-0 items-center gap-1 rounded-full border border-interactive/50 bg-interactive/15 px-2 py-px text-[10px] text-interactive transition-colors hover:bg-interactive/25"
            >
              <GitBranch className="h-2.5 w-2.5" aria-hidden="true" />
              <span className="font-mono">{focusRef}</span>
              <X className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Filter commits  /"
              aria-label="Filter commits by subject, author, hash or ref"
              className="w-44 rounded border border-border-secondary bg-surface-primary py-0.5 pl-6 pr-2 text-[11px] text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none"
            />
          </div>

          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Number of commits to load</legend>
            {LIMIT_OPTIONS.map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={limit === option}
                onClick={() => setLimit(option)}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  limit === option
                    ? 'bg-interactive text-text-on-interactive'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {option}
              </button>
            ))}
          </fieldset>

          {/*
            A fork's clone carries `origin` and `upstream`, and those are two
            different repositories on the hosting side. Graphing every remote
            buried this project's history under the other one's branches, so
            the remote is an explicit choice that defaults to this repo's own.
          */}
          <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Remote</span>
            <select
              value={remoteScope}
              onChange={event => setRemoteScope(event.target.value)}
              className="rounded border border-border-secondary bg-surface-primary px-1.5 py-0.5 text-[11px] text-text-secondary focus:border-interactive focus:outline-none"
            >
              <option value={GRAPH_REMOTE_NONE}>Local only</option>
              {(graph?.remotes ?? []).map(remote => (
                <option key={remote} value={remote}>{remote}</option>
              ))}
              {(graph?.remotes.length ?? 0) > 1 && (
                <option value={GRAPH_REMOTE_ALL}>All remotes</option>
              )}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setDetailHidden(current => !current)}
            aria-pressed={!detailHidden}
            title={detailHidden ? 'Show the commit details' : 'Hide the commit details'}
            className="rounded p-1 transition-colors hover:bg-surface-hover"
          >
            <PanelRight className={`h-3.5 w-3.5 ${detailHidden ? 'text-text-muted' : 'text-text-tertiary'}`} aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => { void load('refresh'); }}
            disabled={loading || refreshing}
            aria-label="Refresh commit graph"
            className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-text-tertiary ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </header>

      {graph?.notice && (
        <div className="flex-shrink-0 border-b border-border-primary bg-surface-tertiary px-4 py-1 text-[11px] text-text-tertiary">
          {graph.notice}
        </div>
      )}

      {isFiltering && !loading && !error && (
        <div className="flex-shrink-0 border-b border-border-primary bg-surface-tertiary px-4 py-1 text-[11px] text-text-tertiary">
          {rows.length} of {layout.rows.length} commits match “{query.trim()}” — lanes are hidden while filtering.
        </div>
      )}

      {!isFiltering && layout.laneCount > MAX_GUTTER_LANES && (
        <div className="flex-shrink-0 border-b border-border-primary bg-surface-tertiary px-4 py-1 text-[11px] text-text-tertiary">
          {layout.laneCount} parallel branches in view; the gutter shows the first {MAX_GUTTER_LANES}.
          Focus a branch or switch the remote to narrow it down.
        </div>
      )}

      <div ref={splitRef} className="flex min-h-0 flex-1">
        {/* Commit list */}
        <div
          ref={scrollRef}
          onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
          className="min-w-0 flex-1 overflow-auto"
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Reading repository history…
            </div>
          ) : error ? (
            <div className="m-4 rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
              <p className="mb-1 font-medium">Could not load the commit graph</p>
              <p>{error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-secondary">
              {isFiltering ? `Nothing matches “${query.trim()}”.` : 'No commits to show yet.'}
            </div>
          ) : (
            <>
              {/*
                Work git has not been told about yet. Every other client calls
                this the WIP row; Pane can name the session it belongs to.
              */}
              {!isFiltering && dirtySessions.map(session => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => openSession(session.id)}
                  className="flex w-full items-center gap-2 border-b border-dashed border-border-secondary px-3 py-1.5 text-left transition-colors hover:bg-surface-hover"
                >
                  <span className="flex flex-shrink-0 justify-center" style={{ width: gutterWidth }}>
                    <span className="h-2 w-2 rounded-full border border-dashed border-text-muted" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                    Uncommitted changes in <span className="text-text-primary">{session.name}</span>
                  </span>
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-text-muted">
                    {session.gitStatus?.filesChanged ? `${session.gitStatus.filesChanged} files` : 'modified'}
                  </span>
                </button>
              ))}

              <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
                <div style={{ transform: `translateY(${firstVisible * ROW_HEIGHT}px)` }}>
                  {visibleRows.map(row => {
                    const isSelected = row.node.hash === selectedHash;
                    const accent = laneColor(row.colorIndex);
                    const inlineRefs = row.node.refs.slice(0, INLINE_REFS);
                    const hiddenRefs = row.node.refs.slice(INLINE_REFS);

                    return (
                      <div
                        key={row.node.hash}
                        className={`group relative flex w-full items-stretch transition-colors ${
                          isSelected ? 'bg-interactive/10' : 'hover:bg-surface-hover'
                        }`}
                        style={{ height: ROW_HEIGHT }}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedHash(row.node.hash)}
                          aria-pressed={isSelected}
                          aria-label={`Select commit ${row.node.subject}`}
                          title={`${row.node.subject}\n${row.node.shortHash} · ${row.node.authorName} <${row.node.authorEmail}> · ${formatDate(row.node.authorDate)}`}
                          className="absolute inset-0 z-0"
                        />
                        <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-stretch gap-2 pr-2 text-left">
                          {/*
                            Lanes past the gutter's width are clipped rather
                            than squeezed — the positions of the ones on screen
                            must not move because a thirty-branch repo exists.
                          */}
                          <span
                            className={`flex flex-shrink-0 items-center overflow-hidden ${isFiltering ? 'justify-center' : ''}`}
                            style={{ width: gutterWidth }}
                          >
                            {isFiltering ? (
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: accent }}
                                aria-hidden="true"
                              />
                            ) : (
                              <GitGraphCanvas row={row} laneCount={layout.laneCount} isSelected={isSelected} />
                            )}
                          </span>

                          <span className="flex min-w-0 flex-1 flex-col justify-center py-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              {inlineRefs.map(ref => (
                                <RefChip
                                  key={`${ref.kind}-${ref.name}`}
                                  name={ref.name}
                                  kind={ref.kind}
                                  isCurrent={ref.isCurrent}
                                  ahead={ref.ahead}
                                  behind={ref.behind}
                                  worktree={ref.kind === 'localBranch' ? worktreeByBranch.get(ref.name) : undefined}
                                  isFocused={focusRef === ref.name}
                                  onFocus={setFocusRef}
                                />
                              ))}
                              {hiddenRefs.length > 0 && (
                                <span
                                  className="flex-shrink-0 rounded border border-border-secondary bg-surface-tertiary px-1 text-[10px] text-text-tertiary"
                                  title={hiddenRefs.map(ref => ref.name).join('\n')}
                                >
                                  +{hiddenRefs.length}
                                </span>
                              )}
                              <span className="truncate text-xs leading-snug text-text-primary">
                                {row.node.subject}
                              </span>
                            </span>
                            <span className="flex items-center gap-1.5 text-[10px] leading-snug text-text-tertiary">
                              <span className="font-mono" style={{ color: accent }}>{row.node.shortHash}</span>
                              <span aria-hidden="true">·</span>
                              <span className="truncate">{row.node.authorName}</span>
                            </span>
                          </span>

                          {/* Fixed-width right column, so dates line up down the list. */}
                          <span className="flex flex-shrink-0 items-center gap-2 pl-2">
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-medium text-bg-primary"
                              style={{ backgroundColor: authorColor(row.node.authorEmail || row.node.authorName) }}
                              aria-hidden="true"
                            >
                              {initials(row.node.authorName)}
                            </span>
                            <span className="w-8 text-right text-[10px] tabular-nums text-text-muted">
                              {formatAge(row.node.authorDate)}
                            </span>
                          </span>
                        </div>

                        {/* Sibling of the row button — a button inside a button is invalid. */}
                        <div className="relative z-10 flex">
                          <Dropdown
                          position="bottom-right"
                          width="sm"
                          items={[
                            {
                              id: 'copy-sha',
                              label: 'Copy commit SHA',
                              icon: Copy,
                              onClick: () => copyToClipboard(row.node.hash),
                            },
                            {
                              id: 'copy-short',
                              label: `Copy ${row.node.shortHash}`,
                              icon: Hash,
                              onClick: () => copyToClipboard(row.node.shortHash),
                            },
                            {
                              id: 'copy-subject',
                              label: 'Copy subject',
                              icon: Copy,
                              onClick: () => copyToClipboard(row.node.subject),
                            },
                            ...row.node.refs
                              .map(ref => worktreeByBranch.get(ref.name))
                              .filter(hasSessionId)
                              .map(worktree => ({
                                id: `open-${worktree.sessionId}`,
                                label: `Open session “${worktree.sessionName ?? worktree.branch}”`,
                                icon: GitBranch,
                                onClick: () => openSession(worktree.sessionId),
                              })),
                          ]}
                          trigger={
                            <button
                              type="button"
                              aria-label={`Actions for ${row.node.shortHash}`}
                              className="mr-1 flex-shrink-0 self-center rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          }
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {graph?.truncated && !loading && !error && !isFiltering && (
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="text-[11px] text-text-muted">
                Showing the {graph.limit} most recent commits.
              </span>
              {limit < MAX_GRAPH_LIMIT && (
                <button
                  type="button"
                  onClick={() => setLimit(current => Math.min(
                    LIMIT_OPTIONS.find(option => option > current) ?? MAX_GRAPH_LIMIT,
                    MAX_GRAPH_LIMIT
                  ))}
                  disabled={refreshing}
                  className="rounded border border-border-secondary px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </div>

        {/* Detail pane */}
        {!detailHidden && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startDetailDrag}
              className="hidden w-1 flex-shrink-0 cursor-col-resize bg-border-primary transition-colors hover:bg-interactive lg:block"
            />
            <aside
              className="hidden min-w-0 flex-shrink-0 lg:flex lg:flex-col"
              style={{ width: `${detailPercent}%` }}
            >
              {selectedNode ? (
                <GitGraphCommitDetail projectId={projectId} node={selectedNode} />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-secondary">
                  Select a commit to see its changes.
                </div>
              )}
            </aside>
          </>
        )}
      </div>

      {/* Pane worktrees legend */}
      {(graph?.paneWorktrees.length ?? 0) > 0 && (
        <footer className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-border-primary bg-surface-secondary px-4 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Pane worktrees</span>
          {graph?.paneWorktrees.map(worktree => {
            const sessionId = worktree.sessionId;
            return sessionId ? (
              <button
                key={worktree.path}
                type="button"
                onClick={() => openSession(sessionId)}
                title={worktree.path}
                className="inline-flex items-center gap-1 rounded border border-interactive/40 bg-interactive/10 px-1.5 py-px text-[10px] text-interactive transition-colors hover:bg-interactive/20"
              >
                <GitBranch className="h-2.5 w-2.5" aria-hidden="true" />
                <span className="font-mono">{worktree.branch}</span>
                <span className="text-text-secondary">{worktree.sessionName}</span>
              </button>
            ) : (
              <span
                key={worktree.path}
                title={worktree.path}
                className="inline-flex items-center gap-1 rounded border border-border-secondary px-1.5 py-px font-mono text-[10px] text-text-tertiary"
              >
                {worktree.branch}{worktree.isMainCheckout ? ' (main checkout)' : ''}
              </span>
            );
          })}
        </footer>
      )}
    </div>
  );
}
