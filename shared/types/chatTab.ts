import type { JsonValue } from '../validation/boundaryDecoder';
import type { AgentChatConfigOption, AgentChatMessage, AgentChatPart, AgentChatPermission, AgentChatReceipt } from './agentChat';
import type { TerminalAgentReport } from './panels';

/**
 * Chat tabs: an agent tab that runs Claude or Codex through its ACP adapter,
 * with no terminal. The host owns the adapter process; desktop, the remote PWA
 * and the phone only relay the conversation (chat-tab:* commands and events).
 */
export type ChatAgent = 'claude' | 'codex';

/** How a chat tab is launched. Saved without env: env is rebuilt at every start. */
export type ChatTabLaunch =
  | { kind: 'agent' }
  | { kind: 'profile'; profile: string; args?: Record<string, string> };

/** Last known runtime state. `stopped` always carries a `problem` or an explicit stop. */
export type ChatTabStatus = 'starting' | 'idle' | 'working' | 'blocked' | 'stopped';

export type ChatTabProblemCode = 'signed-out' | 'not-installed' | 'adapter-setup' | 'exited' | 'failed' | 'unsupported-host';

/** Why a chat tab stopped, and the one action that gets it going again. */
export interface ChatTabProblem {
  code: ChatTabProblemCode;
  message: string;
  next: string;
  /** `sign-in` opens a terminal tab running the agent's own login; `install` opens its install page. */
  action?: 'sign-in' | 'install' | 'restart';
  url?: string;
}

/** Saved in the panel's custom state. Never holds env, tokens or keys. */
export interface ChatPanelState {
  agent: ChatAgent;
  launch: ChatTabLaunch;
  cwd: string;
  /** The ACP session ID; set once the agent creates the conversation, then loaded on every restart. */
  acpSessionId?: string;
  status: ChatTabStatus;
  problem?: ChatTabProblem;
  /** A turn that was running; still set after a crash or quit, so the next start can say it stopped. */
  turn?: { operationId: string; startedAt: string };
  /** Chosen session settings (config option id to value), applied again after a restart. */
  settings?: Record<string, string>;
  receipts?: AgentChatReceipt[];
  /** Prompts sent while the agent was busy, delivered in order after the turn ends. */
  queue?: ChatTabQueuedPrompt[];
  /** First prompt, sent once after the conversation is created. */
  initialInput?: string;
  initialInputSentAt?: string;
  /** Orchestration identity, as on terminal agent tabs. */
  orchestrationSessionId?: string;
  sessionFolder?: string;
  agentReport?: TerminalAgentReport;
}

export interface ChatTabQueuedPrompt { operationId: string; text: string; images?: Array<{ mimeType: string; data: string }>; queuedAt: string }

/** An agent's question (ACP form elicitation), shown as a card on every surface. */
export interface ChatTabQuestion {
  id: string;
  generation: number;
  message: string;
  /** The JSON Schema of the form the agent asked for (`requestedSchema`). */
  schema: JsonValue;
  /** The tool call that asked, when the adapter names one (AskUserQuestion, ExitPlanMode). */
  toolCallId?: string;
}

export interface ChatTabCommand { name: string; description?: string; hint?: string }

/** A window onto the conversation: `start` messages come before `messages[0]` and are paged with chat-tab:history. */
export interface ChatTabTranscript {
  panelId: string;
  generation: number;
  revision: number;
  start: number;
  messages: AgentChatMessage[];
}

export interface ChatTabView {
  panelId: string;
  agent: ChatAgent;
  generation: number;
  status: ChatTabStatus;
  problem?: ChatTabProblem;
  /** One-line notice, such as an interrupted turn. */
  notice?: string;
  canAttachImages: boolean;
  controls: AgentChatConfigOption[];
  commands: ChatTabCommand[];
  permissions: AgentChatPermission[];
  questions: ChatTabQuestion[];
  queue: ChatTabQueuedPrompt[];
  transcript?: ChatTabTranscript;
  /** Total messages in this generation, including those before the window. */
  messageCount: number;
}

export interface ChatTabSend {
  operationId: string;
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
}

export type ChatTabChange =
  | { type: 'append'; id: string; role: AgentChatMessage['role']; part: AgentChatPart }
  | { type: 'replace'; message: AgentChatMessage }
  /** Only the fields of a tool step that changed. */
  | { type: 'tool'; id: string; patch: ChatToolPatch };

/** `terminalAppend` adds live command output to the step's `terminal` text (bounded to its last 64 KiB). */
export type ChatToolPatch = Partial<Omit<Extract<AgentChatPart, { type: 'tool' }>, 'type' | 'id'>> & { terminalAppend?: string };

export const CHAT_TERMINAL_LIMIT = 64 * 1024;

/** Applies a tool patch to a step in place, as host and viewers both do. */
export function patchTool(part: Extract<AgentChatPart, { type: 'tool' }>, patch: ChatToolPatch): void {
  const { terminalAppend, ...fields } = patch;
  Object.assign(part, structuredClone(fields));
  if (terminalAppend) part.terminal = ((part.terminal ?? '') + terminalAppend).slice(-CHAT_TERMINAL_LIMIT);
}

export interface ChatTabEvent {
  panelId: string;
  generation: number;
  revision: number;
  /** Index of the changed message in the whole conversation. */
  index: number;
  change: ChatTabChange;
}

export interface ChatTabCreate {
  sessionId: string;
  /** Required for a plain agent; a profile's harness comes from Agent Farm when left out. */
  agent?: ChatAgent;
  launch?: ChatTabLaunch;
  title?: string;
  initialInput?: string;
  activate?: boolean;
}

export interface ChatTabClient {
  onReconnect?(callback: () => void): () => void;
  get(panelId: string, limit?: number): Promise<ChatTabView>;
  history(panelId: string, before: number, limit: number): Promise<AgentChatMessage[]>;
  send(panelId: string, request: ChatTabSend): Promise<AgentChatReceipt>;
  receipt(panelId: string, operationId: string): Promise<AgentChatReceipt | undefined>;
  unqueue(panelId: string, operationId: string): Promise<void>;
  configure(panelId: string, configId: string, value: string): Promise<void>;
  cancel(panelId: string): Promise<void>;
  permission(panelId: string, requestId: string, optionId: string): Promise<void>;
  answer(panelId: string, questionId: string, response: ChatTabAnswer): Promise<void>;
  restart(panelId: string): Promise<void>;
  signIn(panelId: string): Promise<{ panelId: string }>;
  onEvent(callback: (event: ChatTabEvent) => void): () => void;
  onState(callback: (view: ChatTabView) => void): () => void;
}

export type ChatTabAnswer = { action: 'accept'; content: Record<string, JsonValue> } | { action: 'decline' } | { action: 'cancel' };

export interface ChatTabApplyResult { transcript: ChatTabTranscript; resync: boolean }

/** Which agents have an API key set on a host; never the keys. */
export interface ChatTabKeyStatus { claude: boolean; codex: boolean }

/** Apply one host event to a client's window. A gap or a new generation needs a fresh snapshot. */
export function applyChatTabEvent(transcript: ChatTabTranscript, event: ChatTabEvent): ChatTabApplyResult {
  if (event.panelId !== transcript.panelId || event.generation < transcript.generation) return { transcript, resync: false };
  if (event.generation > transcript.generation || event.revision > transcript.revision + 1) return { transcript, resync: true };
  if (event.revision <= transcript.revision) return { transcript, resync: false };
  const local = event.index - transcript.start;
  const next = { ...transcript, revision: event.revision };
  // Older than this window: the viewer pages it in from history when it scrolls there.
  if (local < 0) return { transcript: next, resync: false };
  if (local > transcript.messages.length) return { transcript, resync: true };
  const messages = [...transcript.messages];
  const change = event.change;
  const existing = messages[local];
  if (change.type === 'replace') messages[local] = structuredClone(change.message);
  else if (change.type === 'append') {
    const message: AgentChatMessage = existing ? structuredClone(existing) : { id: change.id, role: change.role, parts: [] };
    const last = message.parts.at(-1);
    if ((change.part.type === 'text' || change.part.type === 'thought') && last?.type === change.part.type) last.text += change.part.text;
    else message.parts.push(structuredClone(change.part));
    messages[local] = message;
  } else {
    if (!existing) return { transcript, resync: true };
    const message = structuredClone(existing);
    const part = message.parts[0];
    if (part?.type !== 'tool') return { transcript, resync: true };
    patchTool(part, change.patch);
    messages[local] = message;
  }
  return { transcript: { ...next, messages }, resync: false };
}
