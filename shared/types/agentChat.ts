import type { JsonValue } from '../validation/boundaryDecoder';

export type AgentChatPart =
  | { type: 'text' | 'thought'; text: string }
  | { type: 'tool'; id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; input?: JsonValue; output?: JsonValue; content?: JsonValue[] }
  | { type: 'content'; content: JsonValue };

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: AgentChatPart[];
}

export interface AgentChatTranscript {
  panelId: string;
  generation: number;
  revision: number;
  messages: AgentChatMessage[];
}

export interface AgentChatEvent {
  panelId: string;
  generation: number;
  revision: number;
  change:
    | { type: 'append'; id: string; role: AgentChatMessage['role']; part: AgentChatPart }
    | { type: 'replace'; message: AgentChatMessage };
}

export interface AgentChatApplyResult { transcript: AgentChatTranscript; resync: boolean }

/** A gap requires a host snapshot. Replayed events never append text twice. */
export function applyAgentChatEvent(transcript: AgentChatTranscript, event: AgentChatEvent): AgentChatApplyResult {
  if (event.panelId !== transcript.panelId || event.generation < transcript.generation) return { transcript, resync: false };
  if (event.generation > transcript.generation || event.revision > transcript.revision + 1) return { transcript, resync: true };
  if (event.revision <= transcript.revision) return { transcript, resync: false };
  const messages = [...transcript.messages];
  const change = event.change;
  const id = change.type === 'replace' ? change.message.id : change.id;
  const index = messages.findIndex(message => message.id === id);
  if (change.type === 'replace') {
    if (index === -1) messages.push(structuredClone(change.message));
    else messages[index] = structuredClone(change.message);
  } else {
    const message = index === -1 ? { id, role: change.role, parts: [] } : structuredClone(messages[index]);
    const previous = message.parts.at(-1);
    if ((change.part.type === 'text' || change.part.type === 'thought') && previous?.type === change.part.type) previous.text += change.part.text;
    else message.parts.push(structuredClone(change.part));
    if (index === -1) messages.push(message);
    else messages[index] = message;
  }
  return { transcript: { ...transcript, revision: event.revision, messages }, resync: false };
}

export type AgentInterface = 'terminal' | 'chat';
export interface AgentConversationRecord {
  panelId: string;
  workspaceId: string;
  provider: 'claude' | 'codex';
  nativeSessionId: string;
  generation: number;
  active: AgentInterface | 'stopped';
  preferred: AgentInterface;
  recovery?: string;
  /** Only incomplete transfers need disclosure; successful full forks are quiet. */
  transferNotice?: string;
  /** Provider may have copied history before its fork response was lost. */
  forkUnconfirmed?: boolean;
  /** Show the native startup surface while its own attachment is unconfirmed. */
  nativeStartup?: boolean;
  pendingSwitch?: { target: AgentInterface; reason: string };
  transition?: { source: AgentInterface; target: AgentInterface; phase: 'releasing' | 'loading' };
}

export interface AgentChatLaunch {
  command: string;
  cwd: string;
  shellType: string;
  executable: string;
  version: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  additionalDirectories?: string[];
  strictMcpConfig: boolean;
  journalFile: string;
  settingsFile: string;
  codexConfigArgs?: string[];
  codexEndpoint?: string;
  codexSocketPath?: string;
}

export interface AgentChatProcessIdentity { pid: number; parent: number; started: string }

export interface AgentChatPanelState {
  receipts?: AgentChatReceipt[];
  conversation: AgentConversationRecord;
  launch: AgentChatLaunch;
  processes: { terminal: AgentChatProcessIdentity[]; chat: AgentChatProcessIdentity[]; unverifiedSpawn?: AgentInterface };
}

export interface AgentChatPermission {
  id: string;
  generation: number;
  title: string;
  toolCall: JsonValue;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface AgentChatConfigOption { id: string; name: string; currentValue: string; options: Array<{ value: string; name: string }> }

export interface AgentChatView {
  panelId: string;
  conversation?: AgentConversationRecord;
  available: boolean;
  identificationRequired?: boolean;
  identificationSocketRequired?: boolean;
  unavailableReason?: string;
  setupRequired: boolean;
  running: boolean;
  canAttachImages?: boolean;
  controls?: AgentChatConfigOption[];
  permissions: AgentChatPermission[];
  transcript?: AgentChatTranscript;
  configuration?: JsonValue;
  error?: string;
}

export interface AgentChatSend {
  generation: number;
  operationId: string;
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
}

export interface AgentChatReceipt {
  operationId: string;
  generation: number;
  fingerprint: string;
  state: 'accepted' | 'completed' | 'failed';
  error?: string;
}

export interface AgentChatClient {
  onReconnect?(callback: () => void): () => void;
  get(panelId: string): Promise<AgentChatView>;
  setup(): Promise<{ installed: boolean }>;
  identify?(panelId: string, nativeId: string, socketPath: string): Promise<AgentChatView>;
  switch(panelId: string, mode: AgentInterface, generation: number): Promise<AgentConversationRecord>;
  recover(panelId: string, mode: AgentInterface, generation: number): Promise<AgentConversationRecord>;
  send(panelId: string, request: AgentChatSend): Promise<AgentChatReceipt>;
  receipt(panelId: string, operationId: string): Promise<AgentChatReceipt | undefined>;
  configure?(panelId: string, generation: number, configId: string, value: string): Promise<void>;
  cancel(panelId: string, generation: number): Promise<void>;
  permission(panelId: string, generation: number, requestId: string, optionId: string): Promise<void>;
  stop(panelId: string): Promise<void>;
  onEvent(callback: (event: AgentChatEvent) => void): () => void;
  onState(callback: (state: AgentChatView) => void): () => void;
}
