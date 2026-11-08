import type { NotifyItem } from '../../../../shared/types/notify';
import type { AutopilotSnapshot, AutopilotStack } from '../../../../shared/types/autopilot';
import type { MachineState } from '../../../../shared/types/machineConnections';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { isMachineDimmed } from '../../stores/allMachinesStore';
import { openStackCount } from '../../stores/autopilotStore';
import { countsAsWaiting } from '../../stores/notifyStore';
import type { MachineEntry } from '../../utils/machineList';
import { offlineRows, type OfflineRow } from '../approvals/approvalGroups';
import type { MachineName } from '../notify/notifyFormat';

/** What an item asks: the label on its row and its stack tab. */
export function itemKind(item: NotifyItem): 'Approval' | 'Question' | 'Permission' | 'Autopilot' {
  if (item.source.autopilot) return 'Autopilot';
  if (item.agentPrompt) return 'Permission';
  return item.ui === 'approve' ? 'Approval' : 'Question';
}

type ItemRowState = 'shown' | 'on-stack' | 'waiting' | 'held' | 'answered' | 'expired' | 'gone';

interface ItemRow {
  id: string;
  state: ItemRowState;
  item?: NotifyItem;
}

export interface ItemRowGroup {
  key: string;
  label: string;
  autopilot?: boolean;
  machine?: string;
  rows: ItemRow[];
}

function rowState(item: NotifyItem | undefined, stack: AutopilotStack): ItemRowState {
  if (!item) return 'gone';
  if (item.state === 'answered') return 'answered';
  if (item.state === 'expired') return 'expired';
  const entry = stack.entries.find(candidate => candidate.ref.kind === 'item' && candidate.ref.notifyId === item.id && candidate.doneAt === undefined);
  // The current card stays current through its Undo hold, so its receipt and Undo stay in view.
  if (entry && entry.id === stack.shownId) return 'shown';
  if (item.state === 'sent') return 'held';
  return entry ? 'on-stack' : 'waiting';
}

/**
 * The rows an `autopilot-items` block renders (d1): grouped by Session in the order the block
 * first names each, every item with its live state. Items Pane no longer holds go under "Earlier".
 */
export function groupItemRows(ids: string[], items: readonly NotifyItem[], stack: AutopilotStack): ItemRowGroup[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const groups = new Map<string, ItemRowGroup>();
  for (const id of ids) {
    const item = byId.get(id);
    // An offline machine's open items are one row, from `offlineItemRows`.
    if (item && offlineRows([item]).length > 0) continue;
    const session = item?.source.session;
    const key = !item ? 'gone' : item.source.autopilot ? 'autopilot' : session ? `${item.machineId ?? 'local'}:${session.id}` : 'none';
    let group = groups.get(key);
    if (!group) {
      const label = !item ? 'Earlier' : item.source.autopilot ? 'Autopilot' : session?.name ?? 'Not in a Session';
      group = { key, label, rows: [] };
      if (item?.source.autopilot) group.autopilot = true;
      if (item?.machine) group.machine = item.machine;
      groups.set(key, group);
    }
    group.rows.push({ id, state: rowState(item, stack), item });
  }
  const ordered = [...groups.values()];
  // Items Pane no longer holds sort last, whatever order the block named them in.
  return [...ordered.filter(group => group.key !== 'gone'), ...ordered.filter(group => group.key === 'gone')];
}

/** The one row per machine that stands in for the block's items that can't be reached. */
export function offlineItemRows(ids: string[], items: readonly NotifyItem[]): OfflineRow[] {
  const named = new Set(ids);
  return offlineRows(items.filter(item => named.has(item.id)));
}

/**
 * The person's machines on Tailscale that aren't saved here, so Autopilot can't see them (D-165).
 * One switched off for now says nothing: it holds nothing to miss until it's back.
 */
export function cantSeeMachines(machines: readonly MachineEntry[]): MachineEntry[] {
  return machines.filter(machine => machine.tailnet?.mine && !machine.profile && machine.tailnet.state !== 'offline');
}

/** Saved machines that stopped answering, past the grace a blip gets, by the name the picker gives them. */
export function offlineSavedMachines(states: readonly MachineState[], names: readonly MachineName[], now = Date.now()): MachineName[] {
  return states
    .filter(state => state.id !== LOCAL_MACHINE_ID && isMachineDimmed(state, now))
    .map(state => ({ id: state.id, name: names.find(entry => entry.id === state.id)?.name ?? state.label }));
}

/** Items the person could answer that Autopilot hasn't brought in: not on its stack, not in its chat (J34). */
export function notBroughtInCount(items: readonly NotifyItem[], stack: AutopilotStack, rendered: Readonly<Record<string, number>>): number {
  const onStack = new Set(stack.entries.flatMap(entry => entry.ref.kind === 'item' ? [entry.ref.notifyId] : []));
  return items.filter(item => countsAsWaiting(item) && !onStack.has(item.id) && !rendered[item.id]).length;
}

export function stackPositionLabel(stack: AutopilotStack): string {
  if (stack.entries.length === 0) return 'Empty';
  const index = stack.entries.findIndex(entry => entry.id === stack.shownId);
  return `${Math.max(0, index) + 1} of ${stack.entries.length}`;
}

/** The row's state: "Start" before Start, "Sentinel" while it keeps Sessions moving, "Paused", or how many stack entries are open ("Running" while none are). */
export function autopilotRowLabel(snapshot: AutopilotSnapshot): string {
  if (snapshot.state === 'stopped') return 'Start';
  if (snapshot.sentinel) return 'Sentinel';
  if (snapshot.state === 'paused') return 'Paused';
  const open = openStackCount(snapshot);
  // Nothing open reads as running, like the header, not as a count of zero.
  return open ? `${open} open` : 'Running';
}
