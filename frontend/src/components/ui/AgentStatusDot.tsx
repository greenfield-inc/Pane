import React from 'react';
import { cn } from '../../utils/cn';
import type { AgentDisplayStatus } from '../../../../shared/types/agentStatus';
import { agentStatusVisual } from './agentStatusVisual';

interface AgentStatusDotProps {
  status: AgentDisplayStatus;
  size?: 'sm' | 'md';
  className?: string;
}

const sizeClasses = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
};

const spinnerSizeClasses = {
  sm: 'w-3 h-3 border-2',
  md: 'w-3.5 h-3.5 border-2',
};

// Both variants render inside a container sized to the larger spinner, so the
// footprint stays constant and status flips cause no layout shift.
const containerSizeClasses = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
};

/**
 * At-a-glance agent status indicator. Working renders as a blue spinner; blocked
 * (red), done (blue), and idle (green) render as a dot — the "dot + spinner"
 * variation. Renders nothing until a terminal has a known status.
 */
interface AgentActivityDotProps {
  active: boolean;
  size?: 'sm' | 'md';
  /** Color of the active dot; idle is always the muted dot. */
  activeColorClass?: string;
  /** Pulse while active. */
  pulse?: boolean;
  className?: string;
  inactiveClassName?: string;
}

/**
 * Legacy binary activity dot (active/idle) for panes without an agent, rendered
 * at the same dot size and fixed footprint as AgentStatusDot so both indicator
 * systems look identical and swap without layout shift.
 */
export const AgentActivityDot: React.FC<AgentActivityDotProps> = ({
  active,
  size = 'md',
  activeColorClass = 'bg-status-info',
  pulse = false,
  className,
  inactiveClassName = 'bg-text-muted/20 opacity-40 duration-[3s]',
}) => (
  <span className={cn('inline-flex items-center justify-center', containerSizeClasses[size], className)}>
    <span
      className={cn(
        'inline-block rounded-full transition-all',
        sizeClasses[size],
        active
          ? `${activeColorClass} opacity-100 duration-150`
          : inactiveClassName,
        active && pulse && 'animate-pulse',
      )}
    />
  </span>
);

export const AgentStatusDot: React.FC<AgentStatusDotProps> = ({ status, size = 'md', className }) => {
  const visual = agentStatusVisual(status);
  if (!visual) return null;

  if (status === 'working') {
    // Amber ring spinner conveys active work more clearly than a pulsing dot.
    return (
      <span
        className={cn('inline-flex items-center justify-center', containerSizeClasses[size], className)}
        role="status"
        aria-label="Agent working"
        title="working"
      >
        <span
          className={cn(
            'inline-block rounded-full border-status-info/30 border-t-status-info animate-spin',
            spinnerSizeClasses[size],
          )}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center justify-center', containerSizeClasses[size], className)}
      role="status"
      aria-label={`Agent ${visual.label}`}
      title={visual.label}
    >
      <span
        className={cn(
          'inline-block rounded-full transition-all',
          sizeClasses[size],
          visual.colorClass,
          visual.animate && 'animate-pulse',
        )}
      />
    </span>
  );
};
