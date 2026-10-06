import React, { Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import { PanelContainerProps } from '../../types/panelComponents';
import { ErrorBoundary } from 'react-error-boundary';
import { PanelLoadingFallback } from './PanelLoadingFallback';
import { renderLog } from '../../utils/console';

// Lazy load panel components for better performance
const TerminalPanel = lazy(() => import('./TerminalPanel'));
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
  renderLog('[PanelContainer] Rendering panel:', panel.id, 'Type:', panel.type, 'Active:', isActive);
  
  // FIX: Use stable panel rendering without forcing remounts
  // Each panel type maintains its own state internally
  // The isActive prop controls whether it should render its content
  
  const panelComponent = useMemo(() => {
    renderLog('[PanelContainer] Creating component for panel type:', panel.type);

    // Panel type rendering
    switch (panel.type) {
      case 'notes':
        return <NotesPanel paneId={panel.sessionId} viewId={panel.id} />;
      case 'terminal':
        return <TerminalPanel panel={panel} isActive={isActive} autoFocus={autoFocus} />;
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
  }, [panel, isActive, isMainRepo, autoFocus]); // Include panel to catch state changes

  return (
    <ErrorBoundary
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
      <Suspense fallback={
        <PanelLoadingFallback 
          panelType={panel.type}
          message={`Loading ${panel.type} panel...`}
        />
      }>
        {panelComponent}
      </Suspense>
    </ErrorBoundary>
  );
});

PanelContainer.displayName = 'PanelContainer';
