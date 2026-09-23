import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';
import { cn } from '../../../utils/cn';
import { useScrollSurface } from '../../../hooks/useScrollSurface';
import { navigateList, typeAhead, type ChangesRow } from './changesListModel';

const ROW_HEIGHT = 32;
const OVERSCAN = 8;

const statusLabel = (file: ChangedFileSummary): string => {
  if (file.kind === 'renamed') return `Renamed from ${file.previousPath ?? 'unknown path'}`;
  return `${file.kind[0].toUpperCase()}${file.kind.slice(1)}`;
};

const accessibleFileLabel = (file: ChangedFileSummary): string => {
  const additions = file.additions === null ? 'additions unavailable' : `+${file.additions}`;
  const deletions = file.deletions === null ? 'deletions unavailable' : `−${file.deletions}`;
  return `Open diff for ${file.path}, ${statusLabel(file)}, ${additions} ${deletions}`;
};

export const ChangesList = memo(function ChangesList({
  sessionId,
  rows,
  scopeKey,
  activePath,
  onFileOpen,
}: {
  sessionId: string;
  rows: ChangesRow[];
  scopeKey: string;
  activePath: string | null;
  onFileOpen: (file: ChangedFileSummary, pin: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const typeBuffer = useRef('');
  const typeTimer = useRef<number | null>(null);
  const listId = useMemo(() => `changes-list-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`, [scopeKey, sessionId]);
  const ownerElement = useCallback(() => hostRef.current, []);
  const registerScrollSurface = useScrollSurface<HTMLDivElement>({ id: `diff:${sessionId}`, sessionId, priority: 90, ownerElement });
  const setHostElement = useCallback((element: HTMLDivElement | null) => {
    hostRef.current = element;
    registerScrollSurface(element);
  }, [registerScrollSurface]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setHeight(host.clientHeight));
    observer.observe(host);
    setHeight(host.clientHeight);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    // SAFETY: The optional flag is installed only by the Playwright mock; absence is valid in production.
    const perfWindow = window as typeof window & { __paneTestPerf?: boolean };
    if (!perfWindow.__paneTestPerf) return;
    if (performance.getEntriesByName('pane-diff-manifest-received').length === 0) return;
    // These mark names are historical -- they date from the folder tree this list replaced.
    // The perf spec keys off them, so they stay as-is.
    performance.mark('pane-diff-tree-committed');
    requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('pane-diff-tree-painted')));
  }, [rows.length]);

  useEffect(() => {
    if (!activePath) return;
    const index = rows.findIndex(row => row.id === activePath);
    if (index >= 0) setActiveIndex(index);
  }, [activePath, rows]);

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleEnd = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const indexes = new Set(Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, offset) => visibleStart + offset));
  if (rows[activeIndex]) indexes.add(activeIndex);

  const scrollToIndex = (index: number) => {
    const host = hostRef.current;
    if (!host) return;
    const top = index * ROW_HEIGHT;
    if (top < host.scrollTop) host.scrollTop = top;
    else if (top + ROW_HEIGHT > host.scrollTop + host.clientHeight) host.scrollTop = top + ROW_HEIGHT - host.clientHeight;
  };

  const activate = (index: number) => { setActiveIndex(index); scrollToIndex(index); };

  return (
    <div
      ref={setHostElement}
      role="listbox"
      tabIndex={0}
      aria-label="Changed files"
      aria-activedescendant={rows[activeIndex] ? `${listId}-r${activeIndex}` : undefined}
      className="pane-changes-list min-h-0 flex-1 overflow-auto outline-none"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onFocus={() => {
        if (!activePath) return;
        const index = rows.findIndex(row => row.id === activePath);
        if (index >= 0) activate(index);
      }}
      onKeyDown={(event) => {
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          activate(navigateList(rows, activeIndex, event.key));
          return;
        }
        const row = rows[activeIndex];
        if ((event.key === 'Enter' || event.key === ' ') && row) {
          event.preventDefault();
          onFileOpen(row.file, false);
          return;
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          typeBuffer.current += event.key;
          activate(typeAhead(rows, activeIndex, typeBuffer.current));
          if (typeTimer.current !== null) window.clearTimeout(typeTimer.current);
          typeTimer.current = window.setTimeout(() => { typeBuffer.current = ''; }, 700);
        }
      }}
    >
      <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
        {[...indexes].sort((a, b) => a - b).map(index => {
          const row = rows[index];
          const selected = row.id === activePath;
          const active = index === activeIndex;
          return (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Keyboard interaction is delegated to the focusable list container.
            <div
              id={`${listId}-r${index}`}
              key={row.id}
              role="option"
              aria-label={accessibleFileLabel(row.file)}
              aria-setsize={rows.length}
              aria-posinset={index + 1}
              aria-selected={selected}
              aria-current={selected ? 'true' : undefined}
              className={cn('pane-changes-list-row absolute left-0 right-0', active && 'is-active', selected && 'is-selected')}
              style={{ top: index * ROW_HEIGHT }}
              title={row.file.previousPath ? `${row.file.previousPath} → ${row.id}` : row.id}
              onClick={() => { activate(index); onFileOpen(row.file, false); }}
              onDoubleClick={() => onFileOpen(row.file, true)}
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
              <span className="pane-changes-list-path">
                <bdi className="pane-changes-list-dir">{row.dir}</bdi><bdi className="pane-changes-list-name">{row.name}</bdi>
              </span>
              <span className="pane-changes-list-stats">
                {row.file.additions === null ? '—' : `+${row.file.additions}`} {row.file.deletions === null ? '—' : `−${row.file.deletions}`}
              </span>
              <span className="pane-changes-list-status" aria-hidden="true">{row.file.kind[0].toUpperCase()}</span>
              <span className="sr-only">{statusLabel(row.file)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
