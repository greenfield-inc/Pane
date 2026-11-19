import type { ReactNode, RefObject } from 'react';
import { backToLabel } from './splitOverlay';
import { escapeApprovalColumn, useLeaveOnClose, useSplitOverlayRect } from './useSplitOverlay';

/**
 * The approval column laid over a right split (P4, D-261, D-418): shared by a Session's stage
 * and a to-do's page. It covers the split exactly, follows it as it is dragged or the window
 * resizes, and never resizes what is under it.
 */
export interface SplitApprovalOverlayProps {
  /** Whether the column lays over the split now. */
  open: boolean;
  /** The positioned element (`relative`) the overlay is drawn in; its rect is measured against this. */
  baseRef: RefObject<HTMLElement | null>;
  /** What it covers, found inside the base: a Session's right-split groups, a to-do's split. */
  targets: (base: HTMLElement) => readonly Element[];
  /** Names the targets (their ids, joined); a change re-finds and re-observes them. */
  targetsKey: string;
  /** The title of what the split shows underneath ("Plan"): ✕ reads "Back to Plan". */
  underneath?: string;
  testId: string;
  /** Esc when not typing (after an open find bar closes). Default: back to the chat (a Session). */
  onEscape?: () => void;
  /**
   * Where focus goes when the overlay closes with focus in it (see useLeaveOnClose). Unset: the
   * caller handles it (a Session does, since its column can also open as a split of its own).
   */
  onLeave?: () => void;
  /** Whether this surface owns window focus; a background tile never moves the caret. */
  focusWithin?: boolean;
  /** The column inside, given ✕'s words: an ApprovalColumn on the caller's surface. */
  children: (closeLabel: string) => ReactNode;
}

/** The approval column over a right split: placement, focus region, Esc and leave-on-close. */
export function SplitApprovalOverlay({ open, baseRef, targets, targetsKey, underneath, testId, onEscape, onLeave, focusWithin = true, children }: SplitApprovalOverlayProps) {
  const rect = useSplitOverlayRect(baseRef, targets, targetsKey, open);
  useLeaveOnClose(open, focusWithin && Boolean(onLeave), () => onLeave?.());
  if (!open || !rect) return null;
  return (
    <div className="absolute z-30 flex min-h-0 min-w-0 border-l border-border-primary bg-bg-primary" style={rect} data-testid={testId}
      data-focus-region="approvals" onKeyDown={event => escapeApprovalColumn(event, onEscape)}>
      {children(backToLabel(underneath))}
    </div>
  );
}
