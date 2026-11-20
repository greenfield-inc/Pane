import { isOpenForSession } from '../../../../shared/approvalOpen';
import type { NotifyItem } from '../../../../shared/types/notify';
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

/** A Session's approvals as a move sees them: the waiting cards it carries, and those it can't carry yet. */
export interface SessionApprovals {
  carried: NotifyItem[];
  held: NotifyItem[];
}

/**
 * What can't travel yet and would be lost or stuck on the other machine: approvals the move can't
 * carry (an answer in its Undo hold, a secret, lease or permission prompt), and chat messages waiting
 * in a tab that won't send them before it stops (their full text stays in this machine's chat spool).
 * Waiting approvals move with the Session (T-44). `stopped`: asked once every tab stopped, when no queue drains any more.
 */
export function heldBackChecks(approvals: SessionApprovals, tabs: readonly HeldBackTab[], stopped: boolean): SessionMoveCheck[] {
  const checks: SessionMoveCheck[] = [];
  const held = approvals.held.length;
  if (held) {
    const titles = approvals.held.map(item => `“${item.title}”`).join(', ');
    checks.push({ id: 'approvals', level: 'block', title: `${held} approval${held === 1 ? '' : 's'} in this Session can't move yet`, detail: `${titles}: an answer still in its Undo hold, or a secret, lease or permission prompt, which stays on this machine. Wait a few seconds, or answer or dismiss ${held === 1 ? 'it' : 'them'} in Approvals, then check again.` });
  } else if (approvals.carried.length) {
    const carried = approvals.carried.length;
    checks.push({ id: 'approvals', level: 'ok', title: `${carried} open approval${carried === 1 ? '' : 's'} move${carried === 1 ? 's' : ''} with the Session`, detail: 'Answer them in Approvals on the other machine; each answer goes to its tab there.' });
  }
  for (const tab of tabs) {
    // A running chat sends its queue before its turn ends; a stopped one keeps it.
    if (!tab.queued || (tab.running && !stopped)) continue;
    const one = tab.queued === 1;
    checks.push({ id: `queue:${tab.panelId}`, level: 'block', title: `${tab.queued} message${one ? '' : 's'} waiting in ${tab.title}`, detail: `Queued messages can't move yet. Start ${tab.title} so ${one ? 'it sends' : 'they send'}, or remove ${one ? 'it' : 'them'}, then check again.` });
  }
  return checks;
}

/** Whether the move can carry this waiting card: one whose answer is typed into its tab on the other machine. */
function carriable(item: NotifyItem): boolean {
  return !item.secret && !item.lease && !item.agentPrompt && !!item.source.panelId;
}

/** How a move tells a card is its Session's, from the card's structured references. */
export interface ApprovalOwnership {
  /** Its asking tab is one of the moving Session's tabs. */
  askedHere(item: NotifyItem): boolean;
  /** It is filed under the moving Session (connected to it, or asked in it). */
  filedHere(item: NotifyItem): boolean;
}

/**
 * A Session's approvals: waiting ones it carries (asked by one of its tabs; dismissed ones too), and
 * those that hold it back: an answer still in its Undo hold, which has to reach its tab first, and an
 * open card of the Session that can't move (a secret, lease or prompt, or asked from outside its tabs).
 * A dismissed card that can't move doesn't count (T-3).
 */
export function sessionApprovals(items: readonly NotifyItem[], owner: ApprovalOwnership): SessionApprovals {
  const found: SessionApprovals = { carried: [], held: [] };
  for (const item of items) {
    if (item.state !== 'waiting' && item.state !== 'sent') continue;
    const askedHere = owner.askedHere(item);
    if (!askedHere && !owner.filedHere(item)) continue;
    if (item.state === 'sent') found.held.push(item);
    else if (askedHere && carriable(item)) found.carried.push(item);
    else if (isOpenForSession(item)) found.held.push(item);
  }
  return found;
}
