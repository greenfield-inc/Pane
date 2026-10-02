/**
 * DropOverlay: the five-zone drop target drawn over a layout leaf during a drag.
 *
 * Shared by both layout trees so the gesture reads the same at either level:
 * dropping a tab onto a panel group, and dropping a Session onto a tile. 25%
 * edge bands split; the center merges (a tab joins the group, a Session takes
 * the slot).
 */

import React, { useCallback } from 'react';
import { dropZoneFor, type DropZone } from '../../utils/layoutTree';

const ZONE_CLASSES = {
  center: 'absolute inset-4 rounded',
  left: 'absolute inset-y-0 left-0 w-1/4',
  right: 'absolute inset-y-0 right-0 w-1/4',
  top: 'absolute inset-x-0 top-0 h-1/4',
  bottom: 'absolute inset-x-0 bottom-0 h-1/4',
} satisfies Record<DropZone, string>;

const HIGHLIGHT = 'border-2 border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-interactive-primary)_10%,transparent)] pointer-events-none';

export interface DropOverlayProps {
  onZoneChange: (zone: DropZone | null) => void;
  /** The event comes along so a handler can read the drag's payload. */
  onDrop: (zone: DropZone, event: React.DragEvent) => void;
  activeZone: DropZone | null;
  /** Zones this target refuses; hovering one reads as no zone at all. */
  disabledZones?: readonly DropZone[];
}

export const DropOverlay: React.FC<DropOverlayProps> = React.memo(({
  onZoneChange,
  onDrop,
  activeZone,
  disabledZones,
}) => {
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = dropZoneFor(e.clientX, e.clientY, rect);
    onZoneChange(disabledZones?.includes(zone) ? null : zone);
  }, [onZoneChange, disabledZones]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (activeZone) {
      onDrop(activeZone, e);
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
      {activeZone && <div className={`${ZONE_CLASSES[activeZone]} ${HIGHLIGHT}`} />}
    </div>
  );
});

DropOverlay.displayName = 'DropOverlay';
