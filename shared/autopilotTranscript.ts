import { boundary, decodeOptionalBoundary, type BoundarySchema } from './validation/boundaryDecoder';

/**
 * What Autopilot writes in its chat, read the same way by the desktop and the phone (review F-9):
 * its fenced blocks (`autopilot-items`, `autopilot-log`, `autopilot-away`) and Pane's own
 * `[Pane · …]` lines to it. Each screen draws these its own way.
 */

/** The fenced-block language Autopilot names items in, one Notify item id per line. */
export const ITEMS_BLOCK = 'autopilot-items';
/** Sentinel's fenced blocks (package 7): its calls as it makes them, and "While you were away". */
export const LOG_BLOCK = 'autopilot-log';
export const AWAY_BLOCK = 'autopilot-away';

/** The ids in an `autopilot-items` block: one per line, in walk order. */
export function parseItemIds(content: string): string[] {
  const ids = content.split('\n').map(line => line.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
  return [...new Set(ids)];
}

/** Each Pane line: its prefix, its notice in the chat ('' hides it), and, for a hidden one, its name while queued. */
const CONTROL_LINES: ReadonlyArray<readonly [string, string, string?]> = [
  ['[Pane · Start]', 'You pressed Start'],
  ['[Pane · Pause]', 'You paused Autopilot'],
  ['[Pane · Go on]', 'You pressed Go on'],
  // D-196: the person saved or cleared their own instructions while Autopilot runs.
  ['[Pane · Instructions]', 'Your instructions updated'],
  ['[Pane · Sentinel on]', 'Sentinel on'],
  ['[Pane · Sentinel off]', 'Sentinel off · welcome back'],
  // The person opened Autopilot while Sentinel stays on (J29).
  ['[Pane · Back]', 'Welcome back'],
  // Pane's wake-ups for Autopilot: an empty notice hides the line.
  ['[Pane · Sentinel check]', '', 'Sentinel check'],
  // D-146: idle while it runs, Autopilot carries on without waiting for the person.
  ['[Pane · Carry on]', '', 'Carry on'],
];

/** Pane's own lines to Autopilot (Start, Pause, Go on, Sentinel, Back) show as a short notice, not a message; '' hides one. */
export function controlLine(text: string): string | undefined {
  const trimmed = text.trimStart();
  return CONTROL_LINES.find(([prefix]) => trimmed.startsWith(prefix))?.[1];
}

/** A Pane line waiting in the chat's queue, named by its notice or, for a hidden one, its name; undefined for the person's own text. */
export function queuedControlLabel(text: string): string | undefined {
  const trimmed = text.trimStart();
  const line = CONTROL_LINES.find(([prefix]) => trimmed.startsWith(prefix));
  if (!line) return undefined;
  return line[1] || line[2];
}

/** One call Sentinel made, as an `autopilot-log` or `autopilot-away` block lists it (one JSON object a line). */
export interface SentinelLogEntry {
  at: string;
  session: string;
  kind: 'answered' | 'nudged' | 'sent';
  what: string;
  why?: string;
}

const logEntrySchema: BoundarySchema<SentinelLogEntry> = boundary.object({
  at: boundary.string,
  session: boundary.string,
  kind: boundary.enumeration('answered', 'nudged', 'sent'),
  what: boundary.string,
  why: boundary.optional(boundary.string),
});

/** When the person was away, and the full away log's file: an `autopilot-away` block's first line. */
export interface SentinelAwaySummary {
  from: string;
  to: string;
  log?: string;
}

const summarySchema = boundary.object({
  summary: boundary.object({ from: boundary.string, to: boundary.string, log: boundary.optional(boundary.string) }),
});

/** One line of a block, decoded with `schema`; undefined when it isn't JSON or doesn't fit. */
function decodeLine<T>(line: string, schema: BoundarySchema<T>): T | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(line), schema);
  } catch {
    return undefined;
  }
}

/** Sentinel's entries in a block; a line that isn't one is skipped, so a half-written block still shows the rest. */
export function parseLogEntries(content: string): SentinelLogEntry[] {
  return content.split('\n').flatMap(line => {
    const entry = decodeLine(line, logEntrySchema);
    return entry ? [entry] : [];
  });
}

export function awaySummary(content: string): SentinelAwaySummary | undefined {
  return decodeLine(content.split('\n')[0] ?? '', summarySchema)?.summary;
}

/** "2 answered · 1 nudged · 0 sent to you", after the time away when the block has one. */
export function awayLine(content: string): string {
  const summary = awaySummary(content);
  const entries = parseLogEntries(content);
  const count = (kind: SentinelLogEntry['kind']) => entries.filter(entry => entry.kind === kind).length;
  return `${summary ? `${summary.from}–${summary.to} · ` : ''}${count('answered')} answered · ${count('nudged')} nudged · ${count('sent')} sent to you`;
}
