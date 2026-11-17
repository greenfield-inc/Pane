import React from 'react';

interface PanelLoadingFallbackProps {
  panelType?: string;
  message?: string;
}

/**
 * Skeleton loading fallback for lazy-loaded panels
 */
export const PanelLoadingFallback: React.FC<PanelLoadingFallbackProps> = React.memo(({
  panelType = 'panel',
}) => (
  <div className="h-full bg-bg-primary animate-skeleton">
    {/* Header skeleton */}
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-primary bg-surface-secondary">
      <div className="h-3 w-28 bg-surface-tertiary rounded" />
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
        <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
      </div>
    </div>
    {/* Content skeleton - varies slightly by panel type */}
    {panelType === 'diff' ? (
      <div className="flex h-full">
        <div className="w-52 border-r border-border-primary bg-surface-secondary p-2 space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-10 bg-surface-tertiary rounded" />
          ))}
        </div>
        <div className="flex-1 p-4 space-y-3">
          <div className="h-4 w-48 bg-surface-tertiary rounded" />
          <div className="h-3 w-full bg-surface-tertiary rounded" />
          <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
          <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
        </div>
      </div>
    ) : (
      <div className="p-4 space-y-3">
        <div className="h-4 w-40 bg-surface-tertiary rounded" />
        <div className="h-3 w-full bg-surface-tertiary rounded" />
        <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
        <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
        <div className="h-3 w-2/3 bg-surface-tertiary rounded" />
      </div>
    )}
  </div>
));

PanelLoadingFallback.displayName = 'PanelLoadingFallback';