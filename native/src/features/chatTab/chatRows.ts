import { responseText } from '@shared/chatTabMarkdown';
import { messageTime, stoppedText, turnDisplay, turnFooter, turnSummary, workerNotes, type ChatTurn, type ChatWorkerLine, type WorkerNote, type PlanEntry, type StepGroup, type TurnItem } from '@shared/chatTabPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

/** One row of the phone's chat list. Rows are flat so Legend List can recycle and window them. */
export type ChatRow =
  | { key: string; kind: 'user'; message: AgentChatMessage; at?: string }
  | { key: string; kind: 'text' | 'thought'; text: string; at?: string }
  | { key: string; kind: 'image'; mimeType: string; data: string }
  | { key: string; kind: 'steps'; group: StepGroup }
  | { key: string; kind: 'fold'; turnId: string; summary: string; open: boolean; running: boolean; expandable: boolean }
  | { key: string; kind: 'plan'; entries: PlanEntry[] }
  | { key: string; kind: 'content'; content: JsonValue }
  | { key: string; kind: 'stopped'; text: string }
  | { key: string; kind: 'worker'; note: WorkerNote }
  /** Copies a finished response's text as Markdown (D-140, D-182). */
  | { key: string; kind: 'copy'; text: string }
  /** When the latest turn finished, with no activity row to say it (D-202). */
  | { key: string; kind: 'time'; short: string; full: string };

/**
 * The conversation as rows (D-192): the agent's text, with each turn's activity
 * folded into one row that `open` expands. While a turn runs the row says what it's
 * doing now. A Session's workers appear only when the latest turn has news of them
 * (D-201): one line each for a worker that finished, reported or is asking.
 */
export function chatRows(turns: readonly ChatTurn[], options: { open: ReadonlySet<string>; workers?: readonly ChatWorkerLine[]; now?: Date }): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const turn of turns) {
    const latest = turn === turns.at(-1);
    // D-202: a long press shows a message's full time.
    if (turn.user) rows.push({ key: `${turn.id}:user`, kind: 'user', message: turn.user, at: messageTime(turn.startedAt, options.now)?.full });
    const ended = messageTime(turn.endedAt, options.now);
    const { shown, activity, foldAt } = turnDisplay(turn);
    const pushItem = (item: TurnItem) => {
      if (item.type === 'text') rows.push({ key: item.id, kind: 'text', text: item.text, at: ended?.full });
      else if (item.type === 'image') rows.push({ key: item.id, kind: 'image', mimeType: item.mimeType, data: item.data });
    };
    const before = foldAt < 0 ? shown.length : Math.min(foldAt, shown.length);
    shown.slice(0, before).forEach(pushItem);
    if (turn.running || activity.length) {
      const open = options.open.has(turn.id);
      rows.push({ key: `${turn.id}:fold`, kind: 'fold', turnId: turn.id, summary: latest ? turnFooter(turn, activity.length > 0, options.now) ?? turnSummary(turn) : turnSummary(turn), open, running: turn.running, expandable: activity.length > 0 });
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
    if (latest && !turn.running && !activity.length && ended) rows.push({ key: `${turn.id}:time`, kind: 'time', short: ended.short, full: ended.full });
    const stopped = stoppedText(turn);
    if (stopped) rows.push({ key: `${turn.id}:stopped`, kind: 'stopped', text: stopped });
  }
  for (const note of workerNotes(turns, options.workers ?? [])) rows.push({ key: `worker:${note.worker.paneId}`, kind: 'worker', note });
  return rows;
}
