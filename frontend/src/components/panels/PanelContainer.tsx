import { DevicePanel } from './device/DevicePanel';
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { PanelContainerProps } from '../../types/panelComponents';
import { ErrorBoundary } from 'react-error-boundary';
import { PanelLoadingFallback } from './PanelLoadingFallback';
import { TerminalSkeleton } from './TerminalSkeleton';
import { loadChatTabRoute, loadedChatTabRoute } from './chatTabRouteModule';
import { PausedTerminalView } from './PausedTabView';
import { pausedMarkOf } from '../../../../shared/types/panels';
import { isNotesEnabled, useConfigStore } from '../../stores/configStore';
import { renderLog } from '../../utils/console';

// Lazy load panel components for better performance
type TerminalPanelComponent = typeof import('./TerminalPanel').default;
let loadedTerminalPanel: TerminalPanelComponent | null = null;
const loadTerminalPanel = () => import('./TerminalPanel').then(module => {
  loadedTerminalPanel = module.default;
  return module;
});
const LazyTerminalPanel = lazy(loadTerminalPanel);
// Almost every screen shows a terminal: fetch its code while the app is idle, so
// the first Session or Pane opened does not wait for it.
if (globalThis.window) {
  const preload = () => { void loadTerminalPanel().catch(() => undefined); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(preload, { timeout: 2000 });
  else setTimeout(preload, 1000);
}
const LazyChatTabRoute = lazy(() => loadChatTabRoute().then(ChatTabRoute => ({ default: ChatTabRoute })));

/**
 * A terminal renders its code directly once loaded (the idle preload above), so
 * React never commits a Suspense fallback, whose reveal it holds back about
 * 300 ms. The component is picked once per mount, as for a chat tab below.
 */
function TerminalHost(props: React.ComponentProps<TerminalPanelComponent>) {
  const [Terminal] = useState(() => loadedTerminalPanel ?? LazyTerminalPanel);
  return <Terminal {...props} />;
}

/**
 * A chat tab renders its code directly once loaded (a launch preloads it), so it
 * shows without a loading fallback. The component is picked once per mount:
 * switching from the lazy wrapper to the loaded component would remount the chat.
 */
function ChatTabHost({ panel }: { panel: React.ComponentProps<typeof LazyChatTabRoute>['panel'] }) {
  const [ChatTabRoute] = useState(() => loadedChatTabRoute() ?? LazyChatTabRoute);
  return <ChatTabRoute panel={panel} />;
}
const DiffPanel = lazy(() => import('./diff/DiffPanel'));
const FileEditorTabPanel = React.lazy(() => import('./editor/FileEditorTabPanel'));
const ExplorerPanel = lazy(() => import('./editor/EditorPanel'));
const LogsPanel = lazy(() => import('./logPanel/LogsPanel'));
const DashboardPanel = lazy(() => import('./DashboardPanel'));
const SetupTasksPanel = lazy(() => import('./SetupTasksPanel'));
const BrowserPanel = lazy(() => import('./browser/BrowserPanel'));

const NotesPanel = lazy(() => import('./notes/NotesPanel'));

// Transient failures (a webview not ready yet after a pane switch) clear on remount,
// so retry quietly a few times before showing the error.
const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 200;
const AUTO_RETRY_WINDOW_MS = 30_000;

interface AutoRetryState {
  count: number;
  lastAt: number;
}

const PanelErrorFallback: React.FC<{
  error: Error;
  resetErrorBoundary: () => void;
  autoRetry: React.MutableRefObject<AutoRetryState>;
}> = ({ error, resetErrorBoundary, autoRetry }) => {
  if (Date.now() - autoRetry.current.lastAt > AUTO_RETRY_WINDOW_MS) {
    autoRetry.current.count = 0;
  }
  const retrying = autoRetry.current.count < MAX_AUTO_RETRIES;

  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => {
      autoRetry.current = { count: autoRetry.current.count + 1, lastAt: Date.now() };
      resetErrorBoundary();
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [retrying, resetErrorBoundary, autoRetry]);

  if (retrying) return null;

  return (
    <div className="flex flex-col items-center justify-center h-full text-status-error p-4">
      <p className="text-lg font-semibold mb-2">Panel Error</p>
      <p className="select-text text-sm text-text-secondary mb-4">{error.message}</p>
      <button
        onClick={() => {
          autoRetry.current = { count: 0, lastAt: 0 };
          resetErrorBoundary();
        }}
        className="px-4 py-2 bg-interactive text-text-on-interactive rounded hover:bg-interactive-hover"
      >
        Retry
      </button>
    </div>
  );
};

export const PanelContainer: React.FC<PanelContainerProps> = React.memo(({
  panel,
  isActive,
  isMainRepo = false,
  autoFocus
}) => {
  const autoRetry = useRef<AutoRetryState>({ count: 0, lastAt: 0 });
  const notesEnabled = useConfigStore(s => s.config ? isNotesEnabled(s.config) : undefined);
  renderLog('[PanelContainer] Rendering panel:', panel.id, 'Type:', panel.type, 'Active:', isActive);
  
  // FIX: Use stable panel rendering without forcing remounts
  // Each panel type maintains its own state internally
  // The isActive prop controls whether it should render its content
  
  const panelComponent = useMemo(() => {
    renderLog('[PanelContainer] Creating component for panel type:', panel.type);

    // Panel type rendering
    switch (panel.type) {
      case 'notes':
        if (notesEnabled === undefined) return <PanelLoadingFallback panelType={panel.type} />;
        if (!notesEnabled) {
          return (
            <div className="h-full w-full flex items-center justify-center p-8">
              <p className="text-sm text-text-secondary">Notes is experimental; turn it on in Settings → Advanced.</p>
            </div>
          );
        }
        return <NotesPanel paneId={panel.sessionId} viewId={panel.id} />;
      case 'terminal':
      {
        // A paused tab never mounts its terminal, so nothing starts it: it shows its last screen.
        const paused = pausedMarkOf(panel);
        return paused ? <PausedTerminalView panel={panel} mark={paused} /> : <TerminalHost panel={panel} isActive={isActive} autoFocus={autoFocus} />;
      }
      case 'chat':
        return <ChatTabHost panel={panel} />;
      case 'diff':
        return <DiffPanel panel={panel} isActive={isActive} sessionId={panel.sessionId} isMainRepo={isMainRepo} />;
      case 'explorer':
        return <ExplorerPanel panel={panel} isActive={isActive} />;
      case 'editor':
        return <FileEditorTabPanel panel={panel} isActive={isActive} />;
      case 'logs':
        return <LogsPanel panel={panel} isActive={isActive} />;
      case 'dashboard':
        return <DashboardPanel panelId={panel.id} sessionId={panel.sessionId} isActive={isActive} />;
      case 'setup-tasks':
        return <SetupTasksPanel panelId={panel.id} sessionId={panel.sessionId} isActive={isActive} />;
      case 'browser':
        return <BrowserPanel panel={panel} isActive={isActive} />;
      case 'device':
        return <DevicePanel panel={panel} isActive={isActive} />;
      default:
        return (
          <div className="h-full w-full flex items-center justify-center p-8">
            <div className="text-center max-w-md">
              <h3 className="text-lg font-medium text-text-primary mb-2">
                Unknown Panel Type
              </h3>
              <p className="text-sm text-text-secondary">
                Panel type "{panel.type}" is not recognized.
              </p>
              <p className="text-xs text-text-tertiary mt-2">
                Panel ID: {panel.id}
              </p>
            </div>
          </div>
        );
    }
  }, [panel, isActive, isMainRepo, autoFocus, notesEnabled]); // Include panel to catch state changes

  return (
    <ErrorBoundary
      onError={(error, info) => {
        window.electronAPI?.diagnostics?.rendererFatal({
          kind: 'error-boundary',
          message: error instanceof Error ? error.message : 'Panel render failed',
          stack: error instanceof Error ? error.stack : undefined,
          componentStack: info.componentStack ?? undefined,
        }).catch(() => {});
      }}
      fallbackRender={({ error, resetErrorBoundary }) => (
        <PanelErrorFallback
          // SAFETY: Panel children only throw Error instances.
          error={error as Error}
          resetErrorBoundary={resetErrorBoundary}
          autoRetry={autoRetry}
        />
      )}
      resetKeys={[panel.id]} // Only reset when panel changes
    >
      <Suspense fallback={panel.type === 'terminal'
        ? <div className="relative h-full w-full bg-[var(--color-terminal-bg)]"><TerminalSkeleton panelId={panel.id} chain={panel.sessionId} /></div>
        : <PanelLoadingFallback panelType={panel.type} />}>
        {panelComponent}
      </Suspense>
    </ErrorBoundary>
  );
});

PanelContainer.displayName = 'PanelContainer';
