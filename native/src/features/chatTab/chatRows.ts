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
  | { key: string; kind: 'time'; short: string; full: string }
  /** A fenced block in a language the screen draws itself (Autopilot's `autopilot-items`). */
  | { key: string; kind: 'block'; language: string; content: string }
  /** A person's message the screen shows as a short notice instead ("You pressed Start"). */
  | { key: string; kind: 'notice'; text: string };

export interface ChatRowOptions {
  open: ReadonlySet<string>;
  workers?: readonly ChatWorkerLine[];
  now?: Date;
  /** Fenced-block languages that become `block` rows instead of code. */
  blocks?: ReadonlySet<string>;
  /** A person's text as a notice, '' to hide it, or undefined to keep it a message. */
  notice?: (text: string) => string | undefined;
}

export type TextSegment = { kind: 'text'; text: string } | { kind: 'block'; language: string; content: string };

const FENCE = /^```([\w-]+)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** Splits a message's text around fenced blocks in `languages`; every other fence stays in the text. */
export function splitFencedBlocks(text: string, languages: ReadonlySet<string>): TextSegment[] {
  if (languages.size === 0) return [{ kind: 'text', text }];
  const segments: TextSegment[] = [];
  let from = 0;
  for (const match of text.matchAll(FENCE)) {
    const language = match[1];
    if (!languages.has(language)) continue;
    const before = text.slice(from, match.index).trim();
    if (before) segments.push({ kind: 'text', text: before });
    segments.push({ kind: 'block', language, content: match[2] });
    from = match.index + match[0].length;
  }
  const rest = text.slice(from).trim();
  if (rest || segments.length === 0) segments.push({ kind: 'text', text: from === 0 ? text : rest });
  return segments;
}

function userText(message: AgentChatMessage): string | undefined {
  return message.parts.length === 1 && message.parts[0].type === 'text' ? message.parts[0].text : undefined;
}

/**
 * The conversation as rows (D-192): the agent's text, with each turn's activity
 * folded into one row that `open` expands. While a turn runs the row says what it's
 * doing now. A Session's workers appear only when the latest turn has news of them
 * (D-201): one line each for a worker that finished, reported or is asking.
 */
export function chatRows(turns: readonly ChatTurn[], options: ChatRowOptions): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const turn of turns) {
    const latest = turn === turns.at(-1);
    // D-202: a long press shows a message's full time.
    if (turn.user) {
      const text = userText(turn.user);
      const notice = text === undefined ? undefined : options.notice?.(text);
      // An empty notice hides the line: Pane's own wake-ups for the agent show nothing.
      if (notice) rows.push({ key: `${turn.id}:notice`, kind: 'notice', text: notice });
      else if (notice === undefined) rows.push({ key: `${turn.id}:user`, kind: 'user', message: turn.user, at: messageTime(turn.startedAt, options.now)?.full });
    }
    const ended = messageTime(turn.endedAt, options.now);
    const { shown, activity, foldAt } = turnDisplay(turn);
    const pushItem = (item: TurnItem) => {
      if (item.type === 'text' && options.blocks?.size) {
        const segments = splitFencedBlocks(item.text, options.blocks);
        segments.forEach((segment, index) => {
          const key = segments.length === 1 ? item.id : `${item.id}:${index}`;
          rows.push(segment.kind === 'text' ? { key, kind: 'text', text: segment.text, at: ended?.full } : { key, kind: 'block', language: segment.language, content: segment.content });
        });
      } else if (item.type === 'text') rows.push({ key: item.id, kind: 'text', text: item.text, at: ended?.full });
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
