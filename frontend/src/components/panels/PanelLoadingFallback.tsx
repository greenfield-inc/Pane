import React from 'react';
import { LoadingStatus } from '../ui/Skeleton';

/**
 * What a lazily loaded panel shows while its code loads, the first time that
 * panel type opens: the panel's own background, with no stand-in shapes. The
 * load is short, and a skeleton that does not match the panel would only
 * flash. Terminals draw TerminalSkeleton instead (PanelContainer).
 */
export const PanelLoadingFallback: React.FC<{ panelType?: string }> = React.memo(({ panelType = 'panel' }) => (
  <div className="h-full bg-bg-primary">
    <LoadingStatus label={`Opening the ${panelType} tab`} />
  </div>
));

PanelLoadingFallback.displayName = 'PanelLoadingFallback';
