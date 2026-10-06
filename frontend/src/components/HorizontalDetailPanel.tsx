import { detailBranchLabel, detailIdeItems, remoteIdeTooltip } from './detail-panel-options';
import React, { useMemo } from 'react';
import { AlertTriangle, ArrowLeftRight, ChevronDown, ChevronUp, Code2, GitBranch, Link, Settings } from 'lucide-react';
import { useSession } from '../contexts/SessionContext';
import { useNavigationStore } from '../stores/navigationStore';
import { Button } from './ui/Button';
import { Dropdown, DropdownMenuItem } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import { GitHistoryGraph } from './GitHistoryGraph';
import { useScrollSurface } from '../hooks/useScrollSurface';
import { InspectorTabs, type InspectorTab } from './InspectorTabs';
import { PanelContainer } from './panels/PanelContainer';
import type { ToolPanel } from '../../../shared/types/panels';
import { OuterResizeSeparator, type OuterResizeSeparatorProps } from './ui/OuterResizeSeparator';

interface HorizontalDetailPanelProps {
  height?: number;
  availableHeight?: number;
  resizeSeparator?: OuterResizeSeparatorProps;
  bodyActive?: boolean;
  mergeError?: string | null;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onSwapLayout?: () => void;
  terminalShortcuts?: React.ReactNode;
  onCommitClick?: (hash: string) => void;
  inspectorTab?: InspectorTab;
  onInspectorTabChange?: (tab: InspectorTab) => void;
  filesPanel?: ToolPanel;
  changesPanel?: ToolPanel;
  changesCount?: number;
  isMainRepo?: boolean;
}

export function HorizontalDetailPanel({
  height,
  availableHeight,
  resizeSeparator,
  bodyActive = true,
  mergeError,
  isCollapsed,
  onToggleCollapse,
  onSwapLayout,
  terminalShortcuts,
  onCommitClick,
  inspectorTab = 'details',
  onInspectorTabChange,
  filesPanel,
  changesPanel,
  changesCount,
  isMainRepo = false,
}: HorizontalDetailPanelProps) {
  const hostedPanel = inspectorTab === 'files' ? filesPanel : inspectorTab === 'changes' ? changesPanel : undefined;
  const showDetails = inspectorTab === 'details' || !hostedPanel;
  const sessionContext = useSession();
  const immersiveMode = useNavigationStore(state => state.immersiveMode);
  const detailPanelRef = React.useRef<HTMLDivElement>(null);
  const detailScrollSurfaceRef = useScrollSurface<HTMLDivElement>({
    id: `detail:${sessionContext?.session.id ?? 'unavailable'}`,
    sessionId: sessionContext?.session.id,
    enabled: Boolean(sessionContext && bodyActive && !isCollapsed && !immersiveMode),
    priority: 30,
    ownerElement: () => detailPanelRef.current,
  });
  const ideItems = useMemo(
    () => detailIdeItems(sessionContext?.configuredIDECommand, sessionContext?.onOpenIDEWithCommand),
    [sessionContext?.configuredIDECommand, sessionContext?.onOpenIDEWithCommand],
  );

  if (!sessionContext) return null;

  const {
    session,
    gitBranchActions,
    isMerging,
    gitCommands,
    onOpenIDEWithCommand,
    onConfigureIDE,
    onSetTracking,
    trackingBranch,
    isRemoteMode,
  } = sessionContext;
  const gitStatus = session.gitStatus;
  const isProject = !!session.isMainRepo;
  const gitUnavailable = isProject && gitStatus?.state === 'unknown';
  const collapsedContentActive = Boolean(isCollapsed) && (availableHeight ?? 0) > 0;
  const contentActive = !immersiveMode && (bodyActive || collapsedContentActive);

  return (
    <div
      ref={detailPanelRef}
      className={`pane-detail-panel pane-detail-panel-horizontal flex-shrink-0 bg-surface-primary flex flex-col overflow-visible relative ${immersiveMode ? '' : 'border-t border-border-primary'}`}
      style={immersiveMode
        ? { height: '0px' }
        : isCollapsed
          ? {
              height: 'auto',
              maxHeight: availableHeight === undefined ? undefined : `${Math.max(0, Math.floor(availableHeight))}px`,
            }
          : { height: `${height ?? 200}px` }}
    >
      {resizeSeparator && !immersiveMode && <OuterResizeSeparator {...resizeSeparator} />}

      <div
        className="pane-detail-panel-inner flex flex-col h-full min-h-0 overflow-hidden"
        aria-hidden={!contentActive}
        inert={!contentActive ? true : undefined}
      >
        {onInspectorTabChange && bodyActive && !isCollapsed && (
          <InspectorTabs
            tab={showDetails ? 'details' : inspectorTab}
            onTabChange={onInspectorTabChange}
            filesPanel={filesPanel}
            changesPanel={changesPanel}
            changesCount={changesCount}
          />
        )}
        {[filesPanel, changesPanel].map(panel => panel && (
          <div
            key={panel.id}
            className="pane-inspector-host flex-1 min-h-0 relative"
            style={{ display: bodyActive && panel === hostedPanel && !showDetails && !isCollapsed ? 'flex' : 'none' }}
            aria-hidden={!bodyActive || panel !== hostedPanel || showDetails || isCollapsed}
            inert={!bodyActive || panel !== hostedPanel || showDetails || isCollapsed ? true : undefined}
          >
            <PanelContainer panel={panel} isActive={bodyActive && !immersiveMode && panel === hostedPanel && !showDetails && !isCollapsed} isMainRepo={isMainRepo} autoFocus={false} />
          </div>
        ))}
        {(showDetails || isCollapsed) && (<>
        <div className="flex items-start flex-shrink-0">
          <div className="flex items-center flex-wrap flex-1 min-w-0 min-h-[32px] px-3 gap-x-2 gap-y-1 py-1">
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={isCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
              className="p-0.5 hover:bg-surface-hover rounded transition-colors"
              title={isCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
            >
              {isCollapsed
                ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
                : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
            </button>

            <GitBranch className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
            <span className="text-sm text-text-primary font-medium truncate max-w-[150px]">
              {detailBranchLabel(gitCommands?.currentBranch, session.baseBranch)}
            </span>

            {!isProject && gitStatus && (
              <div className="flex items-center gap-2 flex-shrink-0">
                {!!gitStatus.ahead && <span className="text-[10px] text-status-success font-medium">&uarr;{gitStatus.ahead}</span>}
                {!!gitStatus.behind && <span className="text-[10px] text-status-warning font-medium">&darr;{gitStatus.behind}</span>}
                {gitStatus.hasUncommittedChanges && !!gitStatus.filesChanged && (
                  <span className="text-[10px] text-status-info font-medium">{gitStatus.filesChanged} files</span>
                )}
              </div>
            )}

            {mergeError && (
              <Tooltip content={mergeError} side="top">
                <AlertTriangle className="w-3.5 h-3.5 text-status-error flex-shrink-0" />
              </Tooltip>
            )}

            {!gitUnavailable && gitBranchActions?.map(action => (
              <Tooltip key={action.id} content={action.label + (action.description ? ` — ${action.description}` : '')} side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0"
                  aria-label={action.label}
                  onClick={action.onClick}
                  disabled={action.disabled || isMerging}
                >
                  <action.icon className="w-3 h-3" />
                </Button>
              </Tooltip>
            ))}

            {!gitUnavailable && onSetTracking && (
              <Tooltip content={trackingBranch ? `Set upstream tracking branch (currently ${trackingBranch})` : 'Set upstream tracking branch for git pull/push'} side="top">
                <Button variant="ghost" size="sm" className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0" aria-label="Set Tracking" onClick={onSetTracking} disabled={isMerging}>
                  <Link className="w-3 h-3" />
                </Button>
              </Tooltip>
            )}

            {onOpenIDEWithCommand && (isRemoteMode ? (
              <Tooltip content={remoteIdeTooltip} side="top">
                <span>
                  <Button variant="ghost" size="sm" className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0" aria-label="Open in IDE" disabled>
                    <Code2 className="w-3 h-3" />
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Dropdown
                trigger={(
                  <Tooltip content="Open in IDE" side="top">
                    <Button variant="ghost" size="sm" className="!px-1.5 !py-0.5 text-xs h-6 flex-shrink-0" aria-label="Open in IDE">
                      <Code2 className="w-3 h-3" />
                    </Button>
                  </Tooltip>
                )}
                items={ideItems}
                footer={onConfigureIDE ? <DropdownMenuItem icon={Settings} label="Configure..." onClick={onConfigureIDE} /> : undefined}
                position="auto"
                width="sm"
              />
            ))}

            {terminalShortcuts}
          </div>

          {onSwapLayout && (
            <Tooltip content="Swap terminal and detail panel positions" side="top">
              <button
                type="button"
                aria-label="Swap terminal and detail panel positions"
                onClick={onSwapLayout}
                className="p-1 hover:bg-surface-hover rounded transition-colors flex-shrink-0 mr-2 mt-1"
              >
                <ArrowLeftRight aria-hidden="true" className="w-3.5 h-3.5 text-text-tertiary" />
              </button>
            </Tooltip>
          )}
        </div>

        {bodyActive && !isCollapsed && !gitUnavailable && session.worktreePath && (
          <div
            ref={detailScrollSurfaceRef}
            role="region"
            tabIndex={0}
            aria-label="Commit history"
            className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
          >
            <GitHistoryGraph
              sessionId={session.id}
              baseBranch={session.baseBranch || 'main'}
              layout="wide"
              onCommitClick={onCommitClick}
            />
          </div>
        )}
        </>)}
      </div>
    </div>
  );
}
