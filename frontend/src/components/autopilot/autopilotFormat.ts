import type { NotifyItem } from '../../../../shared/types/notify';
import type { AutopilotSnapshot, AutopilotStack } from '../../../../shared/types/autopilot';
import { openStackCount } from '../../stores/autopilotStore';

/** What an item asks: the label on its row and its stack tab. */
export function itemKind(item: NotifyItem): 'Approval' | 'Question' | 'Permission' | 'Autopilot' | 'Stuck' {
  if (item.source.autopilot) return 'Autopilot';
  if (item.relay) return 'Stuck';
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

export function stackPositionLabel(stack: AutopilotStack): string {
  if (stack.entries.length === 0) return 'Empty';
  const index = stack.entries.findIndex(entry => entry.id === stack.shownId);
  return `${Math.max(0, index) + 1} of ${stack.entries.length}`;
}

/** The row's state: "start" before Start, "Sentinel" while it keeps Sessions moving, "paused", or how many stack entries are open. */
export function autopilotRowLabel(snapshot: AutopilotSnapshot): string {
  if (snapshot.state === 'stopped') return 'start';
  if (snapshot.sentinel) return 'Sentinel';
  if (snapshot.state === 'paused') return 'paused';
  return `${openStackCount(snapshot)} open`;
}
