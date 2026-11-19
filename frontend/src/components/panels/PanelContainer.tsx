import { DevicePanel } from './device/DevicePanel';
import React, { Suspense, lazy, useMemo, useState } from 'react';
import { PanelContainerProps } from '../../types/panelComponents';
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
import { BrowserSlot } from './browser/BrowserLayer';
import { PanelErrorBoundary } from './PanelErrorBoundary';

const NotesPanel = lazy(() => import('./notes/NotesPanel'));

export const PanelContainer: React.FC<PanelContainerProps> = React.memo(({
  panel,
  isActive,
  isMainRepo = false,
  autoFocus
}) => {
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
        // The page itself renders in the app-level BrowserLayer, which keeps held tabs alive.
        return <BrowserSlot panel={panel} isActive={isActive} />;
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
    <PanelErrorBoundary panelId={panel.id}>
      <Suspense fallback={panel.type === 'terminal'
        ? <div className="relative h-full w-full bg-[var(--color-terminal-bg)]"><TerminalSkeleton panelId={panel.id} chain={panel.sessionId} /></div>
        : <PanelLoadingFallback panelType={panel.type} />}>
        {panelComponent}
      </Suspense>
    </PanelErrorBoundary>
  );
});

PanelContainer.displayName = 'PanelContainer';
