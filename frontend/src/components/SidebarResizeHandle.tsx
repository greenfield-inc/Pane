import type React from 'react';

/**
 * The drag handle on the sidebar's right edge that resizes it.
 *
 * App.tsx renders it as a zero-width flex item right after the sidebar slot,
 * not inside the sidebar: the slot clips its overflow for the collapse
 * animation, so a grab area inside it could only reach inward, over the
 * sidebar list's scrollbar, which sits flush against that edge (#1595).
 * Out here the grab area covers the sidebar's hairline border and reaches
 * outward over the main area's edge, leaving the scrollbar free. The
 * highlight stays on the sidebar's last 4px, drawn but never hit-tested.
 */
export function SidebarResizeHandle({ onResize }: { onResize: (e: React.MouseEvent) => void }) {
  return (
    <div className="relative z-10 w-0 flex-shrink-0">
      <div
        data-testid="sidebar-resize-handle"
        className="group absolute inset-y-0 -left-px w-2 cursor-col-resize"
        onMouseDown={onResize}
      >
        {/* Visual indicator: the theme's border-hover tone, not the accent */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-full w-1 group-hover:bg-border-hover group-active:bg-border-hover"
        />
      </div>
    </div>
  );
}
