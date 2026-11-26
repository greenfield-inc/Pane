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

/**
 * What a line with an id carries for checking it against its record: `sent`, the text before Pane's
 * reply line (what the sender wrote, as the record keeps it), and `claimed`, a `[From …]` it opens with.
 */
interface Routed { ref?: string; sent?: string; claimed?: string }

export type ChatAgentLine =
  /** A message from another agent, Pane's To-dos or Autopilot: a sender card. `ref` when it can be replied to. */
  | ({ type: 'message'; sender: ChatSender; body: string } & Routed)
  /** The person's own words, delivered by Autopilot or To-dos: stays the 'You' bubble, with "You, via …". */
  | ({ type: 'relayed'; via: string; body: string } & Routed)
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
  const routed: Routed = route ? { ref, sent: rest.trim(), claimed: prefix ? prefix[0].trim() : undefined } : {};
  if (from && 'via' in from) return { type: 'relayed', via: from.via, body, ...routed };
  if (from) return { type: 'message', sender: from.sender, body, ...routed };
  // A prefix Pane doesn't write (an agent's own "[From the "Omni Chat" Session orchestrator]") counts only on a message with an id.
  if (route && prefix) return { type: 'message', sender: senderOfName(prefix[1].trim()), body: rest.slice(prefix[0].length).trim(), ...routed };
  if (route) return { type: 'message', sender: senderOfName(route[2]), body, ...routed };
  return undefined;
}

/** A tab's message records, as the chat reads them; `available` false where the app has none (the PWA, the phone). */
export interface ChatMessageRecords {
  available: boolean;
  panelId?: string;
  byRef: ReadonlyMap<string, AgentMessageRecord>;
}

/**
 * The text alone doesn't prove who sent a message: the person can paste an agent's message, reply
 * line and all, or type `[From Autopilot]`. Where the app has the records, a line that names an id
 * counts only when that message reached this tab with this text, and its recorded sender wins over
 * any `[From …]` in the body: only Autopilot relays the person's words. Autopilot's lines always
 * carry an id, so one without is the person's. Pane's own To-dos lines have no record (Pane types
 * them as is) and stay read from their text.
 */
export function checkedChatLine(line: ChatAgentLine | undefined, records: ChatMessageRecords): ChatAgentLine | undefined {
  if (!line || !records.available) return line;
  if (line.type === 'reply') {
    const reply = records.byRef.get(line.ref);
    return reply?.kind === 'reply' && reply.replyTo === line.replyTo && reply.receiver.panelId === records.panelId ? { ...line, sender: senderOfName(reply.sender.name) } : undefined;
  }
  if (!line.ref) return line.type === 'message' && line.sender.system === 'autopilot' ? undefined : line;
  const message = records.byRef.get(line.ref);
  if (message?.kind !== 'message' || message.receiver.panelId !== records.panelId) return undefined;
  // A real reply line pasted under other words is the person's message, not M-n.
  if (sameText(line.sent ?? '') !== sameText(message.text)) return undefined;
  // Autopilot's own Pane is named "Autopilot" (autopilotManager); a sender merely named like it isn't.
  const byAutopilot = senderOfName(message.sender.name).name === 'Autopilot';
  // Pane never gives the person's relayed words an id (AGENT_MESSAGES.md), so a relay that has one is its sender's own text.
  const claimedSender = line.type === 'message' ? line.sender : undefined;
  const recorded = claimedSender?.system === 'autopilot' && byAutopilot ? claimedSender : senderOfName(message.sender.name);
  // An agent's own "[From …]" stays hidden when it names the recorded sender, and stays in the text when it doesn't.
  const truthful = claimedSender !== undefined && claimedSender.name === recorded.name;
  const body = line.claimed && !truthful ? `${line.claimed} ${line.body}` : line.body;
  return { type: 'message', sender: recorded, body, ref: line.ref };
}

/** The text as the record keeps it: line endings and the ends' whitespace aside, every character counts. */
const sameText = (text: string) => text.replace(/\r\n?/gu, '\n').trim();

/** The message a reply thread starts from: M-3 answers M-2, which answers M-1, gives M-1. */
export function threadRoot(ref: string, byRef: ReadonlyMap<string, AgentMessageRecord>): string {
  let current = ref;
  for (let hops = 0; hops < 50; hops += 1) {
    const parent = byRef.get(current)?.replyTo;
    if (!parent) return current;
    current = parent;
  }
  return current;
}

/** Every reply in a thread under its first message, depth first in the order they came (M-2, its reply M-3, …), each once. */
export function threadReplies(replies: readonly AgentMessageRecord[], byRef: ReadonlyMap<string, AgentMessageRecord>): AgentMessageRecord[] {
  const out: AgentMessageRecord[] = [];
  const seen = new Set<string>();
  const visit = (reply: AgentMessageRecord) => {
    if (seen.has(reply.ref)) return;
    seen.add(reply.ref);
    out.push(reply);
    for (const ref of reply.replies) { const child = byRef.get(ref); if (child) visit(child); }
  };
  replies.forEach(visit);
  return out;
}

/** The loaded chat's messages that carry a reply line: the candidates for cards a reply can point up to. */
export function routedTexts(texts: readonly string[]): string[] {
  return texts.filter(text => REPLY_ROUTE.test(text));
}

/** The messages this tab received whose cards the loaded chat really shows: the same check a card passes. */
export function shownRefs(texts: readonly string[], records: ChatMessageRecords): ReadonlySet<string> {
  return new Set(texts.flatMap(text => {
    const line = checkedChatLine(classifyChatLine(text), records);
    return line?.type === 'message' && line.ref ? [line.ref] : [];
  }));
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
 * When each turn started, in one pass. A turn without times (still running, or cut off before its
 * end marker) starts when the last dated turn before it ended; turns before any dated one start at -∞.
 * The result never decreases, so a message's turn is found by binary search.
 */
function turnStarts(turns: readonly TurnSpan[]): number[] {
  const time = (iso: string | undefined) => { const at = iso ? Date.parse(iso) : NaN; return Number.isNaN(at) ? undefined : at; };
  let known = Number.NEGATIVE_INFINITY;
  let previous = Number.NEGATIVE_INFINITY;
  return turns.map(turn => {
    // A dated turn keeps its own start, even when it overlaps the one before; only an undated one inherits.
    const start = Math.max(previous, time(turn.startedAt) ?? known);
    previous = start;
    known = Math.max(known, start, time(turn.endedAt) ?? start);
    return start;
  });
}

/**
 * The messages this tab sent, by the turn its agent sent them in: the latest turn that had started
 * when the message was made. A message older than every turn shown (its turn paged out) is left out.
 */
export function sentMessagesByTurn(turns: readonly TurnSpan[], records: readonly AgentMessageRecord[], panelId: string): ReadonlyMap<string, AgentMessageRecord[]> {
  const sent = records.filter(record => record.kind === 'message' && record.sender.panelId === panelId)
    .sort((a, b) => a.number - b.number);
  const placed = new Map<string, AgentMessageRecord[]>();
  if (sent.length === 0 || turns.length === 0) return placed;
  const starts = turnStarts(turns);
  const firstDated = starts.find(start => start !== Number.NEGATIVE_INFINITY);
  for (const record of sent) {
    const made = Date.parse(record.createdAt);
    if (firstDated !== undefined && made < firstDated) continue;
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= made) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    if (found < 0) continue;
    const turn = turns[found];
    placed.set(turn.id, [...(placed.get(turn.id) ?? []), record]);
  }
  return placed;
}
