import type { AgentMessageRecord } from './types/agentMessages';

/**
 * How a chat draws a message Pane or another agent typed into a tab (T-105, D-1): as a card with
 * its sender, not as the person's own 'You' bubble. The text is all a chat history keeps, so the
 * sender comes from the lines Pane adds (docs/AGENT_MESSAGES.md, main/src/services/todos/todoMessages.ts):
 * the `[From …]` prefix, the `Reply with runpane reply M-n` line, and the `reply: M-n → "…"` line.
 * The message's record (`agentMessages.forPanel`) adds its state and reply when the app has it.
 */

/** Who sent a message, as a card's header shows it. */
export interface ChatSender {
  /** "Omni Chat", "T-104 worker", "Pane", "Autopilot". */
  name: string;
  /** What it is: "Session orchestrator", "To-dos", "via To-dos T-4", "agent"; empty when the name says it. */
  kind: string;
  /** Pane's own senders draw an icon instead of initials. */
  system?: 'todos' | 'autopilot';
}

export type ChatAgentLine =
  /** A message from another agent, Pane's To-dos or Autopilot: a sender card. `ref` when it can be replied to. */
  | { type: 'message'; sender: ChatSender; body: string; ref?: string }
  /** The person's own words, delivered by Autopilot or To-dos: stays the 'You' bubble, with "You, via …". */
  | { type: 'relayed'; via: string; body: string; ref?: string }
  /** A reply to a message this tab sent (`reply: M-12 → "…"`). */
  | { type: 'reply'; replyTo: string; ref: string; body: string; sender: ChatSender };

const REPLY_ROUTE = /\n*Reply with runpane reply (M-[0-9]+) "…": it reaches ([^\n]+), who never sees your own chat\.\s*$/u;
const REPLY_LINE = /^reply: (M-[0-9]+) → "([\s\S]*)" \(from ([^\n]+?)\) \[(M-[0-9]+); answer it with runpane reply M-[0-9]+ "…"\]\s*$/u;
const FROM_PREFIX = /^\[From ([^\]\n]+)\][ \t]*\n?/u;
const SESSION_ORCHESTRATOR = /^the "(.+)" Session orchestrator$/u;
const PANE_IN_SESSION = /^(.+) \(in the "(.+)" Session\)$/u;
const VIA_TODOS = /^(.+), via (To-dos T-[0-9]+)$/u;
const ASKED_BY_ORCHESTRATOR = /^(To-dos T-[0-9]+), asked by its orchestrator$/u;

/** The name Pane gives a tab (agentMessageHost: `the "Omni Chat" Session orchestrator`, `Worker (in the "Omni Chat" Session)`, a Pane's name) as a sender. */
export function senderOfName(name: string): ChatSender {
  const orchestrator = SESSION_ORCHESTRATOR.exec(name);
  if (orchestrator) return { name: orchestrator[1], kind: 'Session orchestrator' };
  const inSession = PANE_IN_SESSION.exec(name);
  if (inSession) return { name: inSession[1], kind: `in ${inSession[2]}` };
  if (name === 'the person') return { name: 'You', kind: '' };
  return { name, kind: 'agent' };
}

/** The `[From …]` prefix's sender, or the person's words relayed; undefined for a prefix Pane doesn't write. */
function fromPrefix(inner: string): { sender: ChatSender } | { via: string } | undefined {
  if (inner === 'Pane, To-dos') return { sender: { name: 'Pane', kind: 'To-dos', system: 'todos' } };
  if (inner === 'Autopilot') return { sender: { name: 'Autopilot', kind: '', system: 'autopilot' } };
  const asked = ASKED_BY_ORCHESTRATOR.exec(inner);
  if (asked) return { sender: { name: asked[1], kind: 'asked by its orchestrator', system: 'todos' } };
  const via = VIA_TODOS.exec(inner) ?? /^(.+), via (Autopilot)$/u.exec(inner);
  if (via) return via[1] === 'the person' ? { via: via[2] } : { sender: { ...senderOfName(via[1]), kind: `via ${via[2]}` } };
  return undefined;
}

/**
 * Reads a message typed into a tab. Undefined for the person's own message (and anything Pane can't
 * tell apart from one), which keeps the 'You' bubble.
 */
export function classifyChatLine(text: string): ChatAgentLine | undefined {
  const reply = REPLY_LINE.exec(text);
  if (reply) return { type: 'reply', replyTo: reply[1], body: reply[2], sender: senderOfName(reply[3]), ref: reply[4] };
  const route = REPLY_ROUTE.exec(text);
  const rest = route ? text.slice(0, route.index) : text;
  const ref = route?.[1];
  const prefix = FROM_PREFIX.exec(rest);
  const from = prefix ? fromPrefix(prefix[1].trim()) : undefined;
  const body = (from && prefix ? rest.slice(prefix[0].length) : rest).trim();
  if (from && 'via' in from) return { type: 'relayed', via: from.via, body, ref };
  if (from) return { type: 'message', sender: from.sender, body, ref };
  // A prefix Pane doesn't write ("[From a brain-dump …]") counts only on a message with an id.
  if (route && prefix) return { type: 'message', sender: senderOfName(prefix[1].trim()), body, ref };
  if (route) return { type: 'message', sender: senderOfName(route[2]), body, ref };
  return undefined;
}

/** Up to two letters for an avatar: "Omni Chat" → "OC", "T-104 worker" → "TW", "Billing" → "BI". */
export function senderInitials(name: string): string {
  const words = name.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word));
  const letters = words.length > 1 ? words.slice(0, 2).map(word => [...word][0]) : [...(words[0] ?? '·')].slice(0, 2);
  return letters.join('').toUpperCase();
}

/** A message's state as its card's pill says it. */
export type MessageStatus =
  | { state: 'waiting' }
  | { state: 'answered'; replies: AgentMessageRecord[] }
  | { state: 'sending' }
  | { state: 'undelivered'; reason: string };

/** Undefined for a reply nobody answered: a reply waits for nothing. */
export function messageStatus(record: AgentMessageRecord, byRef: ReadonlyMap<string, AgentMessageRecord>): MessageStatus | undefined {
  const replies = record.replies.flatMap(ref => byRef.get(ref) ?? []);
  if (record.state === 'answered' || replies.length > 0) return { state: 'answered', replies };
  if (record.kind === 'reply' && record.state !== 'undelivered') return undefined;
  if (record.state === 'sending') return { state: 'sending' };
  if (record.state === 'undelivered') return { state: 'undelivered', reason: record.undeliveredReason ?? 'it could not be delivered' };
  return { state: 'waiting' };
}

/** The window of time a turn covers, for placing the messages its agent sent. */
interface TurnSpan { id: string; startedAt?: string; endedAt?: string }

/**
 * The messages this tab sent, by the turn its agent sent them in: the latest turn that had started
 * when the message was made (a running turn starts when the one before it ended). A message older
 * than every turn shown (its turn paged out) is left out.
 */
export function sentMessagesByTurn(turns: readonly TurnSpan[], records: readonly AgentMessageRecord[], panelId: string): ReadonlyMap<string, AgentMessageRecord[]> {
  const sent = records.filter(record => record.kind === 'message' && record.sender.panelId === panelId)
    .sort((a, b) => a.number - b.number);
  const placed = new Map<string, AgentMessageRecord[]>();
  const firstStart = turns.find(turn => turn.startedAt)?.startedAt;
  for (const record of sent) {
    const made = Date.parse(record.createdAt);
    if (firstStart && made < Date.parse(firstStart)) continue;
    let turn: TurnSpan | undefined;
    for (const [index, candidate] of turns.entries()) {
      const start = candidate.startedAt ?? turns[index - 1]?.endedAt;
      if (start === undefined || Date.parse(start) <= made) turn = candidate;
    }
    if (!turn) continue;
    placed.set(turn.id, [...(placed.get(turn.id) ?? []), record]);
  }
  return placed;
}
