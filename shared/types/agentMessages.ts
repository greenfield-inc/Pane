/**
 * Agent-to-agent messages (T-104): every message one agent tab sends another through Pane
 * (`runpane panels submit`, `agents send`, a Session-to-Session message, Autopilot's lines) gets an
 * id, M-n, and a reply route. The receiver answers with `runpane reply M-n "…"`, and Pane types the
 * answer into the sender's tab, wherever that tab is now. docs/AGENT_MESSAGES.md has the shape.
 */

/**
 * `sending`: Pane is typing it. `delivered`: it reached the tab (a reply: typed, or handed to the
 * sender's waiting `--await-reply` call). `answered`: a message someone replied to. `queued`: a reply
 * waiting for its sender's tab to be at its prompt. `undelivered`: it can never arrive; `undeliveredReason` says why.
 */
export const AGENT_MESSAGE_STATES = ['sending', 'queued', 'delivered', 'answered', 'undelivered'] as const;
export type AgentMessageState = (typeof AGENT_MESSAGE_STATES)[number];

/** A message one agent sent another, or a reply to one. */
export const AGENT_MESSAGE_KINDS = ['message', 'reply'] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

/** One end of a message: the tab, its Pane and Session, and the name Pane shows for it. */
export interface AgentMessageParty {
  /** Null for the person (a reply typed outside any tab). */
  panelId: string | null;
  paneId: string | null;
  sessionId: string | null;
  /** "the "Omni Chat" Session orchestrator", a Pane's name, or "the person". */
  name: string;
  /** The tab was its Session's orchestrator: a reply follows the Session to its current orchestrator tab. */
  orchestrator: boolean;
}

/** One message as `runpane messages list|show` and the app read it. Times are ISO 8601. */
export interface AgentMessageRecord {
  /** "M-12". */
  ref: string;
  number: number;
  kind: AgentMessageKind;
  /** The message this one answers ("M-11"); null for a message. */
  replyTo: string | null;
  sender: AgentMessageParty;
  receiver: AgentMessageParty;
  text: string;
  state: AgentMessageState;
  /** How a delivered reply arrived: typed into the tab, or returned to the sender's `--await-reply` call. */
  deliveredVia: 'tab' | 'call' | null;
  undeliveredReason: string | null;
  /** The replies to this message, oldest first ("M-13"). */
  replies: string[];
  createdAt: string;
  deliveredAt: string | null;
  answeredAt: string | null;
}

export interface RunpaneMessageListResult { ok: true; messages: AgentMessageRecord[] }
export interface RunpaneMessageShowResult { ok: true; message: AgentMessageRecord; replies: AgentMessageRecord[] }

/** `runpane reply`: the reply's record, and whether it reached the sender yet. */
export interface RunpaneReplyResult {
  ok: true;
  reply: AgentMessageRecord;
  /** `delivered` (typed, or handed to a waiting call), `queued` (Pane types it at the sender's next prompt), or `undelivered`. */
  delivery: 'delivered' | 'queued' | 'undelivered';
  next?: string;
}

/** `runpane panels submit --await-reply` (and `runpane messages wait`): the reply, or why none came. */
export interface RunpaneMessageWaitResult {
  ok: boolean;
  message: string;
  outcome: 'reply' | 'timeout';
  reply?: AgentMessageRecord;
  next?: string;
}

const MESSAGE_REF_PATTERN = /^\s*[mM]-?([0-9]+)\s*$/u;

export function messageRef(number: number): string {
  return `M-${number}`;
}

/** "M-12", "m12" or "12" as 12; undefined for anything else. */
export function parseMessageRef(value: string): number | undefined {
  const match = MESSAGE_REF_PATTERN.exec(value) ?? /^\s*([0-9]+)\s*$/u.exec(value);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** The app's channel for a tab's messages, and the event that says they changed. */
export const AGENT_MESSAGES_FOR_PANEL_CHANNEL = 'agent-messages:for-panel';
export const AGENT_MESSAGES_CHANGED_EVENT = 'agent-messages:changed';
