import type { AllMachinesList } from '@/features/allMachines/allMachinesList';
import { sessionKey } from '@/features/approvals/approvals';

import { terminalWaiting } from './statusBoard';

/** One thing Needs you counts: a question, a permission request, or a Pane waiting in its terminal. */
export interface WaitingThing {
  /** The row's key, unique across machines. */
  key: string;
  machineKey: string;
  /** The Pane that asks, when one does. */
  paneId?: string;
  /** The Session it counts toward on Home, when one: its own, or its Pane's. */
  sessionId?: string;
}

/**
 * What the phone has seen, by thing key. `goneAt` marks a thing its machine stopped listing; it is
 * forgotten after `GONE_GRACE_MS`, so it is new again if it comes back later, while a Pane whose
 * status flickers between blocked and working stays seen.
 */
export type SeenMap = Readonly<Record<string, { machine: string; goneAt?: number }>>;

export const GONE_GRACE_MS = 2 * 60_000;

/** A screen that shows waiting things: Needs you shows all of them; a Pane, Session or approval shows its own. */
export type SeenTarget = 'needs' | { machineKey: string; key?: string; paneId?: string; sessionId?: string };

/** Everything Needs you counts, as `boardCounts` does: waiting approvals, then Panes waiting in their terminal. */
export function waitingThings(list: Pick<AllMachinesList, 'waiting' | 'recent'>, held: AllMachinesList['waiting'] = []): WaitingThing[] {
  const sessionOf = new Map(list.recent.flatMap(row => (row.type === 'pane' && row.pane.session ? [[`${row.machineKey}:${row.pane.id}`, row.pane.session.id] as const] : [])));
  const thing = (key: string, machineKey: string, paneId: string | undefined, sessionId: string | undefined): WaitingThing => {
    const session = sessionId ?? (paneId ? sessionOf.get(`${machineKey}:${paneId}`) : undefined);
    return { key, machineKey, ...(paneId ? { paneId } : {}), ...(session ? { sessionId: session } : {}) };
  };
  return [
    ...list.waiting.filter(row => row.waiting).map(row => thing(row.key, row.machineKey, row.type === 'question' ? row.item.source.paneId : row.request.sessionId, row.session?.id)),
    ...terminalWaiting(list, held).map(row => thing(row.key, row.machineKey, row.pane.id, row.pane.session?.id)),
  ];
}

/**
 * The next seen map: things an open screen shows become seen (`marked` lists them), and things
 * that left a machine whose lists are complete are forgotten after the grace. With nothing saved
 * yet (`null`), everything waiting when a machine first answers counts as seen, so a first launch
 * doesn't call every old item new.
 */
export function reconcileSeen({ seen, things, complete, open, now }: {
  seen: SeenMap | null;
  things: readonly WaitingThing[];
  /** Machines whose waiting things are all in `things`. Things of other machines keep their seen mark. */
  complete: ReadonlySet<string>;
  open: readonly SeenTarget[];
  now: number;
}): { seen: SeenMap | null; marked: string[] } {
  if (seen === null) {
    if (complete.size === 0) return { seen: null, marked: [] };
    return { seen: Object.fromEntries(things.map(thing => [thing.key, { machine: thing.machineKey }])), marked: [] };
  }
  const present = new Set(things.map(thing => thing.key));
  const next: Record<string, { machine: string; goneAt?: number }> = {};
  for (const [key, entry] of Object.entries(seen)) {
    if (present.has(key)) next[key] = { machine: entry.machine };
    else if (!complete.has(entry.machine)) next[key] = entry;
    else if (now - (entry.goneAt ?? now) < GONE_GRACE_MS) next[key] = { machine: entry.machine, goneAt: entry.goneAt ?? now };
  }
  const marked: string[] = [];
  for (const thing of things) {
    if (next[thing.key] || !open.some(target => shows(target, thing))) continue;
    next[thing.key] = { machine: thing.machineKey };
    marked.push(thing.key);
  }
  return { seen: next, marked };
}

function shows(target: SeenTarget, thing: WaitingThing): boolean {
  if (target === 'needs') return true;
  if (target.machineKey !== thing.machineKey) return false;
  return (target.key !== undefined && target.key === thing.key)
    || (target.paneId !== undefined && target.paneId === thing.paneId)
    || (target.sessionId !== undefined && target.sessionId === thing.sessionId);
}

export interface FreshCounts {
  /** New on the Needs you tile. */
  total: number;
  /** New in each Session row, by `sessionKey`. */
  bySession: ReadonlyMap<string, number>;
  /** New in each Pane row, by `machineKey:paneId`. */
  byPane: ReadonlyMap<string, number>;
}

/** The "+N" counts: waiting things the phone hasn't seen. None until the seen map has loaded. */
export function freshCounts(things: readonly WaitingThing[], seen: SeenMap | null | undefined): FreshCounts {
  const bySession = new Map<string, number>();
  const byPane = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  let total = 0;
  if (seen) {
    for (const thing of things) {
      if (seen[thing.key]) continue;
      total += 1;
      if (thing.sessionId) add(bySession, sessionKey(thing.machineKey, thing.sessionId));
      if (thing.paneId) add(byPane, `${thing.machineKey}:${thing.paneId}`);
    }
  }
  return { total, bySession, byPane };
}
