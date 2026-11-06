import { Navigation } from 'lucide-react';
import { cn } from '../../utils/cn';
import { openStackCount, useAutopilotStore } from '../../stores/autopilotStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { autopilotRowLabel } from './autopilotFormat';

/**
 * Autopilot's row in the sidebar's top list, below Loops and above Approvals (D-69: it is
 * not a Session row; D-117). Only while the
 * experimental switch is on.
 */
export function AutopilotNavRow() {
  const snapshot = useAutopilotStore((state) => state.snapshot);
  const active = useNavigationStore((state) => state.activeView === 'autopilot');
  const navigateToAutopilot = useNavigationStore((state) => state.navigateToAutopilot);
  if (!snapshot?.enabled) return null;
  const label = autopilotRowLabel(snapshot);
  return (
    <button
      type="button"
      data-testid="autopilot-nav"
      onClick={navigateToAutopilot}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // Same size and spacing as the rows around it (Loops above, Approvals below).
        'mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md border px-2 text-left text-[13px] transition-colors',
        active
          ? 'border-autopilot-border bg-autopilot-subtle text-text-primary'
          : 'border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <Navigation className="h-3.5 w-3.5 shrink-0 text-autopilot" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">Autopilot</span>
      <span
        data-testid="autopilot-nav-state"
        className="shrink-0 rounded-full bg-autopilot-subtle px-1.5 text-[11px] font-medium tabular-nums text-autopilot-on-tint"
      >
        {label}
      </span>
    </button>
  );
}

/** The compact rail's Autopilot button. */
export function AutopilotRailButton({ buttonClass, activeClass, idleClass }: { buttonClass: string; activeClass: string; idleClass: string }) {
  const snapshot = useAutopilotStore((state) => state.snapshot);
  const active = useNavigationStore((state) => state.activeView === 'autopilot');
  const navigateToAutopilot = useNavigationStore((state) => state.navigateToAutopilot);
  if (!snapshot?.enabled) return null;
  const open = openStackCount(snapshot);
  return (
    <button
      type="button"
      data-testid="compact-autopilot"
      data-compact-rail-item
      onClick={navigateToAutopilot}
      aria-label={`Autopilot, ${autopilotRowLabel(snapshot)}`}
      title="Autopilot"
      className={cn(buttonClass, active ? activeClass : idleClass)}
    >
      <Navigation className="h-4 w-4 text-autopilot" />
      {/* The dot keeps its box while hidden, so nothing shifts. */}
      <span className="absolute right-0 top-0 flex h-3 w-3 items-center justify-center" aria-hidden="true">
        <span className={cn('h-1.5 w-1.5 rounded-full bg-autopilot', (snapshot.state === 'stopped' || open === 0) && 'invisible')} />
      </span>
    </button>
  );
}
