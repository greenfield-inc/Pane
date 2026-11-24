import type { NotifyItem } from '../../../../shared/types/notify';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { leadingQn } from '../../../../shared/autopilotDecision';

/**
 * The card an approval link on `from` names. An id is unique, so it opens that card. A Q-n is only
 * what an asker wrote in a title, and every Session (on every machine) numbers its own, so it is
 * looked up only among cards from `from`'s machine and Session (or Pane), waiting ones first.
 * Nothing found is `undefined`: the link says so rather than open another Session's Q-n.
 */
export function resolveApprovalLink(items: readonly NotifyItem[], from: NotifyItem, ref: string): string | undefined {
  const wanted = ref.trim();
  const byId = items.find((candidate) => candidate.id === wanted);
  if (byId) return byId.id;
  const scope = scopeOf(from);
  if (!scope) return undefined;
  const machine = machineOf(from);
  const same = items.filter((candidate) => candidate.id !== from.id && machineOf(candidate) === machine && scopeOf(candidate) === scope && leadingQn(candidate.title) === wanted);
  return (same.find((candidate) => candidate.state === 'waiting') ?? newest(same))?.id;
}

function machineOf(item: NotifyItem): string {
  return item.machineId ?? LOCAL_MACHINE_ID;
}

/** The Session a card belongs to, or outside one the Pane (or Autopilot, or machine) it is connected to. */
function scopeOf(item: NotifyItem): string | undefined {
  if (item.source.session) return `session:${item.source.session.id}`;
  if (item.connected) return `${item.connected.kind}:${item.connected.id}`;
  return item.source.paneId ? `pane:${item.source.paneId}` : undefined;
}

function newest(items: readonly NotifyItem[]): NotifyItem | undefined {
  return items.reduce<NotifyItem | undefined>((best, item) => (!best || item.createdAt > best.createdAt ? item : best), undefined);
}
