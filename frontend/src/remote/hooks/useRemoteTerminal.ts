import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { RemotePaneConnectionStatus } from '../../../../shared/types/remoteDaemon';
import type { SessionOutput } from '../../types/session';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

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

export function useRemoteTerminal({
  adapter,
  panel,
  sessionId,
  connectionStatus,
}: UseRemoteTerminalOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [statusText, setStatusText] = useState('Starting terminal...');

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const sendInput = useCallback(async (data: string) => {
    try {
      await adapter.sendTerminalInput(panel.id, data);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'Failed to send input');
    }
  }, [adapter, panel.id]);

  const resetTerminal = () => {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
    void adapter.clearTerminalScrollback(panel.id).catch(error => {
      setStatusText(error instanceof Error ? error.message : 'Failed to reset terminal');
    });
  };

  const scrollLines = useCallback((amount: number) => {
    terminalRef.current?.scrollLines(amount);
  }, []);

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
  }, []);

  const hydrateTerminal = useCallback(async (terminal: Terminal) => {
    const outputs = await adapter.getPanelOutput(panel.id);
    // A response can outlive the terminal during a tab switch or effect cleanup.
    if (terminalRef.current !== terminal) return;
    terminal.clear();
    for (const output of outputs) {
      terminal.write(formatSessionOutput(output));
    }
  }, [adapter, panel.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      // Static AA floor: the remote PWA is browser-served with no AppConfig transport,
      // so the desktop high-contrast setting cannot be plumbed here.
      minimumContrastRatio: 4.5,
      theme: {
        background: '#010409',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setStatusText('Connecting to terminal...');

    const fitTerminal = () => {
      if (!container.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) {
        return;
      }
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
      void sendInput(data);
    });

    const unsubscribe = adapter.onEvent(event => {
      if (event.channel !== 'terminal:output') return;
      const payload: TerminalOutputPayload | undefined = decodeOptionalBoundary(
        event.args[0],
        terminalOutputPayloadSchema,
      );
      if (!payload || payload.panelId !== panel.id) return;
      terminal.write(payload.output);
      void adapter.ackTerminalOutput(panel.id, byteLength(payload.output)).catch(() => {});
    });

    let disposed = false;
    const visibilityTimer = window.setInterval(() => {
      void adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID).catch(() => {});
    }, VISIBILITY_REFRESH_MS);

    const initialize = async () => {
      try {
        const initialized = await adapter.checkPanelInitialized(panel.id);
        if (disposed) return;
        if (!initialized) {
          await adapter.initializePanel(panel.id, {
            sessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
          if (disposed) return;
        }
        await hydrateTerminal(terminal);
        if (disposed) return;
        fitTerminal();
        await adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID);
        if (!disposed) {
          setStatusText('Connected');
        }
      } catch (error) {
        if (!disposed) {
          setStatusText(error instanceof Error ? error.message : 'Terminal failed to initialize');
        }
      }
    };

    void initialize();

    return () => {
      disposed = true;
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

  useEffect(() => {
    if (connectionStatus !== 'connected' || !terminalRef.current) return;
    void hydrateTerminal(terminalRef.current).catch(() => {});
    void adapter.setTerminalVisibility(panel.id, true, TERMINAL_VIEWER_ID).catch(() => {});
  }, [adapter, connectionStatus, panel.id, hydrateTerminal]);

  return { containerRef, statusText, focusTerminal, sendInput, resetTerminal, scrollLines, scrollToBottom };
}

function formatSessionOutput(output: SessionOutput): string {
  return output.type === 'json' ? `${JSON.stringify(output.data)}\r\n` : String(output.data);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
