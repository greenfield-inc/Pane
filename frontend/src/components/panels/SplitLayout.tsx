/**
 * SplitLayout: recursive allotment-based renderer for the layout tree.
 *
 * - Single-group root renders PanelGroupView directly (no Allotment wrapper)
 *   so the default DOM matches today.
 * - Split nodes render <Allotment> with one <Allotment.Pane> per child keyed
 *   by child.id.
 * - Zoom: sets Allotment.Pane visible={false} on non-zoomed branches.
 *
 * Imports allotment/dist/style.css and overrides theme tokens.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { PanelGroupView } from './PanelGroupView';
import type {
  PanelLayoutNode,
  PanelGroupNode,
  SessionPanelLayout,
  ToolPanel,
} from '../../../../shared/types/panels';
import { containsGroup } from '../../utils/panelLayout';
import type { DropZone } from '../../utils/panelLayout';
import type { PanelTabPresentationResolver } from '../../types/panelComponents';

// ---------------------------------------------------------------------------
// Allotment theme overrides (inlined as a style element on first render)
// ---------------------------------------------------------------------------

const ALLOTMENT_THEME_CSS = `
  .split-view-view > .sash-container > .sash {
    --separator-border: var(--color-border-primary, #2d2d2d) !important;
    --focus-border: var(--color-interactive, #4a9eff) !important;
  }
`;

let themeInjected = false;
function injectTheme() {
  if (themeInjected) return;
  themeInjected = true;
  const style = document.createElement('style');
  style.textContent = ALLOTMENT_THEME_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SplitLayoutProps {
  layout: SessionPanelLayout;
  /** All panels for this session (excluding the pinned terminal). */
  panels: ToolPanel[];
  focusedGroupId: string;
  isMainRepo: boolean;

  // --- Callbacks ---
  onSizesChange: (splitNodeId: string, sizes: number[]) => void;
  onPanelSelect: (groupId: string, panel: ToolPanel) => void;
  onPanelClose: (panel: ToolPanel) => void;
  onFocusGroup: (groupId: string) => void;

  // --- Drag & drop ---
  isTabDragging?: boolean;
  draggedPanelId?: string | null;
  dropZones?: Map<string, DropZone | null>;
  onDropZoneChange?: (groupId: string, zone: DropZone | null) => void;
  onDropTab?: (groupId: string, zone: DropZone) => void;
  onDragStart?: (panelId: string) => void;
  onDragEnd?: () => void;
  onStripDrop?: (groupId: string, panelId: string, insertIndex: number) => void;
  getPanelTabPresentation?: PanelTabPresentationResolver;
  /** Rendered in a group that has no working panels. */
  emptyState?: React.ReactNode;
  /** Group strips show the "+" add-tool button (default true). */
  showAddTool?: boolean;
  /** Group strips keep tab close buttons visible instead of on hover. */
  alwaysShowClose?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SplitLayout: React.FC<SplitLayoutProps> = React.memo(({
  layout,
  panels,
  focusedGroupId,
  isMainRepo,
  onSizesChange,
  onPanelSelect,
  onPanelClose,
  onFocusGroup,
  isTabDragging = false,
  draggedPanelId = null,
  dropZones,
  onDropZoneChange,
  onDropTab,
  onDragStart,
  onDragEnd,
  onStripDrop,
  getPanelTabPresentation,
  emptyState,
  showAddTool,
  alwaysShowClose,
}) => {
  // Inject allotment theme CSS on first render
  React.useEffect(() => { injectTheme(); }, []);

  // Build a panel lookup map
  const panelMap = useMemo(() => {
    const map = new Map<string, ToolPanel>();
    for (const p of panels) map.set(p.id, p);
    return map;
  }, [panels]);

  const zoomedGroupId = layout.zoomedGroupId ?? null;

  // Helper: is this the primary (first) group?
  const primaryGroupId = useMemo(() => {
    function findFirst(node: PanelLayoutNode): string {
      if (node.type === 'group') return node.id;
      return findFirst(node.children[0]);
    }
    return findFirst(layout.root);
  }, [layout.root]);

  // Resolve panels for a group
  const resolvePanels = useCallback((group: PanelGroupNode): ToolPanel[] => {
    return group.panelIds.map(id => panelMap.get(id)).filter((p): p is ToolPanel => !!p);
  }, [panelMap]);

  // Focus chrome only exists once a real split does (pixel-identical rule)
  const multiGroup = layout.root.type === 'split';

  // Allotment's defaultSizes is mount-only, so when a sibling is added to or
  // removed from an existing split (n-ary tab drop), the on-screen
  // distribution diverges from the stored model until the next sash drag.
  // onChange keeps a live snapshot per split (ref only, no re-render); when a
  // split's child count changes, the model syncs from that snapshot once.
  const liveSizesRef = useRef(new Map<string, number[]>());
  const childCountsRef = useRef(new Map<string, number>());
  useEffect(() => {
    const changed: string[] = [];
    const seen = new Set<string>();
    (function walk(node: PanelLayoutNode) {
      if (node.type !== 'split') return;
      seen.add(node.id);
      const prev = childCountsRef.current.get(node.id);
      if (prev !== undefined && prev !== node.children.length) changed.push(node.id);
      childCountsRef.current.set(node.id, node.children.length);
      node.children.forEach(walk);
    })(layout.root);
    for (const id of Array.from(childCountsRef.current.keys())) {
      if (!seen.has(id)) {
        childCountsRef.current.delete(id);
        liveSizesRef.current.delete(id);
      }
    }
    if (changed.length === 0) return;
    // Allotment re-lays out the new pane set after this render; read the
    // snapshot on the next tick. The length guard skips stale pre-change
    // snapshots if onChange has not fired yet (no sync beats a wrong one).
    const timer = setTimeout(() => {
      for (const id of changed) {
        const sizes = liveSizesRef.current.get(id);
        if (sizes && sizes.length === childCountsRef.current.get(id)) {
          onSizesChange(id, sizes);
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [layout.root, onSizesChange]);

  // Recursive render
  const renderNode = useCallback((node: PanelLayoutNode): React.ReactNode => {
    if (node.type === 'group') {
      const groupPanels = resolvePanels(node);
      const isPrimary = node.id === primaryGroupId;
      return (
        <PanelGroupView
          key={node.id}
          group={node}
          groupPanels={groupPanels}
          isPrimary={isPrimary}
          isFocusedGroup={node.id === focusedGroupId}
          multiGroup={multiGroup}
          isMainRepo={isMainRepo}
          onPanelSelect={(panel) => onPanelSelect(node.id, panel)}
          onPanelClose={onPanelClose}
          onFocusGroup={onFocusGroup}
          isTabDragging={isTabDragging}
          draggedPanelId={draggedPanelId}
          activeDropZone={dropZones?.get(node.id) ?? null}
          onDropZoneChange={onDropZoneChange}
          onDropTab={onDropTab}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onStripDrop={onStripDrop ? (panelId, idx) => onStripDrop(node.id, panelId, idx) : undefined}
          getPanelTabPresentation={getPanelTabPresentation}
          emptyState={emptyState}
          showAddTool={showAddTool}
          alwaysShowClose={alwaysShowClose}
        />
      );
    }

    // Split node. Sizes are persisted on drag end only: onChange fires per
    // pointer move (and on zoom show/hide re-layouts), and a store write per
    // frame would re-render every group, with live xterm instances inside,
    // on each frame of a sash drag. onChange writes only to a ref, feeding
    // the structural-change sync above.
    const handleDragEnd = (sizes: number[]) => {
      onSizesChange(node.id, sizes);
    };
    const handleChange = (sizes: number[]) => {
      liveSizesRef.current.set(node.id, sizes);
    };

    return (
      <Allotment
        key={node.id}
        vertical={node.direction === 'column'}
        defaultSizes={node.sizes}
        proportionalLayout
        onChange={handleChange}
        onDragEnd={handleDragEnd}
      >
        {node.children.map(child => {
          const isVisible = !zoomedGroupId || containsGroup(child, zoomedGroupId);
          return (
            <Allotment.Pane
              key={child.id}
              minSize={120}
              visible={isVisible}
            >
              {renderNode(child)}
            </Allotment.Pane>
          );
        })}
      </Allotment>
    );
  }, [
    resolvePanels, primaryGroupId, focusedGroupId, multiGroup, isMainRepo,
    onPanelSelect, onPanelClose, onFocusGroup, onSizesChange,
    isTabDragging, draggedPanelId, dropZones, onDropZoneChange,
    onDropTab, onDragStart, onDragEnd, onStripDrop, getPanelTabPresentation, zoomedGroupId, emptyState,
    showAddTool, alwaysShowClose,
  ]);

  // Single-group root: render directly without Allotment
  if (layout.root.type === 'group') {
    return <>{renderNode(layout.root)}</>;
  }

  // Multi-group: render through Allotment
  return <>{renderNode(layout.root)}</>;
});

SplitLayout.displayName = 'SplitLayout';
