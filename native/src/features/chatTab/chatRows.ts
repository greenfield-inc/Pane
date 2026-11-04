import { responseMarkdown } from '@shared/chatTabMarkdown';
import { placeWorkers, stoppedText, turnSummary, type ChatStep, type ChatTurn, type ChatWorkerLine, type PlanEntry, type StepGroup } from '@shared/chatTabPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

/** One row of the phone's chat list. Rows are flat so Legend List can recycle and window them. */
export type ChatRow =
  | { key: string; kind: 'user'; message: AgentChatMessage }
  | { key: string; kind: 'text' | 'thought'; text: string }
  | { key: string; kind: 'image'; mimeType: string; data: string }
  | { key: string; kind: 'steps'; group: StepGroup }
  | { key: string; kind: 'fold'; turnId: string; summary: string; open: boolean }
  | { key: string; kind: 'current'; step: ChatStep }
  | { key: string; kind: 'plan'; entries: PlanEntry[] }
  | { key: string; kind: 'content'; content: JsonValue }
  | { key: string; kind: 'stopped'; text: string }
  | { key: string; kind: 'worker'; worker: ChatWorkerLine }
  /** Copies a finished response as Markdown (D-140). */
  | { key: string; kind: 'copy'; text: string };

/**
 * The conversation as rows. A quiet chat (the Session orchestrator, D-18) shows only
 * the current step of a running turn and folds a finished turn's steps into one line
 * that `open` turns expand. Worker lines follow the turn that started them.
 */
export function chatRows(turns: readonly ChatTurn[], options: { quiet: boolean; open: ReadonlySet<string>; workers?: readonly ChatWorkerLine[] }): ChatRow[] {
  const rows: ChatRow[] = [];
  const placed = placeWorkers(turns, options.workers ?? []);
  for (const turn of turns) {
    if (turn.user) rows.push({ key: `${turn.id}:user`, kind: 'user', message: turn.user });
    let folded = false;
    for (const item of turn.items) {
      if (item.type === 'steps') {
        if (options.quiet && turn.running) {
          if (!folded && turn.current) rows.push({ key: `${turn.id}:current`, kind: 'current', step: turn.current });
          folded = true;
          continue;
        }
        if (options.quiet) {
          const open = options.open.has(turn.id);
          if (!folded) rows.push({ key: `${turn.id}:fold`, kind: 'fold', turnId: turn.id, summary: turnSummary(turn), open });
          folded = true;
          if (!open) continue;
        }
        for (const group of item.groups) rows.push({ key: `${item.id}:${group.id}`, kind: 'steps', group });
        continue;
      }
      if (item.type === 'text' || item.type === 'thought') rows.push({ key: item.id, kind: item.type, text: item.text });
      else if (item.type === 'image') rows.push({ key: item.id, kind: 'image', mimeType: item.mimeType, data: item.data });
      else if (item.type === 'plan') rows.push({ key: item.id, kind: 'plan', entries: item.entries });
      else rows.push({ key: item.id, kind: 'content', content: item.content });
    }
    const response = turn.running ? '' : responseMarkdown(turn);
    if (response) rows.push({ key: `${turn.id}:copy`, kind: 'copy', text: response });
    const stopped = stoppedText(turn);
    if (stopped) rows.push({ key: `${turn.id}:stopped`, kind: 'stopped', text: stopped });
    for (const worker of placed.byTurn.get(turn.id) ?? []) rows.push({ key: `worker:${worker.paneId}`, kind: 'worker', worker });
  }
  for (const worker of placed.trailing) rows.push({ key: `worker:${worker.paneId}`, kind: 'worker', worker });
  return rows;
}
