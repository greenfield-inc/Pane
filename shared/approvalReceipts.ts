import type { NotifyItem } from './types/notify';
import { leadingQn } from './autopilotDecision';

/**
 * The text every surface shows on an approval: where it came from and who acted on it. Pure, so
 * the desktop, the phone and the other machine word them the same way.
 */

/** A Session orchestrator's own Pane is hidden (its name is "Session: …"), so it is named by its role. */
function asker(item: NotifyItem): string {
  if (item.source.autopilot) return 'Autopilot';
  return item.originKind === 'orchestrator' || item.source.session?.orchestrator ? 'orchestrator' : item.source.name;
}

/** "workos-sso in Sales Skill · Mac mini": who asked, where, and on which other machine. */
export function originLine(item: NotifyItem, machine: string | undefined = item.machine): string {
  const connected = item.connected;
  const place = connected?.kind === 'session' ? connected.name : item.source.session?.name;
  const who = place ? `${asker(item)} in ${place}` : asker(item);
  return machine ? `${who} · ${machine}` : who;
}

/** What happened to it: "Answered by Autopilot · because D-22", "Closed: Session archived". Absent while nothing has. */
export function receiptLine(item: NotifyItem): string | undefined {
  if (item.closed) {
    const { by, reason } = item.closed;
    if (by === 'autopilot') return item.rewrittenAs ? `Closed by Autopilot: rewritten as ${item.rewrittenAs.title}` : `Closed by Autopilot: ${reason}`;
    if (by === 'you') return reason ? `Closed by you: ${reason}` : 'Closed by you';
    if (by === 'orchestrator') return `Closed by the orchestrator: ${reason}`;
    return `Closed: ${reason}`;
  }
  const receipt = item.answeredBy;
  if (receipt && (item.state === 'answered' || item.state === 'sent')) {
    if (receipt.by === 'autopilot') return receipt.because ? `Answered by Autopilot · because ${receipt.because}` : 'Answered by Autopilot';
    if (receipt.by === 'orchestrator') return 'Answered by the orchestrator';
    return item.answeredOn ? `Answered by you on ${item.answeredOn}` : 'Answered by you';
  }
  if (item.reopened && item.state === 'waiting') return item.reopened.device ? `Reopened by you on ${item.reopened.device}` : 'Reopened by you';
  if (item.rewrittenFrom) return `Rewritten by Autopilot from ${item.rewrittenFrom.qn ?? leadingQn(item.rewrittenFrom.title) ?? `"${item.rewrittenFrom.title}"`}`;
  return undefined;
}

/** "Recorded as D-147", once the orchestrator has. */
export function decisionLine(item: NotifyItem): string | undefined {
  return item.decision ? `Recorded as ${item.decision}` : undefined;
}

/** Autopilot's answers take an Override, for as long as the item is listed. */
export function canOverride(item: NotifyItem): boolean {
  return item.state === 'answered' && item.answeredBy?.by === 'autopilot';
}

/** A closed item takes a Reopen, unless Pane closed it because its asker is gone or it was replaced by a rewrite. */
export function canReopen(item: NotifyItem): boolean {
  return item.state === 'expired' && !item.rewrittenAs && (item.closed?.by === 'autopilot' || item.closed?.by === 'you');
}

/** Any waiting item takes a Close, except a mirror from an older machine and a permission prompt, which only its answer ends. */
export function canClose(item: NotifyItem): boolean {
  return item.state === 'waiting' && !item.relay && !item.agentPrompt;
}
