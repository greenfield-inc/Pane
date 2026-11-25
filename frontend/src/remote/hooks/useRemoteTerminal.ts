import { isReadOnlyHost, useReadOnlyHost } from '../../stores/readOnlyHostStore';
import { adoptOwnerGrid, OWNER_GRID_CHECK_MS, ownerGridChanged } from '../../utils/ownerTerminalGrid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { RemotePaneConnectionStatus } from '../../../../shared/types/remoteDaemon';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { hydrateRemoteTerminalSnapshot } from '../runtime/terminalSnapshot';
import { terminalSnapshotText } from '../../../../shared/remoteClient/terminalSnapshot';
import { terminalOutputByteLength } from '../../utils/terminalRestore';
import { useCaretResting } from '../../services/caretRest';
import { useCommittedRef } from '../../hooks/useCommittedRef';

interface UseRemoteTerminalOptions {
  adapter: RemoteRuntimeAdapter;
  panel: ToolPanel;
  sessionId: string;
  connectionStatus: RemotePaneConnectionStatus;
}

interface TerminalOutputPayload {
  panelId: string;
  output: string;
}

const terminalOutputPayloadSchema = boundary.object({
  panelId: boundary.string,
  output: boundary.string,
});

const VISIBILITY_REFRESH_MS = 60_000;
const TERMINAL_VIEWER_ID = getTerminalViewerId();

/** Where the phone's terminal is: loading (a skeleton shows), ready, or stopped by a problem the person should read. */
type RemoteTerminalStatus = { kind: 'loading' } | { kind: 'ready' } | { kind: 'problem'; message: string };

export function useRemoteTerminal({
  adapter,
  panel,
  sessionId,
  connectionStatus,
}: UseRemoteTerminalOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const caretResting = useCaretResting();
  const caretRestingRef = useCommittedRef(caretResting);
  const snapshotGenerationRef = useRef(0);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Loading shows a terminal skeleton; only a problem gets words.
  const [status, setStatus] = useState<RemoteTerminalStatus>({ kind: 'loading' });
  const connectedRef = useRef(connectionStatus === 'connected');
  useEffect(() => {
    connectedRef.current = connectionStatus === 'connected';
  }, [connectionStatus]);

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const readOnly = useReadOnlyHost();
  const sendInput = useCallback(async (data: string) => {
    if (isReadOnlyHost()) return;
    try {
      await adapter.sendTerminalInput(panel.id, data);
    } catch (error) {
      setStatus({ kind: 'problem', message: error instanceof Error ? error.message : 'Failed to send input' });
      throw error;
    }
  }, [adapter, panel.id]);

  const resetTerminal = () => {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
    if (!isReadOnlyHost()) void adapter.clearTerminalScrollback(panel.id).catch(error => {
      setStatus({ kind: 'problem', message: error instanceof Error ? error.message : 'Failed to reset terminal' });
    });
  };

  const scrollLines = useCallback((amount: number) => {
    terminalRef.current?.scrollLines(amount);
  }, []);

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
  }, []);

  const hydrateTerminal = useCallback(async (terminal: Terminal, owns: () => boolean) => {
    // Every attach, a reconnect included, starts a shell nobody has started since the computer restarted.
    // A read-only viewer starts nothing, and draws at the owner's size.
    const watching = isReadOnlyHost();
    if (watching) await adoptOwnerGrid(panel.id, terminal, adapter.terminalSnapshots);
    else if (!await adapter.checkPanelInitialized(panel.id)) {
      await adapter.initializePanel(panel.id, { sessionId, cols: terminal.cols, rows: terminal.rows });
    }
    if (!owns()) return false;
    let fullScreen = false;
    const hydrated = await hydrateRemoteTerminalSnapshot(terminal, async () => {
      const state = await adapter.getTerminalState(panel.id);
      fullScreen = state?.isAlternateScreen === true;
      return terminalSnapshotText(state);
    }, () => terminalRef.current === terminal && owns());
    // A full-screen app's frame was drawn for the host's size; a forced resize makes the app repaint at this one.
    if (hydrated && fullScreen && !watching) await adapter.resizeTerminal(panel.id, terminal.cols, terminal.rows, { force: true });
    return hydrated;
  }, [adapter, panel.id, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.cursorBlink = !caretResting;
  }, [caretResting]);

  // Keys and query answers stop here while the host takes none, and no cursor invites them.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = readOnly;
    terminal.options.cursorInactiveStyle = readOnly ? 'none' : 'outline';
    terminal.options.theme = terminalTheme(readOnly);
  }, [readOnly]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      disableStdin: isReadOnlyHost(),
      cursorBlink: !caretRestingRef.current,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      // Static AA floor: the remote PWA is browser-served with no AppConfig transport,
      // so the desktop high-contrast setting cannot be plumbed here.
      minimumContrastRatio: 4.5,
      cursorInactiveStyle: isReadOnlyHost() ? 'none' : 'outline',
      theme: terminalTheme(isReadOnlyHost()),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setStatus({ kind: 'loading' });

    const fitTerminal = () => {
      if (!container.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) {
        return;
      }
      if (isReadOnlyHost()) return;
      fitAddon.fit();
      void adapter.resizeTerminal(panel.id, terminal.cols, terminal.rows).catch(() => {});
    };

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitTerminal);
    });
    resizeObserver.observe(container);

    const visualViewport = window.visualViewport;
    const handleViewportChange = () => {
      window.requestAnimationFrame(fitTerminal);
    };
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('orientationchange', handleViewportChange);
    visualViewport?.addEventListener('resize', handleViewportChange);
    visualViewport?.addEventListener('scroll', handleViewportChange);

    const inputDisposable = terminal.onData(data => {
      // Keys typed while the terminal is dimmed are dropped, as the input bar is disabled then.
      if (!connectedRef.current) return;
      void sendInput(data).catch(() => {});
    });

    const unsubscribe = adapter.onEvent(event => {
      if (event.channel !== 'terminal:output') return;
      const payload: TerminalOutputPayload | undefined = decodeOptionalBoundary(
        event.args[0],
        terminalOutputPayloadSchema,
      );
      if (!payload || payload.panelId !== panel.id) return;
      terminal.write(payload.output, () => {
        if (disposed) return;
        void adapter.ackTerminalOutput(
          panel.id,
          terminalOutputByteLength(payload.output),
          TERMINAL_VIEWER_ID,
        ).catch(() => {});
      });
    });

    let disposed = false;
    const visibilityTimer = window.setInterval(() => {
      void adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID).catch(() => {});
    }, VISIBILITY_REFRESH_MS);

    const initialize = async () => {
      const generation = ++snapshotGenerationRef.current;
      const owns = () => !disposed && snapshotGenerationRef.current === generation;
      try {
        if (!await hydrateTerminal(terminal, owns)) return;
        if (!owns()) return;
        fitTerminal();
        await adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID);
        if (owns()) {
          setStatus({ kind: 'ready' });
        }
      } catch (error) {
        if (owns()) {
          setStatus({ kind: 'problem', message: error instanceof Error ? error.message : 'Terminal failed to initialize' });
        }
      }
    };

    void initialize();

    return () => {
      disposed = true;
      snapshotGenerationRef.current += 1;
      window.clearInterval(visibilityTimer);
      unsubscribe();
      inputDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('orientationchange', handleViewportChange);
      visualViewport?.removeEventListener('resize', handleViewportChange);
      visualViewport?.removeEventListener('scroll', handleViewportChange);
      void adapter.setTerminalVisibility(panel.id, false, TERMINAL_VIEWER_ID).catch(() => {});
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [adapter, panel.id, sessionId, sendInput, hydrateTerminal]);

  const loading = status.kind === 'loading';
  // The owner's window decides a watched terminal's size, and says nothing when it changes.
  useEffect(() => {
    if (!readOnly || loading) return;
    const timer = window.setInterval(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      void ownerGridChanged(panel.id, terminal, adapter.terminalSnapshots).then((changed) => {
        if (!changed || terminalRef.current !== terminal) return;
        const generation = ++snapshotGenerationRef.current;
        return hydrateTerminal(terminal, () => terminalRef.current === terminal && snapshotGenerationRef.current === generation);
      }).catch(() => undefined);
    }, OWNER_GRID_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [adapter, hydrateTerminal, loading, panel.id, readOnly]);

  useEffect(() => adapter.onRestore(async signal => {
    const terminal = terminalRef.current;
    if (!terminal || signal.aborted) return;
    const generation = ++snapshotGenerationRef.current;
    const owns = () => !signal.aborted && terminalRef.current === terminal && snapshotGenerationRef.current === generation;
    setStatus({ kind: 'loading' });
    try {
      if (!await hydrateTerminal(terminal, owns)) return;
      await adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID);
      if (owns()) setStatus({ kind: 'ready' });
    } catch (error) {
      if (owns()) setStatus({ kind: 'problem', message: error instanceof Error ? error.message : 'Terminal snapshot failed; reconnect to retry.' });
    }
  }), [adapter, panel.id, hydrateTerminal]);

  useEffect(() => {
    if (connectionStatus !== 'connected'  || !terminalRef.current) return;
    void adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID).catch(() => {});
  }, [adapter, connectionStatus, panel.id]);

  return {
    containerRef,
    loading,
    problem: status.kind === 'problem' ? status.message : null,
    focusTerminal, sendInput, resetTerminal, scrollLines, scrollToBottom,
  };
}

/** While watching, the cursor takes the background's colour, since xterm can't turn a focused one off. */
function terminalTheme(readOnly: boolean) {
  const background = '#010409';
  const foreground = '#e6edf3';
  return { background, foreground, cursor: readOnly ? background : '#58a6ff', cursorAccent: readOnly ? foreground : background, selectionBackground: '#264f78' };
}

function getTerminalViewerId(): string {
  const storageKey = 'pane.remotePwa.terminalViewerId';
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const id = window.crypto?.randomUUID?.() ?? `remote-pwa-terminal-${Date.now().toString(36)}`;
  window.sessionStorage.setItem(storageKey, id);
  return id;
}
