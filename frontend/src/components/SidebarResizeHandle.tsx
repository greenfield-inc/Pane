import type React from 'react';

/** The drag handle on the sidebar's right edge that resizes it. */
export function SidebarResizeHandle({ onResize }: { onResize: (e: React.MouseEvent) => void }) {
  return (
    <div
      data-testid="sidebar-resize-handle"
      className="absolute top-0 right-0 w-1 h-full cursor-col-resize group z-10"
      onMouseDown={onResize}
    >
      {/* Visual indicator: the theme's border-hover tone, not the accent */}
      <div className="absolute inset-0 group-hover:bg-border-hover group-active:bg-border-hover" />
      {/* Larger grab area */}
      <div className="absolute -left-2 -right-2 top-0 bottom-0" />
    </div>
  );
}
