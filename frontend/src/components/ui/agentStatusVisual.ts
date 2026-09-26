import type { AgentDisplayStatus } from '../../../../shared/types/agentStatus';

export interface AgentStatusVisual {
  /** Tailwind background token for the status dot. */
  colorClass: string;
  /** Short human label, e.g. for tooltips / aria. */
  label: string;
  /** Whether the dot should animate (working/blocked draw the eye). */
  animate: boolean;
}

/**
 * Single source of truth for how an {@link AgentDisplayStatus} looks: blocked is
 * red and pulses, working is the info blue (matching the label shimmer) and
 * pulses, a freshly finished agent is a blue
 * "done" cue, a seen-idle agent is calm green. `unknown` (no detected terminal status)
 * returns null so callers render no badge.
 */
export function agentStatusVisual(status: AgentDisplayStatus): AgentStatusVisual | null {
  switch (status) {
    case 'blocked':
      return { colorClass: 'bg-status-error', label: 'blocked', animate: true };
    case 'working':
      return { colorClass: 'bg-status-info', label: 'working', animate: true };
    case 'done':
      return { colorClass: 'bg-status-info', label: 'done', animate: false };
    case 'idle':
      return { colorClass: 'bg-status-success', label: 'idle', animate: false };
    case 'unknown':
      return null;
  }
}
