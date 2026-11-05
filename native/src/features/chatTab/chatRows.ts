import { responseText } from '@shared/chatTabMarkdown';
import { foldWorkers, stoppedText, turnDisplay, turnSummary, workersLabel, type ChatTurn, type ChatWorkerLine, type PlanEntry, type StepGroup, type TurnItem } from '@shared/chatTabPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

/** One row of the phone's chat list. Rows are flat so Legend List can recycle and window them. */
export type ChatRow =
  | { key: string; kind: 'user'; message: AgentChatMessage }
  | { key: string; kind: 'text' | 'thought'; text: string }
  | { key: string; kind: 'image'; mimeType: string; data: string }
  | { key: string; kind: 'steps'; group: StepGroup }
  | { key: string; kind: 'fold'; turnId: string; summary: string; open: boolean; running: boolean; expandable: boolean }
  | { key: string; kind: 'plan'; entries: PlanEntry[] }
  | { key: string; kind: 'content'; content: JsonValue }
  | { key: string; kind: 'stopped'; text: string }
  | { key: string; kind: 'worker'; worker: ChatWorkerLine }
  /** Copies a finished response's text as Markdown (D-140, D-182). */
  | { key: string; kind: 'copy'; text: string };

/** The `open` entry of the row that holds the Session's other workers. */
export const WORKERS_FOLD = 'workers';

/**
 * The conversation as rows (D-192): the agent's text, with each turn's activity
 * folded into one row that `open` expands. While a turn runs the row says what it's
 * doing now. Workers follow the conversation: the ones running, blocked or changed
 * in the latest turn each get a line, and the rest one row.
 */
export function chatRows(turns: readonly ChatTurn[], options: { open: ReadonlySet<string>; workers?: readonly ChatWorkerLine[] }): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const turn of turns) {
    if (turn.user) rows.push({ key: `${turn.id}:user`, kind: 'user', message: turn.user });
    const { shown, activity, foldAt } = turnDisplay(turn);
    const pushItem = (item: TurnItem) => {
      if (item.type === 'text') rows.push({ key: item.id, kind: 'text', text: item.text });
      else if (item.type === 'image') rows.push({ key: item.id, kind: 'image', mimeType: item.mimeType, data: item.data });
    };
    const before = foldAt < 0 ? shown.length : Math.min(foldAt, shown.length);
    shown.slice(0, before).forEach(pushItem);
    if (turn.running || activity.length) {
      const open = options.open.has(turn.id);
      rows.push({ key: `${turn.id}:fold`, kind: 'fold', turnId: turn.id, summary: turnSummary(turn), open, running: turn.running, expandable: activity.length > 0 });
      if (open) for (const item of activity) {
        if (item.type === 'steps') for (const group of item.groups) rows.push({ key: `${item.id}:${group.id}`, kind: 'steps', group });
        else if (item.type === 'thought') rows.push({ key: item.id, kind: 'thought', text: item.text });
        else if (item.type === 'plan') rows.push({ key: item.id, kind: 'plan', entries: item.entries });
        else if (item.type === 'content') rows.push({ key: item.id, kind: 'content', content: item.content });
      }
    }
    shown.slice(before).forEach(pushItem);
    const response = turn.running ? '' : responseText(turn);
    if (response) rows.push({ key: `${turn.id}:copy`, kind: 'copy', text: response });
    const stopped = stoppedText(turn);
    if (stopped) rows.push({ key: `${turn.id}:stopped`, kind: 'stopped', text: stopped });
  }
  const workers = foldWorkers(turns, options.workers ?? []);
  for (const worker of workers.shown) rows.push({ key: `worker:${worker.paneId}`, kind: 'worker', worker });
  if (workers.rest.length) {
    const open = options.open.has(WORKERS_FOLD);
    rows.push({ key: 'workers:fold', kind: 'fold', turnId: WORKERS_FOLD, summary: workersLabel(workers.rest.length), open, running: false, expandable: true });
    if (open) for (const worker of workers.rest) rows.push({ key: `worker:${worker.paneId}`, kind: 'worker', worker });
  }
  return rows;
}
