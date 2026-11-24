import type { NotifyItem } from '../../../../shared/types/notify';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { leadingQn } from '../../../../shared/autopilotDecision';

/** Where a Q-n link looks: the linking card's Session, Pane or Autopilot; `undefined` when it has none. */
export type ApprovalLinkScope = 'session' | 'pane' | 'autopilot';

/**
 * The card an approval link on `from` names. An id opens that card; a saved machine's card names
 * its own machine's ids, which this screen shows as `<machineId>:<id>`. A Q-n is only what an asker
 * wrote in a title, and every Session (on every machine) numbers its own, so it is looked up only
 * among cards from `from`'s machine and Session (or Pane, or Autopilot), waiting ones first. A card
 * asked from outside Pane has no such scope, so its Q-n finds nothing. Nothing found is `undefined`:
 * the link says so rather than open another Session's Q-n.
 */
export function resolveApprovalLink(items: readonly NotifyItem[], from: NotifyItem, ref: string): string | undefined {
  const wanted = ref.trim();
  const machine = machineOf(from);
  const id = machine === LOCAL_MACHINE_ID || wanted.startsWith(`${machine}:`) ? wanted : `${machine}:${wanted}`;
  const byId = items.find((candidate) => candidate.id === id);
  if (byId) return byId.id;
  const scope = scopeKey(from);
  if (!scope) return undefined;
  const same = items.filter((candidate) => candidate.id !== from.id && machineOf(candidate) === machine && scopeKey(candidate) === scope && leadingQn(candidate.title) === wanted);
  return (same.find((candidate) => candidate.state === 'waiting') ?? newest(same))?.id;
}

/** What kind of place a card's Q-n links are looked up in, for the link's words. */
export function approvalLinkScope(item: NotifyItem): ApprovalLinkScope | undefined {
  return scopeOf(item)?.kind;
}

function machineOf(item: NotifyItem): string {
  return item.machineId ?? LOCAL_MACHINE_ID;
}

/** The Session a card belongs to (Autopilot's about-Session card included), or the Pane or Autopilot it was asked from. */
function scopeOf(item: NotifyItem): { kind: ApprovalLinkScope; id: string } | undefined {
  const { connected, source } = item;
  if (connected && connected.kind !== 'machine') return { kind: connected.kind, id: connected.id };
  if (connected) return undefined;
  // From an older machine, with no `connected`.
  if (source.session) return { kind: 'session', id: source.session.id };
  if (source.autopilot) return { kind: 'autopilot', id: 'autopilot' };
  return source.paneId ? { kind: 'pane', id: source.paneId } : undefined;
}

function scopeKey(item: NotifyItem): string | undefined {
  const scope = scopeOf(item);
  return scope && `${scope.kind}:${scope.id}`;
}

function newest(items: readonly NotifyItem[]): NotifyItem | undefined {
  return items.reduce<NotifyItem | undefined>((best, item) => (!best || item.createdAt > best.createdAt ? item : best), undefined);
}
