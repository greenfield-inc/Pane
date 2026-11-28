import { isOpenForSession } from '../../../../shared/approvalOpen';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { SessionMoveCheck } from '../../../../shared/types/sessionMove';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { readTabFields } from './manifest';
import { snapshotArguments, type PathMap } from './pathMap';
import path from 'path';

/**
 * The Agent Farm profile a launch command runs (`agent-farm run greenfield/planner:codex …`), without
 * its variant. With `links` (Profiles on, T-83 P3) it also reads a launch link's command as Agent Farm
 * prints it, with the shim's path (`/Users/me/.pane/bin/agent-farm run greenfield/planner
 * --config-root … --parent …`). Only the trust check passes `links`: a linked agent isn't a top-level
 * profile the other machine lists, so it can't be a profile the move requires there (review F-3).
 */
export function agentFarmProfileOf(command: string | undefined, links = false): string | null {
  const match = links
    ? /(?:^|[\s/\\'"])agent-farm(?:\.cmd)?['"]?\s+run\s+([^\s:'"]+)/i.exec(command ?? '')
    : /(?:^|\s)agent-farm\s+run\s+([^\s:]+)/.exec(command ?? '');
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

/** The profile checks a move's target shows, and the profiles it lists as ready there. */
export interface ProfileCheckResult { checks: SessionMoveCheck[]; installed: string[] }

/**
 * The target's checks for the Agent Farm profiles a Session's tabs launch (`wanted`, with the
 * source's versions), against the profiles installed there (`here`). A profile the Session's
 * snapshot holds (`held`) runs from that snapshot, which travels with the Session, so it needs
 * nothing installed (T-110, D-3); `snapshots` is false where Pane doesn't use them (Profiles off).
 */
export function profileChecks(wanted: Record<string, string | null>, here: Record<string, string>, held: readonly string[], at: { machine: string; source: string; snapshots: boolean }): ProfileCheckResult {
  const checks: SessionMoveCheck[] = [];
  const installed: string[] = [];
  for (const [profile, version] of Object.entries(wanted)) {
    if (at.snapshots && held.includes(profile)) {
      installed.push(`Agent Farm ${profile}${version ? ` ${version}` : ''}, from the Session's snapshot`);
    } else if (!here[profile]) {
      checks.push({ id: `profile:${profile}`, level: 'block', title: `Agent Farm profile ${profile} isn't on ${at.machine}`, detail: `Tabs launched with it can't resume there. Install its plugin with agent-farm plugin install on ${at.machine}, then check again.` });
    } else if (version && here[profile] !== version) {
      checks.push({ id: `profile:${profile}`, level: 'warning', title: `${profile} is ${here[profile]} there, ${version} here`, detail: `Tabs resume with ${here[profile]}. Update Agent Farm on ${at.machine} to match.` });
    } else {
      installed.push(`Agent Farm ${profile}${version ? ` ${version}` : ''}`);
    }
  }
  return { checks, installed };
}

/**
 * The snapshot folder an Agent Farm tab resolves from (T-110): its command's `--snapshot`, else the
 * one it was pinned when it opened, else its Session's. Only one inside the Session folder travels
 * with a move, so any other gives undefined.
 */
export function tabSnapshotFolder(command: string | undefined, state: { agentFarmSnapshot?: string }, sessionFolder: string, recordSnapshot: string | undefined): string | undefined {
  return insideSessionSnapshots(snapshotArguments(command ?? '')[0]?.folder, state, sessionFolder, recordSnapshot);
}

/** The explicit snapshot, else the tab's pinned one, else the Session's, when it is inside the Session folder's snapshots. */
function insideSessionSnapshots(explicit: string | undefined, state: { agentFarmSnapshot?: string }, sessionFolder: string, recordSnapshot: string | undefined): string | undefined {
  const chosen = explicit !== undefined ? explicit : state.agentFarmSnapshot ?? (recordSnapshot ? path.join(sessionFolder, ...recordSnapshot.split('/')) : undefined);
  if (!chosen) return undefined;
  const resolved = path.resolve(sessionFolder, chosen);
  const relative = path.relative(sessionFolder, resolved);
  return relative.startsWith(`.agent-farm${path.sep}snapshots${path.sep}`) && !relative.startsWith('..') ? resolved : undefined;
}

const chatProfileLaunch = boundary.object({ kind: boundary.literal('profile'), profile: boundary.nonEmptyString, snapshot: boundary.optional(boundary.nonEmptyString) });

/**
 * The Agent Farm profile a saved tab launches and the snapshot folder it resolves from (undefined
 * when that folder doesn't travel with the Session folder), or null for a tab that isn't Agent
 * Farm's. A terminal keeps its launch as a command; a profile chat as `launch` (#1762 F-8), whose
 * own `snapshot` wins as `--snapshot` does on a command. `chats: false` reads terminals only, as before.
 */
export function tabAgentFarmLaunch(state: JsonObject, sessionFolder: string, recordSnapshot: string | undefined, { chats = true }: { chats?: boolean } = {}): { profile: string; folder: string | undefined } | null {
  const pinned = { agentFarmSnapshot: decodeOptionalBoundary(state.agentFarmSnapshot, boundary.string) };
  const chat = chats ? decodeOptionalBoundary(state.launch, chatProfileLaunch) : undefined;
  if (chat) return { profile: chat.profile, folder: insideSessionSnapshots(chat.snapshot, pinned, sessionFolder, recordSnapshot) };
  const { launch } = readTabFields(state);
  const profile = agentFarmProfileOf(launch);
  return profile ? { profile, folder: tabSnapshotFolder(launch, pinned, sessionFolder, recordSnapshot) } : null;
}
