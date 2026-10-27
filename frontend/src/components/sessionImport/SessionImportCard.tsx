import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, LayoutGrid, Loader2, RefreshCw } from 'lucide-react';
import { API } from '../../utils/api';
import { cn } from '../../utils/cn';
import { formatDistanceToNow } from '../../utils/timestampUtils';
import { Button } from '../ui/Button';
import { ClaudeIcon, OpenAIIcon } from '../ui/BrandIcons';
import type {
  ImportSession,
  SessionImportProgress,
  SessionImportRunResult,
  SessionImportScan,
  SessionImportSource,
} from '../../../../shared/types/sessionImport';
import {
  EMPTY_STATE,
  SOURCE_LABELS,
  TOOL_NAMES,
  captureSessionImport,
  isRunningElsewhere,
  isSelectable,
  listedSources,
  resultHeadline,
  rowMeta,
  sessionStatus,
  type SessionImportSurface,
} from './sessionImportCopy';

const PROGRESS_POLL_MS = 500;

export const SESSION_IMPORT_TITLE = 'Bring your sessions into Pane';
const SUBTITLE = 'Pane found recent agent work on this computer. Each session opens as its own Pane, with the agent resumed.';

function SourceIcon({ source }: { source: SessionImportSource }) {
  if (source === 'claude') return <ClaudeIcon className="h-4 w-4 flex-none" />;
  if (source === 'codex') return <OpenAIIcon className="h-4 w-4 flex-none" />;
  return <LayoutGrid className="h-4 w-4 flex-none text-text-secondary" aria-hidden />;
}

interface SessionImportCardProps {
  surface: SessionImportSurface;
  scan: SessionImportScan;
  /** "Not now" before an import, "Done" after one. */
  onClose: (finished: boolean) => void;
  /** Called with the new scan after "Check again". */
  onRescanned?: (scan: SessionImportScan) => void;
}

/** The "Bring your sessions into Pane" card, used on Home and in a Settings dialog. */
export function SessionImportCard({ surface, scan, onClose, onRescanned }: SessionImportCardProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(scan.sessions.filter(session => session.preselected).map(session => session.key)));
  const [expanded, setExpanded] = useState<SessionImportSource | null>(null);
  const [progress, setProgress] = useState<SessionImportProgress | undefined>();
  const [result, setResult] = useState<SessionImportRunResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const shownRef = useRef(false);
  const working = Boolean(progress?.running);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    captureSessionImport('shown', surface, scan);
  }, [surface, scan]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => {
      void API.sessionImport.progress().then(next => setProgress(previous => previous?.running ? { ...next, running: true } : previous)).catch(() => undefined);
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  const bringIn = async () => {
    const keys = [...selected];
    setError(undefined);
    setProgress({ running: true, done: {}, total: {} });
    captureSessionImport('started', surface, scan, { selected: keys.length });
    try {
      const outcome = await API.sessionImport.run(keys);
      setResult(outcome);
      captureSessionImport('finished', surface, scan, { selected: keys.length, result: outcome });
      window.dispatchEvent(new Event('project-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProgress(undefined);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      const next = await API.sessionImport.scan();
      setSelected(previous => new Set(next.sessions.filter(session => isSelectable(session) && (previous.has(session.key) || session.preselected)).map(session => session.key)));
      onRescanned?.(next);
    } finally {
      setChecking(false);
    }
  };

  const toggle = (key: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const anyRunning = scan.sessions.some(isRunningElsewhere);
  const empty = listedSources(scan).length === 0;

  return (
    <div className="w-full rounded-2xl border border-border-secondary bg-surface-primary p-5 shadow-sm" data-testid="session-import-card">
      <div className="flex items-center gap-2.5">
        <RefreshCw className="h-[18px] w-[18px] flex-none text-interactive" aria-hidden />
        <h2 className="text-base font-semibold text-text-primary">{SESSION_IMPORT_TITLE}</h2>
      </div>
      {empty ? (
        <>
          <p className="mt-2 text-sm text-text-tertiary">{EMPTY_STATE}</p>
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => onClose(false)}>Close</Button>
          </div>
        </>
      ) : result ? (
        <ImportResult result={result} runningElsewhere={scan.sessions.filter(isRunningElsewhere).length} onDone={() => onClose(true)} />
      ) : (
        <>
          <p className="mt-1.5 text-sm text-text-tertiary">{SUBTITLE}</p>
          <ImportRows scan={scan} selected={selected} progress={progress} expanded={expanded} onExpand={setExpanded} onToggle={toggle} disabled={working} />
          <ReadDisclosure scan={scan} />
          {error && <p className="mt-2 text-sm text-status-error" role="alert">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            {anyRunning && (
              <Button variant="ghost" size="sm" onClick={() => void checkAgain()} disabled={working || checking}>Check again</Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => { captureSessionImport('dismissed', surface, scan); onClose(false); }} disabled={working}>Not now</Button>
              <Button size="sm" onClick={() => void bringIn()} disabled={working || selected.size === 0} aria-busy={working}>
                {/* Both labels share one grid cell, so the button keeps the wider one's size in either state. */}
                <span className="grid">
                  <span className={cn('[grid-area:1/1] inline-flex items-center justify-center', working && 'invisible')}>Bring them in</span>
                  <span className={cn('[grid-area:1/1] inline-flex items-center justify-center gap-1.5 whitespace-nowrap', !working && 'invisible')} aria-hidden={!working}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Bringing them in…
                  </span>
                </span>
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface ImportRowsProps {
  scan: SessionImportScan;
  selected: ReadonlySet<string>;
  progress?: SessionImportProgress;
  expanded: SessionImportSource | null;
  onExpand: (source: SessionImportSource | null) => void;
  onToggle: (key: string) => void;
  disabled?: boolean;
}

/** One row per tool; a row opens into its sessions grouped by repository. */
export function ImportRows({ scan, selected, progress, expanded, onExpand, onToggle, disabled }: ImportRowsProps) {
  const sources = listedSources(scan);
  return (
    <div className="mt-3 space-y-1.5">
      {sources.map(source => {
        const unreadable = scan.sources.some(summary => summary.source === source && summary.status === 'unreadable');
        const open = expanded === source && !unreadable;
        return (
          <div key={source} className={cn('rounded-lg border bg-surface-secondary', open ? 'border-border-primary' : 'border-border-secondary')}>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary disabled:cursor-default"
              onClick={() => onExpand(open ? null : source)}
              disabled={unreadable}
              aria-expanded={unreadable ? undefined : open}
            >
              <SourceIcon source={source} />
              <span className="min-w-0 truncate">{SOURCE_LABELS[source]}</span>
              <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-text-tertiary" title={unreadable ? scan.sources.find(summary => summary.source === source)?.reason : undefined}>
                {rowMeta(source, scan, selected, progress)}
              </span>
              <ChevronRight className={cn('h-3.5 w-3.5 flex-none text-text-tertiary transition-transform', open && 'rotate-90', unreadable && 'invisible')} aria-hidden />
            </button>
            {open && <SourceSessions sessions={scan.sessions.filter(session => session.source === source)} selected={selected} onToggle={onToggle} disabled={disabled} />}
          </div>
        );
      })}
    </div>
  );
}

function SourceSessions({ sessions, selected, onToggle, disabled }: { sessions: ImportSession[]; selected: ReadonlySet<string>; onToggle: (key: string) => void; disabled?: boolean }) {
  const groups = useMemo(() => {
    const byRepo = new Map<string, ImportSession[]>();
    for (const session of sessions) {
      const repo = session.repoName ?? 'Other folders';
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), session]);
    }
    return [...byRepo.entries()];
  }, [sessions]);
  const runningTool = sessions.find(isRunningElsewhere)?.source;
  return (
    <div className="border-t border-border-secondary px-3 pb-2 pt-1">
      {groups.map(([repo, repoSessions]) => (
        <div key={repo} className="mt-1.5">
          <div className="text-xs font-medium text-text-secondary">{repo}</div>
          {repoSessions.map(session => {
            const status = sessionStatus(session);
            const selectable = isSelectable(session);
            return (
              <label key={session.key} className={cn('mt-1 flex items-start gap-2 text-sm', selectable ? 'cursor-pointer' : 'cursor-default')}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 flex-none accent-interactive"
                  checked={selected.has(session.key)}
                  disabled={!selectable || disabled}
                  onChange={() => onToggle(session.key)}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate', selectable ? 'text-text-primary' : 'text-text-tertiary')}>{session.title ?? session.sessionId}</span>
                  <span className="block truncate text-xs text-text-tertiary">
                    {[session.branch, formatDistanceToNow(new Date(session.lastActiveMs)), status].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
      {runningTool && (
        <p className="mt-2 text-xs text-text-tertiary">
          Quit it in {TOOL_NAMES[runningTool]} and press Check again, or say &quot;migrate to Pane&quot; in Pane Chat to fork it.
        </p>
      )}
    </div>
  );
}

function ReadDisclosure({ scan }: { scan: SessionImportScan }) {
  const paths = scan.sources.flatMap(summary => summary.storePaths);
  return (
    <div className="mt-2 text-xs text-text-tertiary">
      Read from session lists on this computer. Session details never leave it.{' '}
      {paths.length > 0 && (
        <details className="inline">
          <summary className="inline cursor-pointer text-interactive">What Pane reads</summary>
          <ul className="mt-1 space-y-0.5 break-all font-mono">
            {paths.map(storePath => <li key={storePath}>{storePath}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

interface ImportResultProps {
  result: SessionImportRunResult;
  runningElsewhere: number;
  onDone: () => void;
}

export function ImportResult({ result, runningElsewhere, onDone }: ImportResultProps) {
  const failed = result.results.filter(entry => entry.outcome === 'not continued');
  const waiting = result.results.filter(entry => entry.outcome === 'waiting for trust');
  const starting = result.results.filter(entry => entry.outcome === 'still starting');
  const skipped = result.results.filter(entry => entry.outcome === 'skipped running').length + runningElsewhere;
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="text-text-primary">{resultHeadline(result)}</p>
      {waiting.length > 0 && (
        <div className="text-text-secondary">
          {waiting.length} waiting for you to trust {waiting.length === 1 ? 'its folder' : 'their folders'}:
          <ul className="mt-1 list-disc pl-5 text-xs text-text-tertiary">
            {waiting.map(entry => <li key={entry.key}>{entry.paneName} · {entry.title ?? 'session'}: answer the trust prompt in its tab</li>)}
          </ul>
        </div>
      )}
      {starting.length > 0 && (
        <div className="text-text-secondary">
          {starting.length} still starting:
          <ul className="mt-1 list-disc pl-5 text-xs text-text-tertiary">
            {starting.map(entry => <li key={entry.key}>{entry.paneName} · {entry.title ?? 'session'}: its agent is up but slow; check its tab</li>)}
          </ul>
        </div>
      )}
      {failed.length > 0 && (
        <details>
          <summary className="cursor-pointer text-status-warning">{failed.length} not continued</summary>
          <ul className="mt-1 space-y-1 pl-4 text-xs text-text-tertiary">
            {failed.map(entry => <li key={entry.key}><span className="text-text-secondary">{entry.title ?? entry.key}</span>: {entry.reason}</li>)}
          </ul>
        </details>
      )}
      {skipped > 0 && <p className="text-text-tertiary">{skipped} still running elsewhere</p>}
      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
