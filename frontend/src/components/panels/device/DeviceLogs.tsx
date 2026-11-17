import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { ArrowDown, FileText, Filter, MessageSquarePlus, X } from 'lucide-react';
import type { DeviceLogLine } from '../../../../../shared/types/devices';

export interface DeviceLogsProps {
  lines: readonly DeviceLogLine[];
  /** Why lines are not arriving, shown in place of an empty list; undefined while reading. */
  problem?: string;
  /** False hides "To chat" (no agent tab in this Pane). */
  canSendToChat: boolean;
  /** The lines to send, as plain text ("HH:MM:SS.mmm source: message" per line). */
  onToChat: (text: string) => void;
  onClose: () => void;
}

/** The list keeps only the newest lines. */
const MAX_LINES = 2000;
/** Within this many pixels of the end counts as at the bottom. */
const BOTTOM_SLACK = 8;

const MESSAGE_CLASS = {
  debug: 'text-text-primary',
  info: 'text-text-primary',
  warning: 'text-status-warning',
  error: 'text-status-error',
} satisfies Record<DeviceLogLine['level'], string>;

/** Local time as HH:MM:SS.mmm. */
function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function asText(lines: readonly DeviceLogLine[]): string {
  return lines.map((line) => `${clock(line.at)} ${line.source}: ${line.message}`).join('\n');
}

export function DeviceLogs({ lines, problem, canSendToChat, onToChat, onClose }: DeviceLogsProps) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [anchor, setAnchor] = useState<number | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((line) => line.source.toLowerCase().includes(needle) || line.message.toLowerCase().includes(needle));
  }, [lines, filter]);
  const visible = useMemo(() => matching.slice(-MAX_LINES), [matching]);
  const picked = useMemo(() => lines.filter((line) => selected.has(line.seq)), [lines, selected]);
  const toSend = picked.length > 0 ? picked : matching;

  // New lines keep the list pinned to the end while the person has not scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  const jumpToLatest = () => {
    const el = list.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(undefined);
  };

  // Click selects one row, shift-click extends from the last clicked row, Cmd/Ctrl-click toggles.
  const onRowClick = (event: MouseEvent | KeyboardEvent, seq: number) => {
    if (event.shiftKey && anchor !== undefined) {
      const from = visible.findIndex((line) => line.seq === anchor);
      const to = visible.findIndex((line) => line.seq === seq);
      if (from >= 0 && to >= 0) {
        window.getSelection()?.removeAllRanges();
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelected(new Set(visible.slice(start, end + 1).map((line) => line.seq)));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      setSelected(next);
    } else {
      setSelected(new Set([seq]));
    }
    setAnchor(seq);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && selected.size > 0) {
      event.stopPropagation();
      clearSelection();
    }
  };

  const empty = problem ?? (lines.length === 0 ? 'Waiting for the app to log…' : visible.length === 0 ? 'No lines match' : undefined);

  return (
    <div className="flex h-full flex-col border-t border-border-primary bg-bg-primary" data-testid="device-logs" onKeyDown={onKeyDown}>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-primary bg-surface-primary px-2 py-1 text-xs">
        <span className="flex flex-shrink-0 items-center gap-1.5 font-medium text-text-primary">
          <FileText className="h-3.5 w-3.5" />
          Logs
        </span>
        <label className="relative flex min-w-0 max-w-xs flex-1 items-center">
          <Filter className="pointer-events-none absolute left-2 h-3 w-3 text-text-tertiary" />
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            aria-label="Filter logs"
            data-testid="device-logs-filter"
            className="w-full rounded border border-border-primary bg-bg-primary py-0.5 pl-6 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-interactive"
          />
        </label>
        <span className="min-w-[88px] flex-shrink-0 tabular-nums text-text-tertiary">
          {selected.size > 0 ? `${picked.length} selected` : `${matching.length} ${matching.length === 1 ? 'line' : 'lines'}`}
        </span>
        <span className="flex-1" />
        {canSendToChat && (
          <button
            type="button"
            disabled={toSend.length === 0}
            onClick={() => onToChat(asText(toSend))}
            className="flex flex-shrink-0 items-center gap-1 rounded px-2 py-0.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            To chat
          </button>
        )}
        <button type="button" aria-label="Close logs" onClick={onClose} className="flex-shrink-0 rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text-primary">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {empty !== undefined ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-text-secondary">{empty}</div>
        ) : (
          <div ref={list} onScroll={onScroll} className="h-full overflow-y-auto py-1 font-mono text-xs">
            {visible.map((line) => (
              <div
                key={line.seq}
                data-testid="device-log-line"
                role="option"
                tabIndex={-1}
                aria-selected={selected.has(line.seq)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowClick(event, line.seq); } }}
                onClick={(event) => onRowClick(event, line.seq)}
                className={`flex gap-2 px-2 py-px ${selected.has(line.seq) ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`}
              >
                <span className="flex-shrink-0 text-text-tertiary">{clock(line.at)}</span>
                <span className="max-w-[30%] flex-shrink-0 truncate text-text-secondary" title={line.source}>{line.source}</span>
                <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${MESSAGE_CLASS[line.level]}`}>{line.message}</span>
              </div>
            ))}
          </div>
        )}
        {empty === undefined && !atBottom && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-interactive px-2.5 py-0.5 text-xs font-medium text-text-on-interactive shadow-sm hover:bg-interactive-hover"
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
