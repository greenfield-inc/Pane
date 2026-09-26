/**
 * PanelGroupView: renders a single tab group within the split layout.
 *
 * Each group has:
 * - A tab strip row once the pane is split: the group's working tabs and a
 *   "+" for adding a tool to this group. It occupies a layout row so it
 *   pushes content down instead of covering it. Single-group panes render no
 *   strip here at all (the top bar is the strip then).
 * - An absolute-positioned panel stack (the editor-stage pattern: inactive
 *   terminals stay mounted behind display:none so xterm never reflows).
 * - A DropOverlay when a tab drag is in progress.
 * - A drag shield to intercept mouse events from webviews/xterm during drags.
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { Plus } from 'lucide-react';
import { PanelTabStrip } from './PanelTabStrip';
import { getPanelTabId, getPanelTabPanelId } from './panelTabIds';
import { PanelContainer } from './PanelContainer';
import type { ToolPanel, PanelGroupNode } from '../../../../shared/types/panels';
import { dropZoneFor, subsetInsertIndex, type DropZone } from '../../utils/panelLayout';
import { cn } from '../../utils/cn';
import type { PanelTabPresentationResolver } from '../../types/panelComponents';

// ---------------------------------------------------------------------------
// DropOverlay
// ---------------------------------------------------------------------------

interface DropOverlayProps {
  onZoneChange: (zone: DropZone | null) => void;
  onDrop: (zone: DropZone) => void;
  activeZone: DropZone | null;
}

const DropOverlay: React.FC<DropOverlayProps> = React.memo(({ onZoneChange, onDrop, activeZone }) => {
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    onZoneChange(dropZoneFor(e.clientX, e.clientY, rect));
  }, [onZoneChange]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (activeZone) {
      onDrop(activeZone);
    }
  }, [activeZone, onDrop]);

  const handleDragLeave = useCallback(() => {
    onZoneChange(null);
  }, [onZoneChange]);

  return (
    <div
      className="absolute inset-0 z-20"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {/* Zone highlight overlays */}
      {activeZone === 'center' && (
        <div className="absolute inset-4 border-2 border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-interactive-primary)_10%,transparent)] rounded pointer-events-none" />
      )}
      {activeZone === 'left' && (
        <div className="absolute inset-y-0 left-0 w-1/4 border-2 border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-interactive-primary)_10%,transparent)] pointer-events-none" />
      )}
      {activeZone === 'right' && (
        <div className="absolute inset-y-0 right-0 w-1/4 border-2 border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-interactive-primary)_10%,transparent)] pointer-events-none" />
      )}
      {activeZone === 'top' && (
        <div className="absolute inset-x-0 top-0 h-1/4 border-2 border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-interactive-primary)_10%,transparent)] pointer-events-none" />
      )}
      {activeZone === 'bottom' && (
        <div className="absolute inset-x-0 bottom-0 h-1/4 border-2 border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-interactive-primary)_10%,transparent)] pointer-events-none" />
      )}
    </div>
  );
});

DropOverlay.displayName = 'DropOverlay';

// ---------------------------------------------------------------------------
// PanelGroupView
// ---------------------------------------------------------------------------

export interface PanelGroupViewProps {
  group: PanelGroupNode;
  /** All panels available for this group (resolved from panelIds). */
  groupPanels: ToolPanel[];
  /** Whether this is the primary (first) group — its tabs render in PanelTabBar. */
  isPrimary: boolean;
  /** Whether this group has keyboard focus. */
  isFocusedGroup: boolean;
  /**
   * Whether the session layout has more than one group. Gates focus chrome:
   * a single-group session must render pixel-identically to the pre-split UI,
   * so the focus ring only appears once a real split exists.
   */
  multiGroup: boolean;
  /** Whether this is a main repo session. */
  isMainRepo: boolean;

  // --- Tab strip callbacks ---
  onPanelSelect: (panel: ToolPanel) => void;
  onPanelClose: (panel: ToolPanel) => void;

  // --- Focus ---
  onFocusGroup: (groupId: string) => void;

  // --- Drag & drop ---
  isTabDragging?: boolean;
  draggedPanelId?: string | null;
  activeDropZone?: DropZone | null;
  onDropZoneChange?: (groupId: string, zone: DropZone | null) => void;
  onDropTab?: (groupId: string, zone: DropZone) => void;
  onDragStart?: (panelId: string) => void;
  onDragEnd?: () => void;
  onStripDrop?: (panelId: string, insertIndex: number) => void;
  getPanelTabPresentation?: PanelTabPresentationResolver;
  emptyState?: React.ReactNode;
  showAddTool?: boolean;
  alwaysShowClose?: boolean;
}

export const PanelGroupView: React.FC<PanelGroupViewProps> = React.memo(({
  group,
  groupPanels,
  isPrimary,
  isFocusedGroup,
  multiGroup,
  isMainRepo,
  onPanelSelect,
  onPanelClose,
  onFocusGroup,
  isTabDragging = false,
  draggedPanelId = null,
  activeDropZone = null,
  onDropZoneChange,
  onDropTab,
  onDragStart,
  onDragEnd,
  onStripDrop,
  getPanelTabPresentation,
  emptyState,
  showAddTool = true,
  alwaysShowClose = false,
}) => {
  const handleMouseDownCapture = useCallback(() => {
    onFocusGroup(group.id);
  }, [onFocusGroup, group.id]);

  const handleZoneChange = useCallback((zone: DropZone | null) => {
    onDropZoneChange?.(group.id, zone);
  }, [onDropZoneChange, group.id]);

  const handleDrop = useCallback((zone: DropZone) => {
    onDropTab?.(group.id, zone);
  }, [onDropTab, group.id]);

  // Resolve panels in layout order
  const orderedPanels = useMemo(() => {
    const panelMap = new Map(groupPanels.map(p => [p.id, p]));
    return group.panelIds.map(id => panelMap.get(id)).filter((p): p is ToolPanel => !!p);
  }, [group.panelIds, groupPanels]);

  // Permanent tool tabs (Diff/Explorer/Browser) are hoisted to PanelTabBar
  // from EVERY group while split, so strips carry only working tabs. Their
  // content still renders inside whichever group owns them.
  const stripPanels = useMemo(
    () => orderedPanels.filter(p => p.metadata?.permanent !== true),
    [orderedPanels],
  );

  // Strip drop indexes are relative to the displayed subset; translate to the
  // group's full panel order before moving.
  const handleStripDrop = useCallback((panelId: string, subsetIndex: number) => {
    if (!onStripDrop) return;
    onStripDrop(panelId, subsetInsertIndex(
      group.panelIds,
      stripPanels.map(p => p.id),
      subsetIndex,
    ));
  }, [onStripDrop, group.panelIds, stripPanels]);

  // New tools land in the focused group, so focus this one before asking the
  // top bar (which owns the menu) to open it here.
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const handleAddTool = useCallback(() => {
    onFocusGroup(group.id);
    window.dispatchEvent(new CustomEvent('pane:open-add-tool', {
      detail: { rect: addButtonRef.current?.getBoundingClientRect() ?? null },
    }));
  }, [onFocusGroup, group.id]);

  return (
    <div
      className={cn(
        "h-full flex flex-col",
        multiGroup && isFocusedGroup && "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-interactive-primary)_30%,transparent)]",
      )}
      onMouseDownCapture={handleMouseDownCapture}
    >
      {/* Once the pane is split each group owns a full tab strip — its working
          tabs plus a "+" that opens the add-tool menu for this group. The row
          pushes content down so it never covers it. Single-group panes
          render no strip here (the top bar is the strip then). */}
      {multiGroup && (
        <div className="panel-group-tab-bar flex-shrink-0 flex items-center bg-bg-chrome border-b border-border-primary pr-2">
          <PanelTabStrip
            idNamespace={group.id}
            panels={stripPanels}
            activePanelId={group.activePanelId}
            onPanelSelect={onPanelSelect}
            onPanelClose={onPanelClose}
            isPrimary={isPrimary}
            isFocused={isFocusedGroup}
            showShortcutHints={false}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onStripDrop={handleStripDrop}
            isTabDragging={isTabDragging}
            draggedPanelId={draggedPanelId}
            getPanelTabPresentation={getPanelTabPresentation}
            alwaysShowClose={alwaysShowClose}
          />
          {showAddTool && <button
            ref={addButtonRef}
            type="button"
            aria-label="Add tool"
            aria-haspopup="menu"
            className="inline-flex items-center justify-center h-7 w-7 ml-0.5 flex-shrink-0 text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
            onClick={handleAddTool}
          >
            <Plus className="w-4 h-4" />
          </button>}
        </div>
      )}

      {/* Panel content stack: only the active tab is displayed. Terminals stay
          mounted so xterm never reflows; Review stays mounted so navigation
          does not discard the user's local diff state. */}
      <div className="flex-1 relative min-h-0 overflow-hidden bg-bg-editor">
        {orderedPanels.map(panel => {
          const isActiveTab = panel.id === group.activePanelId;
          const keepAlive = panel.type === 'terminal' || panel.type === 'diff';
          const panelTabNamespace = !multiGroup || panel.metadata?.permanent === true ? 'top' : group.id;
          if (!isActiveTab && !keepAlive) return null;
          return (
            <div
              key={panel.id}
              id={getPanelTabPanelId(panelTabNamespace, panel.id)}
              role="tabpanel"
              aria-labelledby={getPanelTabId(panelTabNamespace, panel.id)}
              aria-hidden={!isActiveTab}
              inert={!isActiveTab ? true : undefined}
              className="absolute inset-0"
              style={{
                display: isActiveTab ? 'block' : 'none',
                pointerEvents: isActiveTab ? 'auto' : 'none',
              }}
            >
              <PanelContainer
                panel={panel}
                isActive={isActiveTab}
                autoFocus={isFocusedGroup && isActiveTab}
                isMainRepo={isMainRepo}
              />
            </div>
          );
        })}

        {/* Drag shield: prevents webview/xterm from swallowing drag events */}
        {isTabDragging && (
          <div className="absolute inset-0 z-10" style={{ background: 'transparent' }} />
        )}

        {/* Drop overlay: 5-zone targeting */}
        {isTabDragging && (
          <DropOverlay
            onZoneChange={handleZoneChange}
            onDrop={handleDrop}
            activeZone={activeDropZone}
          />
        )}

        {/* Empty state */}
        {orderedPanels.length === 0 && (emptyState ?? (
          <div className="flex-1 flex items-center justify-center text-text-secondary h-full">
            <div className="text-center p-4">
              <p className="text-sm">Empty group</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

PanelGroupView.displayName = 'PanelGroupView';
