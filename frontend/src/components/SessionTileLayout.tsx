/**
 * SessionTileLayout: recursive allotment-based renderer for the Session tile
 * tree — the outer twin of `SplitLayout`.
 *
 * - A single-tile root renders the tile directly (no Allotment wrapper), so a
 *   window showing one Session keeps exactly today's DOM.
 * - Split nodes render <Allotment> with one <Allotment.Pane> per child, keyed
 *   by child.id.
 * - Every tile stays mounted and live, including the ones not focused: that is
 *   the whole point of tiling Sessions rather than switching between them.
 */

import React, { useCallback, useMemo } from 'react';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import type {
  SessionLayoutNode,
  SessionWorkspaceLayout,
} from '../../../shared/types/sessionWorkspaceLayout';
import type { SessionTileNode } from '../../../shared/types/sessionWorkspaceLayout';
import { useAllotmentSizeSync } from '../hooks/useAllotmentSizeSync';

/** Below this a Session's own tab strip and terminal dock stop being usable. */
const MIN_TILE_PX = 260;

export interface SessionTileLayoutProps {
  layout: SessionWorkspaceLayout;
  focusedTileId: string;
  /** Renders one tile's Session. The tree never looks inside it. */
  renderTile: (tile: SessionTileNode, context: SessionTileContext) => React.ReactNode;
  onSizesChange: (splitNodeId: string, sizes: number[]) => void;
}

export interface SessionTileContext {
  isFocused: boolean;
  /** False only while the window shows a single Session. */
  tiled: boolean;
}

export const SessionTileLayout: React.FC<SessionTileLayoutProps> = React.memo(({
  layout,
  focusedTileId,
  renderTile,
  onSizesChange,
}) => {
  const recordLiveSizes = useAllotmentSizeSync<SessionTileNode>(layout.root, onSizesChange);
  const tiled = layout.root.type === 'split';

  const renderNode = useCallback((node: SessionLayoutNode): React.ReactNode => {
    if (node.type === 'session') {
      return renderTile(node, { isFocused: node.id === focusedTileId, tiled });
    }

    // Sizes persist on drag end only: onChange fires per pointer move, and a
    // store write per frame would re-render every tile — each with live xterm
    // instances inside — on every frame of a sash drag.
    return (
      <Allotment
        key={node.id}
        vertical={node.direction === 'column'}
        defaultSizes={node.sizes}
        proportionalLayout
        onChange={sizes => recordLiveSizes(node.id, sizes)}
        onDragEnd={sizes => onSizesChange(node.id, sizes)}
      >
        {node.children.map(child => (
          <Allotment.Pane key={child.id} minSize={MIN_TILE_PX}>
            {renderNode(child)}
          </Allotment.Pane>
        ))}
      </Allotment>
    );
  }, [renderTile, focusedTileId, tiled, onSizesChange, recordLiveSizes]);

  return useMemo(() => <>{renderNode(layout.root)}</>, [renderNode, layout.root]);
});

SessionTileLayout.displayName = 'SessionTileLayout';
