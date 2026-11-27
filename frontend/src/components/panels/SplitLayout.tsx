/**
 * SplitLayout: recursive allotment-based renderer for the layout tree.
 *
 * - The root always uses Allotment, including a single group, so opening or
 *   closing a sibling split preserves the existing mounted terminal.
 * - Split nodes render <Allotment> with one <Allotment.Pane> per child keyed
 *   by child.id.
 * - Zoom: sets Allotment.Pane visible={false} on non-zoomed branches.
 *
 * Imports allotment/dist/style.css and overrides theme tokens.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Allotment, type AllotmentHandle } from 'allotment';
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
import { useAllotmentSizeSync } from '../../hooks/useAllotmentSizeSync';
import { splitPixelSizes, type SplitPixels } from '../../utils/splitPixelSizes';

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
  /**
   * Permanent tabs stay in their group's strip instead of being hoisted to a
   * top bar. For views with no top bar while split (the Session workspace), so
   * every tab sits on the same row.
   */
  keepPermanentTabsInGroups?: boolean;
  /** Replaces each group strip's "+" button (see PanelGroupView). */
  renderAddTool?: (groupId: string) => React.ReactNode;
  /**
   * Maximize a group over the others, or restore (P4). Absent where maximize
   * means nothing (a single group with nowhere to grow).
   */
  onToggleMaximize?: (groupId: string) => void;
  /**
   * Every group is hidden (a maximized Session tile covers this one), so its
   * terminals deactivate and their reveal runs the masked activation refresh.
   */
  hidden?: boolean;
  /** Content for a tab that has no panel component of its own (a Session's Overview); undefined renders the panel. */
  renderPanelContent?: (panel: ToolPanel) => React.ReactNode | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** No pane narrower or shorter than this. */
const MIN_PANE_PX = 120;

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
  keepPermanentTabsInGroups,
  renderAddTool,
  onToggleMaximize,
  hidden = false,
  renderPanelContent,
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

  // Allotment's defaultSizes is mount-only, so an n-ary tab drop that adds or
  // removes a sibling needs the model synced from what was actually drawn.
  const recordLiveSizes = useAllotmentSizeSync<PanelGroupNode>(layout.root, onSizesChange);

  // Allotment lays its panes out only when the resize observer it starts in a passive
  // effect reports, so a layout mounted by a commit whose effects run after paint (a
  // Session shown from a peek, T-140) painted its panes unsized first: the chat shrunk
  // or centered, the split arriving a frame later. Instead the stage is measured before
  // Allotment mounts (one empty commit, before paint); each Allotment mounts with pane
  // sizes in pixels that fill it and is laid out in this commit's layout effect, and
  // each pane's content mounts at its size, so what it measures as it mounts (a chat's
  // composer and scroll) is already final. Then the panes follow Allotment as before.
  const stageRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<SplitPixels | null | undefined>(undefined);
  const [sized, setSized] = useState(false);
  useLayoutEffect(() => {
    if (mounted !== undefined || !stageRef.current) return;
    const { width, height } = stageRef.current.getBoundingClientRect();
    // A stage with no size yet (hidden), or a maximized group (Allotment applies hidden panes only
    // once it has measured): Allotment sizes itself when it reports, as before.
    setMounted(width > 0 && height > 0 && !zoomedGroupId ? splitPixelSizes(layout.root, { width, height }, MIN_PANE_PX) : null);
  }, [mounted, layout.root, zoomedGroupId]);
  const handles = useRef(new Map<string, AllotmentHandle>());
  const laidOut = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!mounted) return;
    for (const [id, handle] of handles.current) {
      const sizes = mounted.sizes.get(id);
      if (!sizes || laidOut.current.has(id)) continue;
      laidOut.current.add(id);
      handle.resize(sizes);
    }
    if (!sized) setSized(true);
  }, [mounted, sized]);
  /** A pane's content: at its measured size while Allotment lays out, then filling the pane. */
  const paneContent = useCallback((id: string, content: React.ReactNode) => {
    const box = sized ? undefined : mounted?.boxes.get(id);
    return <div className="h-full w-full" style={box ? { width: box.width, height: box.height } : undefined}>{content}</div>;
  }, [mounted, sized]);

  // Recursive render
  const renderNode = useCallback((node: PanelLayoutNode, isRoot = false): React.ReactNode => {
    if (node.type === 'group' && !isRoot) {
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
          keepPermanentTabsInGroups={keepPermanentTabsInGroups}
          renderAddTool={renderAddTool}
          isMaximized={zoomedGroupId === node.id}
          isHidden={hidden || (zoomedGroupId !== null && zoomedGroupId !== node.id)}
          onToggleMaximize={multiGroup ? onToggleMaximize : undefined}
          renderPanelContent={renderPanelContent}
        />
      );
    }

    // Split node. Sizes are persisted on drag end only: onChange fires per
    // pointer move (and on zoom show/hide re-layouts), and a store write per
    // frame would re-render every group, with live xterm instances inside,
    // on each frame of a sash drag. onChange writes only to a ref, feeding
    // the structural-change sync above.
    const handleDragEnd = (sizes: number[]) => {
      if (node.type === 'split') onSizesChange(node.id, sizes);
    };
    const handleChange = (sizes: number[]) => {
      if (node.type === 'split') recordLiveSizes(node.id, sizes);
    };

    return (
      <Allotment
        // Allotment captures orientation on mount. Preserve the row root used
        // by sibling tabs, but rebuild when changing to/from a column split.
        key={isRoot ? (node.type === 'split' && node.direction === 'column' ? 'root-column' : 'root-row') : node.id}
        vertical={node.type === 'split' && node.direction === 'column'}
        ref={handle => {
          if (handle) handles.current.set(node.id, handle);
          else handles.current.delete(node.id);
        }}
        // Measured sizes only for the first mount: a split mounted later (a column promoted to the
        // root, say) takes the model's sizes, which follow every sash drag since.
        defaultSizes={(!sized && mounted?.sizes.get(node.id)) || (node.type === 'split' ? node.sizes : undefined)}
        proportionalLayout
        onChange={handleChange}
        onDragEnd={handleDragEnd}
      >
        {(node.type === 'group' ? [node] : node.children).map(child => {
          const isVisible = !zoomedGroupId || containsGroup(child, zoomedGroupId);
          return (
            <Allotment.Pane
              key={child.id}
              minSize={MIN_PANE_PX}
              visible={isVisible}
            >
              {paneContent(child.id, renderNode(child))}
            </Allotment.Pane>
          );
        })}
      </Allotment>
    );
  }, [
    resolvePanels, primaryGroupId, focusedGroupId, multiGroup, isMainRepo,
    onPanelSelect, onPanelClose, onFocusGroup, onSizesChange, recordLiveSizes,
    isTabDragging, draggedPanelId, dropZones, onDropZoneChange,
    onDropTab, onDragStart, onDragEnd, onStripDrop, getPanelTabPresentation, zoomedGroupId, emptyState,
    showAddTool, alwaysShowClose, keepPermanentTabsInGroups, renderAddTool,
    onToggleMaximize, hidden, renderPanelContent, mounted, sized, paneContent,
  ]);

  // Measured first: the empty stage takes the place Allotment's root then fills (both fill their parent).
  if (mounted === undefined) return <div ref={stageRef} className="h-full w-full" />;
  return <>{renderNode(layout.root, true)}</>;
});

SplitLayout.displayName = 'SplitLayout';
