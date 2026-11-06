import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { X, Download, Trash2, Filter, Copy, Check } from 'lucide-react';
import { cn } from '../../../utils/cn';
import AnsiToHtml from 'ansi-to-html';
import { useTheme } from '../../../contexts/ThemeContext';
import { getTerminalTheme } from '../../../utils/terminalTheme';
import { LiveRegion } from '../../ui/LiveRegion';
import { useScrollSurface } from '../../../hooks/useScrollSurface';
import { useCommittedRef } from '../../../hooks/useCommittedRef';
import { FindBar } from '../../find/FindBar';
import { reportFindResult, useFindBar, type FindAdapter } from '../../find/findController';
import { stepMatchIndex } from '../../find/findText';
import { usePanelFind } from '../../find/usePanelFind';
import { findLogOccurrences, splitLineByQuery, stripAnsi, type LogOccurrence } from './logsFind';

import { SessionLogBuffer, type LogEntry } from '../../../../../shared/utils/session-log-buffer';

interface LogsViewProps {
  panelId: string;
  sessionId: string;
  isVisible: boolean;
}

export const LogsView: React.FC<LogsViewProps> = ({ panelId, sessionId, isVisible }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logBuffer = useRef(new SessionLogBuffer());
  const [filterTerm, setFilterTerm] = useState('');
  // Pane's find (Cmd/Ctrl+F): the query lives in the shared find bar; this
  // view owns the occurrences and which one is current (1-based, 0 = none).
  const findBar = useFindBar(panelId);
  const [findQuery, setFindQuery] = useState('');
  const [currentOccurrence, setCurrentOccurrence] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const logsViewRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const registerScrollSurface = useScrollSurface<HTMLDivElement>({
    id: `logs:${sessionId}`,
    sessionId,
    enabled: isVisible,
    priority: 80,
    ownerElement: () => logsViewRef.current,
  });
  const setLogContainerRef = useCallback((element: HTMLDivElement | null) => {
    logContainerRef.current = element;
    registerScrollSurface(element);
  }, [registerScrollSurface]);
  const { theme } = useTheme();

  // ANSI → HTML converter using the active theme's terminal palette
  // (--color-terminal-* tokens), so log colours match the terminal panel.
  // Read in an effect: the theme classes are stamped on <html> by
  // ThemeProvider's layout effect, which has run by the time this fires.
  const [terminalPalette, setTerminalPalette] = useState(getTerminalTheme);
  useEffect(() => {
    setTerminalPalette(getTerminalTheme());
  }, [theme]);
  const ansiConverter = useMemo(() => {
    const p = terminalPalette;
    return new AnsiToHtml({
      fg: p.foreground,
      bg: p.background,
      newline: true,
      escapeXML: true,
      // ANSI slots 0–15; getTerminalTheme always fills these, the fallback only satisfies ITheme's optional typing.
      colors: [
        p.black, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white,
        p.brightBlack, p.brightRed, p.brightGreen, p.brightYellow, p.brightBlue, p.brightMagenta, p.brightCyan, p.brightWhite,
      ].map((color) => color ?? p.foreground ?? '#808080'),
    });
  }, [terminalPalette]);

  // Load existing logs when component mounts or session changes
  useEffect(() => {
    if (!sessionId || !isVisible) return;
    
    const loadLogs = async () => {
      try {
        const result = await window.electronAPI.sessions.getLogs(sessionId);
        if (result.success && result.data) {
          logBuffer.current.clear();
          for (const entry of result.data) logBuffer.current.append(entry);
          setLogs(logBuffer.current.snapshot());
        }
      } catch (error) {
        console.error('Failed to load logs:', error);
      }
    };

    loadLogs();
  }, [sessionId, isVisible]);

  // Subscribe to new log entries and clear events
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribeLog = window.electronAPI?.events?.onSessionLog?.((data: {
      sessionId: string;
      entry: LogEntry;
    }) => {
      if (data.sessionId === sessionId) {
        logBuffer.current.append(data.entry);
        setLogs(logBuffer.current.snapshot());
      }
    });

    const unsubscribeClear = window.electronAPI?.events?.onSessionLogsCleared?.((data: {
      sessionId: string;
    }) => {
      if (data.sessionId === sessionId) {
        logBuffer.current.clear();
        setLogs([]);
      }
    });

    return () => {
      unsubscribeLog?.();
      unsubscribeClear?.();
    };
  }, [sessionId]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Filter logs based on filter term
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      const matchesFilter = !filterTerm || 
        log.message.toLowerCase().includes(filterTerm.toLowerCase()) ||
        (log.source && log.source.toLowerCase().includes(filterTerm.toLowerCase()));
      
      return matchesFilter;
    });
  }, [logs, filterTerm]);

  const occurrences = useMemo<LogOccurrence[]>(
    () => findLogOccurrences(filteredLogs.map(log => log.message), findQuery),
    [filteredLogs, findQuery],
  );
  const filteredLogsRef = useCommittedRef(filteredLogs);
  const occurrencesRef = useCommittedRef(occurrences);
  const currentRef = useCommittedRef(currentOccurrence);
  const [scrollRequest, setScrollRequest] = useState(0);

  const findAdapter = useMemo<FindAdapter>(() => ({
    mode: () => 'text',
    search(query) {
      const next = findLogOccurrences(filteredLogsRef.current.map(log => log.message), query);
      const current = next.length ? 1 : 0;
      setFindQuery(query);
      setCurrentOccurrence(current);
      setScrollRequest(request => request + 1);
      return { current, total: next.length };
    },
    step(direction) {
      const total = occurrencesRef.current.length;
      const current = stepMatchIndex(currentRef.current, total, direction);
      setCurrentOccurrence(current);
      setScrollRequest(request => request + 1);
      return { current, total };
    },
    clear() {
      setFindQuery('');
      setCurrentOccurrence(0);
    },
    selectedText() {
      const selection = window.getSelection();
      const container = logContainerRef.current;
      if (!selection || selection.isCollapsed || !container || !selection.anchorNode || !container.contains(selection.anchorNode)) return '';
      return selection.toString();
    },
    restoreFocus() {
      logContainerRef.current?.focus({ preventScroll: true });
    },
  }), [filteredLogsRef, occurrencesRef, currentRef]);
  usePanelFind(panelId, logsViewRef, findAdapter);

  // New or filtered log lines change the count while the bar stays open.
  useEffect(() => {
    if (!findBar.open || !findQuery) return;
    const total = occurrences.length;
    const current = total ? Math.min(Math.max(currentRef.current, 1), total) : 0;
    if (current !== currentRef.current) setCurrentOccurrence(current);
    reportFindResult(panelId, { current, total });
  }, [occurrences, findBar.open, findQuery, panelId, currentRef]);

  // Scroll the current occurrence into view after each search or step.
  useEffect(() => {
    if (!scrollRequest) return;
    logContainerRef.current
      ?.querySelector('[data-find-current="true"]')
      ?.scrollIntoView({ block: 'center' });
  }, [scrollRequest]);

  const handleClearLogs = async () => {
    try {
      await window.electronAPI.sessions.clearLogs(sessionId);
      logBuffer.current.clear();
      setLogs([]);
    } catch (error) {
      console.error('Failed to clear logs:', error);
    }
  };

  const handleExportLogs = () => {
    const logText = filteredLogs.map(log => log.message).join('\n');
    
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${sessionId}-logs-${new Date().toISOString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyLogs = async () => {
    try {
      const logText = filteredLogs.map(log => log.message).join('\n');
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy logs:', error);
    }
  };


  return (
    <div ref={logsViewRef} className="h-full flex flex-col bg-bg-primary relative">
      <LiveRegion>{copied ? 'Logs copied to clipboard' : ''}</LiveRegion>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
        <div className="text-sm text-text-secondary">
          Logs ({filteredLogs.length}{logs.length !== filteredLogs.length ? ` / ${logs.length}` : ''})
        </div>

        <div className="flex items-center gap-2">
          {/* Auto-scroll toggle */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={cn(
              "p-1.5 rounded transition-colors",
              autoScroll 
                ? "bg-interactive/20 text-interactive-on-tint" 
                : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
            )}
            title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>

          {/* Copy button */}
          <button
            onClick={handleCopyLogs}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
            title="Copy logs to clipboard"
          >
            {copied ? <Check className="w-4 h-4 text-status-success" /> : <Copy className="w-4 h-4" />}
          </button>

          {/* Export button */}
          <button
            onClick={handleExportLogs}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
            title="Export logs"
          >
            <Download className="w-4 h-4" />
          </button>

          {/* Clear button */}
          <button
            onClick={handleClearLogs}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
            title="Clear logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-4 py-2 bg-surface-secondary border-b border-border-primary">
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            type="text"
            value={filterTerm}
            onChange={(e) => setFilterTerm(e.target.value)}
            placeholder="Filter logs..."
            className="w-full pl-10 pr-8 py-2 bg-bg-primary text-text-primary placeholder-text-tertiary rounded-lg border border-border-secondary focus:outline-none focus:border-interactive transition-colors"
          />
          {filterTerm && (
            <button
              onClick={() => setFilterTerm('')}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <FindBar panelId={panelId} className="top-[6.75rem] right-4" />

      {/* Logs Container */}
      <div 
        ref={setLogContainerRef}
        tabIndex={-1}
        className="select-text flex-1 min-h-0 overflow-y-auto overflow-x-auto font-mono text-sm p-4 bg-bg-primary text-text-primary whitespace-pre-wrap break-all"
        onScroll={(e) => {
          // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
          const target = e.target as HTMLDivElement;
          // Consider "at bottom" only if within 50px of the bottom
          const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
          const isAtBottom = distanceFromBottom < 50;
          if (isAtBottom !== autoScroll) {
            setAutoScroll(isAtBottom);
          }
        }}
      >
        {filteredLogs.length === 0 ? (
          <div className="text-center text-text-tertiary py-8">
            {filterTerm ? 'No logs match your filter' : 'No logs available'}
          </div>
        ) : (
          <div className="break-all">
            {(() => {
              // Occurrences are in line order, so each line's first one gives
              // the global index of every hit on it.
              const firstOccurrenceOfLine = new Map<number, number>();
              occurrences.forEach((occurrence, index) => {
                if (!firstOccurrenceOfLine.has(occurrence.line)) firstOccurrenceOfLine.set(occurrence.line, index);
              });
              const currentLine = currentOccurrence > 0 ? occurrences[currentOccurrence - 1]?.line : undefined;
              return filteredLogs.map((log, index) => {
              const firstOccurrence = firstOccurrenceOfLine.get(index);
              if (firstOccurrence === undefined) {
                return (
                  <div
                    key={index}
                    className="log-line"
                    dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(log.message) }}
                  />
                );
              }

              // A line with hits shows its ANSI-stripped text so each hit can be
              // marked; the current hit is drawn more strongly than the others.
              const isCurrentLine = currentLine === index;
              let ordinal = firstOccurrence;
              return (
                <div
                  key={index}
                  className={cn('log-line', isCurrentLine ? 'bg-status-warning/30' : 'bg-status-warning/10')}
                >
                  {splitLineByQuery(stripAnsi(log.message), findQuery).map((part, i) => {
                    if (!part.hit) return <span key={i}>{part.text}</span>;
                    const isCurrent = ordinal === currentOccurrence - 1;
                    ordinal += 1;
                    return (
                      <span
                        key={i}
                        data-find-current={isCurrent ? 'true' : undefined}
                        className={cn('px-0.5', isCurrent ? 'bg-status-warning text-text-on-status-warning' : 'bg-status-warning/50 text-text-on-status-warning')}
                      >
                        {part.text}
                      </span>
                    );
                  })}
                </div>
              );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
};
