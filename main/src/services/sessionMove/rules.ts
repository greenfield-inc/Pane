import type { SessionMoveCheck } from '../../../../shared/types/sessionMove';
import type { PathMap } from './pathMap';

/** The Agent Farm profile a launch command runs (`agent-farm run greenfield/implementer:opus …`), without its variant. */
export function agentFarmProfileOf(command: string | undefined): string | null {
  const match = /(?:^|\s)agent-farm\s+run\s+([^\s:]+)/.exec(command ?? '');
  return match ? match[1] : null;
}

/** The one line the orchestrator and each working tab receive on arrival (Q-373.4). */
export function movedLine(from: string, here: string, map: PathMap): string {
  const paths = map.entries.slice(0, 6).map(entry => `${entry.from} → ${entry.to}`).join('; ');
  return `[Pane] This Session just moved from ${from} to ${here}. Paths changed: ${paths} (the full map is in moved.json in the Session folder). Servers, watches and background commands stopped on ${from}: restart the ones you need here, re-arm your runpane watch, and reconcile workers from their status files.`;
}

/** A tab as the held-back checks see it: its chat queue length, and whether it is running. */
export interface HeldBackTab {
  panelId: string;
  title: string;
  running: boolean;
  queued: number;
}

/**
 * What can't travel yet and would be lost or stuck on the other machine: open approvals (the
 * target's Notify wouldn't show them until Pane restarts there) and chat messages waiting in a tab
 * that won't send them before it stops (their full text stays in this machine's chat spool).
 * `stopped`: asked once every tab stopped, when no queue drains any more.
 */
export function heldBackChecks(approvals: number, tabs: readonly HeldBackTab[], stopped: boolean): SessionMoveCheck[] {
  const checks: SessionMoveCheck[] = [];
  if (approvals) {
    checks.push({ id: 'approvals', level: 'block', title: `${approvals} open approval${approvals === 1 ? '' : 's'} in this Session`, detail: `Approvals can't move yet. Answer or dismiss ${approvals === 1 ? 'it' : 'them'} in Notify, then check again.` });
  }
  for (const tab of tabs) {
    // A running chat sends its queue before its turn ends; a stopped one keeps it.
    if (!tab.queued || (tab.running && !stopped)) continue;
    const one = tab.queued === 1;
    checks.push({ id: `queue:${tab.panelId}`, level: 'block', title: `${tab.queued} message${one ? '' : 's'} waiting in ${tab.title}`, detail: `Queued messages can't move yet. Start ${tab.title} so ${one ? 'it sends' : 'they send'}, or remove ${one ? 'it' : 'them'}, then check again.` });
  }
  return checks;
}
