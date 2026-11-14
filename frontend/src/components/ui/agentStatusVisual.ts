import type { AgentDisplayStatus } from '../../../../shared/types/agentStatus';

export interface AgentStatusVisual {
  /** Tailwind background token for the status dot. */
  colorClass: string;
  /** Short human label, e.g. for tooltips / aria. */
  label: string;
  /**
   * The status wants the person: the dot pulses a few times when it appears
   * (`animate-attention-pulse`), then holds with a ring, so it reads apart from
   * the other dots without relying on colour.
   */
  attention: boolean;
}

/**
 * Single source of truth for how an {@link AgentDisplayStatus} looks: blocked is
 * red and wants attention, working is the info blue (matching the label
 * shimmer), a freshly finished agent is a blue
 * "done" cue, a seen-idle agent is calm green. `unknown` (no agent / plain shell)
 * returns null so callers render no badge.
 */
export function agentStatusVisual(status: AgentDisplayStatus): AgentStatusVisual | null {
  switch (status) {
    case 'blocked':
      return { colorClass: 'bg-status-error', label: 'blocked', attention: true };
    case 'working':
      return { colorClass: 'bg-status-info', label: 'working', attention: false };
    case 'done':
      return { colorClass: 'bg-status-info', label: 'done', attention: false };
    case 'idle':
      return { colorClass: 'bg-status-success', label: 'idle', attention: false };
    case 'unknown':
      return null;
  }
}
