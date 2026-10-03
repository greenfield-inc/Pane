import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { SessionProvider } from '../contexts/SessionContext';
import { PanelContainer } from './panels/PanelContainer';
import { useConfigStore } from '../stores/configStore';
import { useHostTerminalStore } from '../stores/hostTerminalStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useRemoteRuntimeState } from '../hooks/useRemoteRuntimeState';
import { HOST_ICONS } from '../utils/hostKind';
import { getActiveRemoteProfile, getHostTerminalPresentation, openHostTerminal } from '../utils/hostTerminal';

const TAB_ID = 'host-terminal-tab';
const TAB_PANEL_ID = 'host-terminal-tabpanel';

/** The active host's plain shell, shown as one main-area tab. Closing the tab keeps the shell running. */
export function HostTerminalView() {
  const terminal = useHostTerminalStore((state) => state.terminal);
  const navigateToSessions = useNavigationStore((state) => state.navigateToSessions);
  const profiles = useConfigStore((state) => state.config?.remoteDaemon?.client.profiles);
  const { connectionState } = useRemoteRuntimeState();
  const [error, setError] = useState<string | null>(null);
  const presentation = getHostTerminalPresentation(getActiveRemoteProfile(connectionState, profiles ?? []));
  const HostIcon = HOST_ICONS[presentation.icon];

  // A reload keeps the view but not the store: ask the host for its terminal again.
  useEffect(() => {
    if (terminal) return;
    openHostTerminal().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [terminal]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary" aria-label={presentation.name}>
      <div className="flex h-[var(--panel-tab-height)] flex-shrink-0 items-center border-b border-border-primary">
        <div role="tablist" aria-label={presentation.name} className="flex items-center">
          <div className="group relative inline-flex h-[var(--panel-tab-height)] min-w-[8rem] items-center px-3 pr-8 text-sm text-text-primary">
            <button
              id={TAB_ID}
              type="button"
              role="tab"
              aria-selected={true}
              aria-controls={TAB_PANEL_ID}
              aria-label={presentation.tabTitle}
              className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus-ring-subtle"
            />
            <span className="relative z-10 pointer-events-none inline-flex min-w-0 items-center gap-2">
              <HostIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{presentation.tabTitle}</span>
            </span>
            <button
              type="button"
              aria-label={`Close ${presentation.tabTitle}`}
              className="absolute right-1.5 top-1/2 z-20 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
              onClick={navigateToSessions}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>
      </div>
      <div id={TAB_PANEL_ID} role="tabpanel" aria-labelledby={TAB_ID} className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <p role="alert" className="p-4 text-sm text-status-error">{`Could not open ${presentation.name}: ${error}`}</p>
        ) : terminal ? (
          <SessionProvider session={terminal.session}>
            <PanelContainer key={terminal.panel.id} panel={terminal.panel} isActive={true} autoFocus={true} />
          </SessionProvider>
        ) : null}
      </div>
    </div>
  );
}
