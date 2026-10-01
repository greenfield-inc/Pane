import { useCallback, useEffect, useState } from 'react';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject, type JsonValue } from '../src/boundaryDecoder';
import { callTool, type ToolResult } from './bridge';

const agentSchema = boundary.object({
  paneId: boundary.string,
  panelId: boundary.string,
  name: boundary.string,
  status: boundary.enumeration('working', 'ready', 'blocked', 'idle', 'exited', 'unknown', 'gone'),
  screen: boundary.array(boundary.string),
  link: boundary.string,
  repo: boundary.optional(boundary.string),
  diff: boundary.optional(boundary.object({ adds: boundary.number, dels: boundary.number })),
  pr: boundary.optional(boundary.object({
    number: boundary.number,
    draft: boundary.boolean,
    title: boundary.optional(boundary.string),
    state: boundary.optional(boundary.string),
    url: boundary.optional(boundary.string),
  })),
});
export type Agent = ReturnType<typeof agentSchema.decode>;
export type Status = Agent['status'];

const panelDataSchema = boundary.object({
  chat: boundary.string,
  agents: boundary.array(agentSchema),
  focus: boundary.optional(boundary.string),
  error: boundary.optional(boundary.string),
});
export type PanelData = ReturnType<typeof panelDataSchema.decode>;

const cardDataSchema = boundary.object({ agent: agentSchema, error: boundary.optional(boundary.string) });
export type CardData = ReturnType<typeof cardDataSchema.decode>;

/** agents_start, agents_status, and agents_send results all name the agent's Pane and panel. */
const agentRefSchema = boundary.object({ paneId: boundary.string, panelId: boundary.optional(boundary.string) });
type AgentRef = ReturnType<typeof agentRefSchema.decode>;

const sendOutputSchema = boundary.object({ delivered: boundary.optional(boundary.boolean) });

/** What one tool result asks the view to show. */
export type View =
  | { kind: 'panel'; data: PanelData }
  | { kind: 'card'; data: CardData }
  | { kind: 'cardRef'; ref: AgentRef; failed?: string };

function decodeOr<T>(value: JsonValue | undefined, schema: BoundarySchema<T>): T | undefined {
  try {
    return decodeBoundary(value, schema);
  } catch {
    return undefined;
  }
}

export function viewOf(result: ToolResult): View | undefined {
  const data = result.structuredContent;
  const panel = decodeOr(data, panelDataSchema);
  if (panel) return { kind: 'panel', data: panel };
  const card = decodeOr(data, cardDataSchema);
  if (card) return { kind: 'card', data: card };
  const ref = decodeOr(data, agentRefSchema) ?? decodeOr(errorJson(result), agentRefSchema);
  if (ref) return { kind: 'cardRef', ref, failed: result.isError ? textOf(result) : undefined };
  return undefined;
}

export function textOf(result: ToolResult): string {
  return result.content?.find((block) => block.type === 'text')?.text ?? '';
}

/** A failed agents_start still prints the CLI's JSON as its error text. */
function errorJson(result: ToolResult): JsonValue | undefined {
  try {
    return decodeBoundary(JSON.parse(textOf(result)), boundary.json);
  } catch {
    return undefined;
  }
}

/** Pane's status vocabulary (frontend agentStatusVisual): what each status says and whether it moves. */
export const STATUS_WORD = {
  working: 'working',
  blocked: 'needs you',
  ready: 'ready',
  idle: 'idle',
  exited: 'exited',
  unknown: 'shell',
  gone: 'archived',
} satisfies Record<Status, string>;

const LIVE_STATUSES: ReadonlySet<Status> = new Set(['working', 'blocked', 'unknown']);
export const isLive = (status: Status) => LIVE_STATUSES.has(status);

/** agents_send says `delivered: false` when Pane can't verify the agent took the message. */
export function sendFailure(result: ToolResult): string {
  const text = textOf(result);
  try {
    if (decodeBoundary(JSON.parse(text), sendOutputSchema).delivered === false) {
      return 'Pane could not confirm delivery. Check the agent in Pane.';
    }
  } catch {
    // Not JSON: Pane refused the message and said why.
  }
  return text || 'Send failed.';
}

/** Refreshes a value on an interval while the frame is visible and `active` holds. */
export function usePoll(active: boolean, intervalMs: number, poll: () => Promise<void>): void {
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll().catch(() => undefined);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, poll]);
}

/** The agent behind an inline card, kept live while it works or waits on the user. */
export function useCard(view: Extract<View, { kind: 'card' | 'cardRef' }>) {
  const [data, setData] = useState<CardData | undefined>(view.kind === 'card' ? view.data : undefined);
  const [failed, setFailed] = useState<string | undefined>(view.kind === 'cardRef' ? view.failed : undefined);
  const ref = view.kind === 'card' ? { paneId: view.data.agent.paneId, panelId: view.data.agent.panelId } : view.ref;
  const refresh = useCallback(async () => {
    const args: JsonObject = { paneId: ref.paneId };
    if (ref.panelId) args.panelId = ref.panelId;
    const result = await callTool('agents_card', args);
    const next = decodeOr(result.structuredContent, cardDataSchema);
    if (next) setData(next);
    else setFailed(textOf(result) || 'Pane did not answer.');
  }, [ref.paneId, ref.panelId]);
  useEffect(() => {
    if (view.kind === 'cardRef') void refresh().catch((error: Error) => setFailed(error.message));
  }, [view.kind, refresh]);
  // Live for ten minutes, so old cards in a long chat stop polling.
  const [startedAt] = useState(() => Date.now());
  usePoll(data !== undefined && isLive(data.agent.status) && Date.now() - startedAt < 600_000, 5_000, refresh);
  return { data, failed, refresh };
}
