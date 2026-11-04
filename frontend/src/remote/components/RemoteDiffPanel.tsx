import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RotateCw } from 'lucide-react';
import type { ChangedFileSummary } from '../../../../shared/types/gitDiff';
import { changeBadge, DiffError, parsePatch, versusLabel, type ChangeList } from '../../../../shared/gitDiffClient';
import { cn } from '../../utils/cn';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };
type FilePatch = { patch: string; status: 'changed' | 'no-longer-changed' };

/** Rows drawn for one file; a longer patch is read on the computer. */
const PATCH_ROW_LIMIT = 1500;

const errorMessage = (error: Error) => error instanceof DiffError && error.code === 'diff-too-large'
  ? 'This patch is too large to show here. Open it in desktop Pane.'
  : error.message || 'The changes could not be read.';

/**
 * The PWA's Diff tab: the branch's changes, read-only, as the phone's Diff tab shows them.
 * Each file opens to its patch; the list follows the host's git status.
 */
export function RemoteDiffPanel({ adapter, sessionId }: { adapter: RemoteRuntimeAdapter; sessionId: string }) {
  const [changes, setChanges] = useState<Load<ChangeList>>({ status: 'loading' });
  const [patches, setPatches] = useState<Record<string, Load<FilePatch>>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const openRef = useRef(open);
  openRef.current = open;

  const fetchPatch = useCallback((file: Pick<ChangedFileSummary, 'path' | 'previousPath'>) => {
    adapter.diff.file(sessionId, file.previousPath ? { path: file.path, previousPath: file.previousPath } : { path: file.path }).then(
      value => setPatches(current => ({ ...current, [file.path]: { status: 'ready', value } })),
      (error: Error) => setPatches(current => ({ ...current, [file.path]: { status: 'error', message: errorMessage(error) } })),
    );
  }, [adapter, sessionId]);

  const load = useCallback(() => {
    adapter.diff.manifest(sessionId).then(
      value => {
        setChanges({ status: 'ready', value });
        // Open patches are reread with the list, so a patch never lags behind the counts above it.
        for (const file of value.files) if (openRef.current.has(file.path)) fetchPatch(file);
      },
      (error: Error) => setChanges({ status: 'error', message: errorMessage(error) }),
    );
  }, [adapter, fetchPatch, sessionId]);

  useEffect(() => {
    load();
    return adapter.onEvent(event => {
      // SAFETY: git-status-updated carries the changed Pane's { sessionId } first.
      if (event.channel === 'git-status-updated' && (event.args[0] as { sessionId?: string } | undefined)?.sessionId === sessionId) load();
    });
  }, [adapter, load, sessionId]);

  const toggle = (file: ChangedFileSummary) => {
    const opening = !open.has(file.path);
    setOpen(current => {
      const next = new Set(current);
      if (opening) next.add(file.path);
      else next.delete(file.path);
      return next;
    });
    if (opening && patches[file.path]?.status !== 'ready') {
      setPatches(current => ({ ...current, [file.path]: { status: 'loading' } }));
      fetchPatch(file);
    }
  };

  return <RemoteDiffView changes={changes} patches={patches} open={open} onToggle={toggle} onRefresh={() => { setChanges({ status: 'loading' }); load(); }} />;
}

export function RemoteDiffView({ changes, patches, open, onToggle, onRefresh }: {
  changes: Load<ChangeList>;
  patches: Readonly<Record<string, Load<FilePatch>>>;
  open: ReadonlySet<string>;
  onToggle(file: ChangedFileSummary): void;
  onRefresh(): void;
}) {
  let body;
  if (changes.status === 'loading') body = <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-text-muted" aria-label="Loading changes" /></div>;
  else if (changes.status === 'error') {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-semibold text-text-primary">Couldn’t read this branch’s changes</p>
        <p className="text-sm text-text-secondary">{changes.message}</p>
        <button type="button" onClick={onRefresh} className="rounded-md border border-border-primary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover">Try again</button>
      </div>
    );
  } else if (changes.value.files.length === 0) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-semibold text-text-primary">No changes</p>
        <p className="text-sm text-text-secondary">This branch matches {versusLabel(changes.value.resolvedBase).replace(/^vs /, '') || 'its base'}.</p>
      </div>
    );
  } else {
    const { stats, files, resolvedBase } = changes.value;
    body = (
      <>
        <div className="flex shrink-0 items-center gap-3 border-b border-border-primary px-4 py-2 text-sm">
          <span className="font-semibold text-text-primary">{stats.filesChanged} {stats.filesChanged === 1 ? 'file' : 'files'}</span>
          <Counts additions={stats.additions} deletions={stats.deletions} />
          <span className="ml-auto text-text-muted">{versusLabel(resolvedBase)}</span>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Changed files">
          {files.map(file => {
            const expanded = open.has(file.path);
            const slash = file.path.lastIndexOf('/');
            return (
              <li key={file.path} className="border-b border-border-primary">
                <button type="button" aria-expanded={expanded} onClick={() => onToggle(file)} className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm hover:bg-surface-hover">
                  {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />}
                  <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-xs font-bold',
                    file.kind === 'added' ? 'bg-status-success/10 text-status-success' : file.kind === 'deleted' ? 'bg-status-error/10 text-status-error' : 'bg-status-warning/10 text-status-warning')}>
                    {changeBadge(file.kind)}
                  </span>
                  <span className="min-w-0 flex-1 truncate" dir="rtl"><bdi>
                    {slash >= 0 && <span className="text-text-muted">{file.path.slice(0, slash + 1)}</span>}
                    <span className="text-text-primary">{file.path.slice(slash + 1)}</span>
                  </bdi></span>
                  <Counts additions={file.additions} deletions={file.deletions} />
                </button>
                {expanded && <Patch load={patches[file.path] ?? { status: 'loading' }} />}
              </li>
            );
          })}
        </ul>
      </>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary" data-testid="remote-diff">
      {body}
      <div className="flex shrink-0 items-center gap-2 border-t border-border-primary px-4 py-1.5 text-xs text-text-muted">
        <span>Read-only here · commit and revert in desktop Pane</span>
        <button type="button" onClick={onRefresh} aria-label="Refresh changes" className="ml-auto flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-hover hover:text-text-primary">
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Patch({ load }: { load: Load<FilePatch> }) {
  if (load.status === 'loading') return <div className="px-4 py-3"><Loader2 className="h-4 w-4 animate-spin text-text-muted" aria-label="Loading patch" /></div>;
  if (load.status === 'error') return <p className="px-4 py-3 text-sm text-text-secondary">{load.message}</p>;
  if (load.value.status === 'no-longer-changed') return <p className="px-4 py-3 text-sm text-text-secondary">This file no longer has changes.</p>;
  const rows = parsePatch(load.value.patch);
  if (rows.length === 0) return <p className="px-4 py-3 text-sm text-text-secondary">No text changes (a binary file, or only its mode changed).</p>;
  const shown = rows.slice(0, PATCH_ROW_LIMIT);
  return (
    <div className="overflow-x-auto pb-1 font-mono text-xs leading-5">
      <div className="min-w-max">
      {shown.map((row, index) => (
        <div key={index} className={cn('whitespace-pre px-3',
          row.kind === 'added' ? 'bg-status-success/10 text-status-success'
            : row.kind === 'removed' ? 'bg-status-error/10 text-status-error'
              : row.kind === 'hunk' ? 'bg-surface-secondary text-text-muted'
                : row.kind === 'note' ? 'text-text-muted' : 'text-text-primary')}>
          {row.text || ' '}
        </div>
      ))}
      </div>
      {rows.length > shown.length && <p className="px-3 py-2 font-sans text-sm text-text-secondary">{rows.length - shown.length} more lines. Open this file in desktop Pane to read the rest.</p>}
    </div>
  );
}

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  return (
    <span className="flex shrink-0 gap-2 text-sm">
      {additions ? <span className="text-status-success">+{additions}</span> : null}
      {deletions ? <span className="text-status-error">−{deletions}</span> : null}
    </span>
  );
}
